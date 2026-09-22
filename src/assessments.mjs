// The assessment workflow: run one separate-phase skill over one frozen packet, keep the run as a
// durable record outside the universe, decide on a proposal, and record arc completions. The packet
// itself lives in `./assessment-packet.mjs`.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { config } from './config.mjs';
import { nowIso, readJson, writeJson } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { skillsDir } from './paths.mjs';
import { annotationsFile, corpusFile, profileFile, resolveAssessmentInputs } from './assessment-inputs.mjs';
import { acceptedChapters } from './universe-chapters.mjs';
import { genericProfile } from './generic-profile.mjs';
import { ANNOTATION_MODES, generateAnnotations, loadAnnotationExamples } from './annotation-stage.mjs';
import {
  PHASES,
  inputFingerprint,
  acceptedVersion,
  assessmentsRoot,
  capturePacket,
  currentVersion,
  runDir,
  runFile,
  sha256,
  universeWorkspace,
  versionSlug
} from './assessment-packet.mjs';

const RUN_SCHEMA = 'assessment-run.v1';
const EVENT_SCHEMA = 'arc-event.v1';
// One event file per arc and accepted version: the name is what makes a repeated declaration the same event.
const arcEventFile = (universeId, arcId, version) => join(universeWorkspace(universeId), 'arc-events', `arc-${arcId}-${versionSlug(version)}.json`);
const MAX_APPROVAL_DIRECTIONS = 8;
const MAX_APPROVAL_DIRECTION_CHARS = 400;
/** The phase command of one skill: arguments only, no model, no working directory that matters. */
function phaseCommand(phase, { inputDir, resultDir, paths, annotationsPath = null, trigger = 'requested', arcId = null }) {
  const annotations = annotationsPath
    ? ['--annotations', annotationsPath]
    : paths.annotations ? ['--annotations', join(inputDir, paths.annotations)] : [];
  if (phase === 'continuity') {
    return {
      script: join(skillsDir, 'scripta-continuity-review', 'scripts', 'review-continuity.mjs'),
      args: ['--input', inputDir, '--out', resultDir, ...annotations]
    };
  }
  if (phase === 'metrics') {
    if (!paths.profile) throw new UniverseError('NO_PROFILE', 'The metrics phase needs a profile.', 400);
    const corpus = paths.corpus ? ['--corpus', join(inputDir, paths.corpus)] : [];
    // The report names the event that caused it: the host says `requested|arc`, the bundle says
    // `request|arc`, and this is the one place the mapping happens.
    const triggerArgs = trigger === 'arc' && arcId
      ? ['--trigger', 'arc', '--arc-id', arcId]
      : ['--trigger', 'request'];
    return {
      script: join(skillsDir, 'scripta-metrics-report', 'scripts', 'build-report.mjs'),
      args: ['--input', inputDir, '--out', resultDir, '--profile', join(inputDir, paths.profile), ...annotations, ...corpus, ...triggerArgs]
    };
  }
  throw new UniverseError('BAD_PHASE', `Unknown assessment phase (${PHASES.join('|')}).`, 400);
}

/**
 * A frozen version's directory inside a universe's workspace. Anything else that lives there — the arc
 * events, the feedback targets and entries of the team's readers — is not a run and is never walked as
 * one, so a `run.json` written by some other feature can never be mistaken for a review.
 */
const isVersionDir = (name) => /^sha256-[0-9a-f]{8,}$/.test(name);

async function readRun(universeId, runId) {
  for (const versionDir of await readdir(universeWorkspace(universeId)).catch(() => [])) {
    if (!isVersionDir(versionDir)) continue;
    for (const name of await readdir(join(universeWorkspace(universeId), versionDir)).catch(() => [])) {
      const record = await readJson(join(universeWorkspace(universeId), versionDir, name, 'run.json'), null);
      if (record?.run_id === runId) return { record, versionDir };
    }
  }
  return null;
}

/** Every run of a universe, newest first, with its freshness against the current accepted version. */
/** The hash of a continuity result supplied inside an annotations bundle, or `null`. */
function annotationsContinuitySha256(annotations) {
  if (!annotations || typeof annotations !== 'object') return null;
  const continuity = annotations.continuity ?? annotations.continuity_result ?? null;
  return continuity ? sha256(JSON.stringify(continuity)) : null;
}

export async function listAssessments(universeId) {
  const runs = [];
  for (const versionDir of await readdir(universeWorkspace(universeId)).catch(() => [])) {
    if (!isVersionDir(versionDir)) continue;
    for (const name of await readdir(join(universeWorkspace(universeId), versionDir)).catch(() => [])) {
      const record = await readJson(join(universeWorkspace(universeId), versionDir, name, 'run.json'), null);
      if (record) runs.push(record);
    }
  }
  const current = await currentVersion(universeId);
  return runs
    .map((record) => ({ ...record, historical: current !== null && record.version !== current }))
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) || String(b.run_id).localeCompare(String(a.run_id)));
}

const running = new Map();
const pending = new Map();
// Creations are serialized per universe: the duplicate scan and the record write must not interleave,
// or two simultaneous requests would each find nothing and each write a run.
const creationChains = new Map();

function serializeCreation(universeId, work) {
  const previous = creationChains.get(universeId) ?? Promise.resolve();
  const next = previous.then(work, work);
  creationChains.set(universeId, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * Run a phase in the background and remember the task, so `settleAssessments` cannot miss a run that
 * has been started but has not reached its first await yet.
 */
function launch(universeId, record) {
  const task = executeAssessment(universeId, record)
    .catch(async (error) => {
      // A phase runner never throws at its caller: whatever happens, the run records it.
      record.status = 'error';
      record.error = `the assessment runner failed: ${error?.message ?? error}`;
      record.finished_at = nowIso();
      await writeJson(runFile(universeId, record.version, record.run_id), record).catch(() => {});
      return record;
    })
    .finally(() => pending.delete(record.run_id));
  pending.set(record.run_id, task);
  return task;
}

/** Start one review of one frozen version. The universe is never written by a phase. */
export async function startAssessment({
  universeId,
  phase = 'metrics',
  profile = null,
  annotations = null,
  corpus = null,
  fromTurn = null,
  trigger = 'requested',
  arcId = null,
  force = false,
  scope = null,
  chapters = null,
  aggregate = false,
  intention = null,
  weights = null,
  mode = null,
  request = null,
  brief = null,
  annotationModel = config.model
}) {
  if (!PHASES.includes(phase)) {
    throw new UniverseError('BAD_PHASE', `Unknown assessment phase (${PHASES.join('|')}).`, 400);
  }
  // A metrics review without a profile is the ordinary case: the host uses its own generic profile, so a
  // reader never has to author JSON. A caller who brings a profile keeps it untouched.
  const profileSource = profile ? 'supplied' : (phase === 'metrics' ? 'generic' : 'none');
  if (phase === 'metrics' && !profile) {
    // The generic scope has to be decided before the packet exists (the profile is a packet file), so it
    // is derived from the accepted chapters: a contiguous book is a whole-book review, and a book with
    // gaps is reviewed chapter by chapter instead of pretending to cover chapters it does not have.
    const accepted = (await acceptedChapters(universeId)).map((chapter) => chapter.number).sort((a, b) => a - b);
    const contiguous = accepted.length > 0 && accepted.every((number, index) => number === index + 1);
    profile = genericProfile({
      scope,
      chapters,
      aggregate,
      intention,
      weights,
      packetScope: contiguous
        ? { kind: 'complete', chapters: accepted }
        : { kind: 'partial', chapters: accepted, omitted: [] }
    });
  }
  // The vocabulary of the host is `requested|arc`; the report bundle says `request|arc`. The mapping is
  // explicit here and in `docs/contracts.md` §8.5 so a reader of either side knows the other word.
  const requestedTrigger = trigger ?? 'requested';
  if (!['requested', 'arc'].includes(requestedTrigger)) {
    throw new UniverseError('BAD_TRIGGER', 'A run is `requested` or `arc`.', 400);
  }
  // Who writes the semantic observations: the caller (`supplied`), the model in this workspace
  // (`generic`, the default), or nobody (`deterministic`, which leaves those results unavailable and
  // says so). Supplied annotations always win, because the caller brought evidence.
  const annotationMode = annotations ? 'supplied' : (mode ?? config.assessmentMode);
  if (annotations && mode && mode !== 'supplied') {
    throw new UniverseError('BAD_MODE', 'Supplied annotations and a generated mode are mutually exclusive.', 400);
  }
  if (!ANNOTATION_MODES.includes(annotationMode)) {
    throw new UniverseError('BAD_MODE', `A review mode is ${ANNOTATION_MODES.join('|')}.`, 400);
  }
  if (annotationMode === 'deterministic' && phase === 'continuity') {
    // Continuity has no model stage: it reviews the frozen state and whatever the caller supplies.
    // `deterministic` is therefore the only honest description of its default.
    // (Kept explicit so a caller who asks for the impossible hears about it.)
    if (mode && mode !== 'deterministic' && mode !== 'supplied') {
      throw new UniverseError('BAD_MODE', 'The continuity phase takes supplied annotations or none; it has no model stage.', 400);
    }
  }
  const declared = resolveAssessmentInputs(phase, {
    profile,
    annotations: annotationMode === 'supplied' ? annotations : null,
    corpus
  });
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${phase}-${randomBytes(2).toString('hex')}`;
  const captured = await capturePacket(universeId, {
    runId,
    fromTurn,
    extraFiles: declared.files
  });
  const profilePath = declared.paths.profile ? join(captured.dir, 'input', declared.paths.profile) : null;
  // The scope this run was asked for: the profile declares it, and the packet's coverage is recorded beside
  // it. It is part of the identity, because the same profile on another scope is another review.
  const requestedScope = profile && typeof profile === 'object' && profile.scope && typeof profile.scope === 'object'
    ? { kind: profile.scope.kind ?? null, chapters: Array.isArray(profile.scope.chapters) ? profile.scope.chapters : [], omitted: [] }
    : { kind: captured.manifest.scope.kind, chapters: captured.manifest.scope.chapters, omitted: captured.manifest.scope.omitted };
  const record = {
    schema_version: RUN_SCHEMA,
    run_id: runId,
    universe_id: universeId,
    phase,
    trigger: requestedTrigger,
    arc_id: arcId ?? null,
    version: captured.manifest.version,
    scope: captured.manifest.scope,
    requested_scope: requestedScope,
    profile_source: profileSource,
    annotation_mode: annotationMode,
    annotation_prompt_version: null,
    annotation_model: annotationMode === 'generic' ? annotationModel : null,
    annotation_attempts: null,
    annotation_errors: null,
    generated_annotations: null,
    packet_intact: true,
    request_text: request ? String(request).slice(0, 2000) : null,
    intention_text: intention ? String(intention).slice(0, 1000) : null,
    brief_text: brief ? String(brief).slice(0, 2000) : null,
    profile_sha256: profilePath ? sha256(await readFile(profilePath)) : null,
    annotations: annotations ? true : false,
    // What the review actually consumed, with hashes: the declared inputs are part of the packet, so
    // provenance can name them exactly.
    inputs: captured.manifest.files
      .filter((file) => !['chapter', 'offer', 'canon', 'threads', 'atlas'].includes(file.role))
      .map((file) => ({ path: file.path, role: file.role, artifact_id: file.artifact_id, sha256: file.sha256, bytes: file.bytes })),
    // Resources the packet carries beside its inventory (the texts a declared corpus compares against),
    // with their hashes: the manifest of the input declares the same hashes, and the review recomputes them.
    resources: captured.resources.map((resource) => ({ path: resource.path, role: resource.role, sha256: resource.sha256, bytes: resource.bytes })),
    annotations_sha256: declared.paths.annotations
      ? captured.manifest.files.find((file) => file.path === annotationsFile)?.sha256 ?? null
      : null,
    corpus_manifest_sha256: declared.paths.corpus ? captured.manifest.files.find((file) => file.path === corpusFile)?.sha256 ?? null : null,
    input_dir: relative(assessmentsRoot(), captured.inputDir),
    result_dir: relative(assessmentsRoot(), join(captured.dir, 'result')),
    status: 'queued',
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    exit_code: null,
    error: null,
    outputs: [],
    historical: false
  };
  const fingerprint = inputFingerprint({
    phase,
    version: record.version,
    scope: requestedScope,
    trigger: requestedTrigger,
    arcId: record.arc_id,
    profileSha256: record.profile_sha256,
    annotationsSha256: record.annotations_sha256,
    corpusManifestSha256: record.corpus_manifest_sha256,
    resources: record.resources,
    continuitySha256: annotationsContinuitySha256(annotations),
    mode: 'deterministic'
  });
  record.input_fingerprint = fingerprint;
  return serializeCreation(universeId, async () => {
    if (!force) {
      // Only a record that carries the same fingerprint is a duplicate: one written before fingerprints
      // existed cannot prove that it reviewed the same evidence.
      const duplicate = (await listAssessments(universeId)).find((run) => run.input_fingerprint
        && run.input_fingerprint === fingerprint
        && ['done', 'running', 'queued'].includes(run.status));
      if (duplicate) {
        await rm(captured.dir, { recursive: true, force: true });
        return { ...duplicate, deduplicated: true };
      }
    }
    await writeJson(runFile(universeId, record.version, runId), record);
    launch(universeId, record);
    return record;
  });
}

/** Run the phase as a child process, record the outcome, and never touch the store. */
/** Whether this run already holds the observations it was asked for, so a retry does not pay twice. */
async function hasGeneratedAnnotations(directory, record) {
  if (!record.generated_annotations) return false;
  const path = join(directory, record.generated_annotations);
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return false;
  const bytes = await readFile(path, 'utf8').catch(() => null);
  if (bytes === null) return false;
  record.annotations_sha256 = sha256(bytes);
  return true;
}

/**
 * The annotation stage of one queued run: read the frozen packet, ask the configured evaluator for a
 * document, validate it against the packet, and keep it beside the run. The record is updated in place so
 * that the attempt history survives a restart, and the phase that follows reads the accepted document from
 * outside the packet — the evidence the review was asked about is never touched.
 */
async function generateAnnotationsForRun(universeId, record) {
  const dir = runDir(universeId, record.version, record.run_id);
  const inputDir = join(dir, 'input');
  const manifest = await readJson(join(inputDir, 'manifest.json'), null);
  if (!manifest) return { ok: false, reason: 'the frozen packet of this run is gone' };
  const files = [];
  for (const file of manifest.files) {
    const text = await readFile(join(inputDir, file.path), 'utf8').catch(() => null);
    if (text !== null) files.push({ path: file.path, role: file.role, sha256: file.sha256, bytes: file.bytes, text });
  }
  const examples = await loadAnnotationExamples(skillsDir).catch(() => []);
  const generated = await generateAnnotations({
    skillsDir,
    runDir: dir,
    inputDir,
    manifest,
    files,
    scope: record.scope ?? { kind: 'book' },
    book: manifest.book,
    request: record.request_text,
    intention: record.intention_text,
    brief: record.brief_text,
    examples,
    timeoutMs: config.assessmentTimeoutMs,
    model: record.annotation_model ?? config.model
  });
  record.annotation_attempts = generated.attempts;
  record.annotation_errors = (generated.validation?.errors ?? []).slice(0, 12);
  record.annotation_prompt_version = generated.prompt_version;
  record.packet_intact = generated.packet_intact;
  if (!generated.ok) {
    return {
      ok: false,
      reason: (generated.validation?.errors ?? []).slice(0, 3).join('; ') || 'the annotation stage produced no usable document'
    };
  }
  record.generated_annotations = generated.relativePath;
  record.annotations_sha256 = generated.sha256;
  record.annotation_model = generated.model ?? record.annotation_model;
  await writeJson(runFile(universeId, record.version, record.run_id), record);
  return { ok: true, generated };
}

export async function executeAssessment(universeId, record) {
  const directory = runDir(universeId, record.version, record.run_id);
  const inputDir = join(directory, 'input');
  const resultDir = join(directory, 'result');
  record.status = 'running';
  record.started_at = nowIso();
  await writeJson(runFile(universeId, record.version, record.run_id), record);
  await mkdir(resultDir, { recursive: true });

  // Who produces the semantic observations is decided at request time, but the work happens here: a review
  // whose observations come from the configured evaluator spends one or two model calls, and a caller must
  // not be made to hold an HTTP request open for that. The run exists from the start, so the interface
  // shows it as running while the evaluator reads, and a retry that already holds an accepted document
  // reuses it instead of paying for another reading.
  if (record.annotation_mode === 'generic' && !(await hasGeneratedAnnotations(directory, record))) {
    const staged = await generateAnnotationsForRun(universeId, record);
    if (!staged.ok) {
      record.status = 'error';
      record.error = `annotation stage: ${staged.reason}`;
      record.finished_at = nowIso();
      await writeJson(runFile(universeId, record.version, record.run_id), record);
      return record;
    }
  }
  // The phase is only told about the document once it exists: generated observations live beside the run,
  // never inside the frozen packet, and the packet stays exactly the input the review was asked about.
  const command = phaseCommand(record.phase, {
    inputDir,
    resultDir,
    paths: {
      profile: record.profile_sha256 ? profileFile : null,
      annotations: record.annotations ? annotationsFile : null,
      corpus: record.corpus_manifest_sha256 ? corpusFile : null
    },
    annotationsPath: record.generated_annotations ? join(directory, record.generated_annotations) : null,
    trigger: record.trigger,
    arcId: record.arc_id
  });
  const outcome = await new Promise((resolve) => {
    const child = spawn(process.execPath, [command.script, ...command.args], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_NO_TITLE: '1' }
    });
    running.set(record.run_id, child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, config.assessmentTimeoutMs);
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error.message) }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  running.delete(record.run_id);
  record.exit_code = outcome.code;
  record.finished_at = nowIso();
  let envelope = null;
  try {
    envelope = JSON.parse(outcome.stdout.trim().split('\n').pop());
  } catch {
    envelope = null;
  }
  if (envelope) record.envelope = envelope;
  const published = await readdir(resultDir).catch(() => []);
  record.outputs = published.sort();
  if (outcome.code === 0) {
    record.status = 'done';
    record.error = null;
  } else if (record.status === 'cancelled') {
    record.status = 'cancelled';
  } else {
    record.status = 'error';
    const reason = (envelope?.errors ?? []).map((entry) => `${entry.code ?? 'ERROR'}: ${entry.message ?? ''}`).join('; ');
    record.error = reason || outcome.stderr.trim().split('\n').pop() || `the phase exited with code ${outcome.code}`;
  }
  record.log = { stdout: outcome.stdout.slice(-20_000), stderr: outcome.stderr.slice(-8_000) };
  await writeJson(runFile(universeId, record.version, record.run_id), record);
  return record;
}

/**
 * The absolute path of one file a run published. Only the names that run lists can be read, and only as
 * plain file names, so a request cannot name a path into the result directory or outside it. The route
 * that serves reports uses this rather than building a path of its own.
 */
export async function runOutputPath(universeId, runId, name) {
  const wanted = String(name ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(wanted) || wanted.includes('..')) {
    throw new UniverseError('BAD_FILE', 'A report file is a plain file name, not a path.', 400);
  }
  const run = await readAssessment(universeId, runId);
  if (!Array.isArray(run.outputs) || !run.outputs.includes(wanted)) {
    throw new UniverseError('NOT_FOUND', `This run published no file named ${JSON.stringify(wanted)}.`, 404);
  }
  return join(assessmentsRoot(), run.result_dir, wanted);
}

export async function readAssessment(universeId, runId) {
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  const current = await currentVersion(universeId);
  return { ...found.record, historical: current !== null && found.record.version !== current };
}

export async function cancelAssessment(universeId, runId) {
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  if (!['queued', 'running'].includes(found.record.status)) {
    throw new UniverseError('NOT_CANCELLABLE', `Assessment ${runId} is ${found.record.status}.`, 409);
  }
  const child = running.get(runId);
  found.record.status = 'cancelled';
  found.record.finished_at = nowIso();
  if (child) {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }
  await writeJson(runFile(universeId, found.record.version, runId), found.record);
  return found.record;
}

/** Re-run a finished assessment with the same identity: the same frozen packet, a fresh attempt. */
export async function retryAssessment(universeId, runId) {
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  if (['queued', 'running'].includes(found.record.status)) {
    throw new UniverseError('NOT_RETRYABLE', `Assessment ${runId} is still ${found.record.status}.`, 409);
  }
  const inputDir = join(universeWorkspace(universeId), versionSlug(found.record.version), runId, 'input');
  const manifest = await readJson(join(inputDir, 'manifest.json'), null);
  if (!manifest) {
    throw new UniverseError('NO_PACKET', `Assessment ${runId} lost its frozen packet; start a new assessment instead.`, 409);
  }
  found.record.status = 'queued';
  found.record.attempts = (found.record.attempts ?? 1) + 1;
  found.record.error = null;
  found.record.started_at = null;
  found.record.finished_at = null;
  found.record.exit_code = null;
  await rm(join(universeWorkspace(universeId), versionSlug(found.record.version), runId, 'result'), { recursive: true, force: true });
  await writeJson(runFile(universeId, found.record.version, runId), found.record);
  launch(universeId, found.record);
  return found.record;
}

/**
 * Record that an arc is complete in a specific accepted version, and offer the assessment that the
 * event implies. A planned `completed` flag in a design proposal is not an event; this is.
 */
export async function declareArcCompletion({ universeId, arcId, note = null, phase = 'metrics', profile = null, aggregate = false, intention = null, mode = null }) {
  const cleanId = String(arcId ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(cleanId)) {
    throw new UniverseError('BAD_ARC', 'An arc identifier is lowercase letters, digits and hyphens.', 400);
  }
  const version = await currentVersion(universeId);
  if (version === null) {
    throw new UniverseError('UNSTABLE_VERSION', 'This book is being written right now; an arc cannot be declared complete against a moving version.', 409);
  }
  const event = {
    schema_version: EVENT_SCHEMA,
    arc_id: cleanId,
    universe_id: universeId,
    version,
    declared_at: nowIso(),
    note: note ? String(note).slice(0, 400) : null
  };
  await mkdir(join(universeWorkspace(universeId), 'arc-events'), { recursive: true });
  await writeFile(arcEventFile(universeId, cleanId, version), JSON.stringify(event, null, 2), 'utf8');
  // The event is the durable fact, and it schedules the generic report by default: a team does not have
  // to hand-author a profile for an arc review. A supplied profile is used as it is.
  const run = await startAssessment({
    universeId,
    phase,
    profile: profile ?? null,
    trigger: 'arc',
    arcId: cleanId,
    aggregate: aggregate === true,
    intention: intention ?? null,
    mode
  });
  return { event, run };
}

export async function listArcEvents(universeId) {
  const dir = join(universeWorkspace(universeId), 'arc-events');
  const events = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const event = await readJson(join(dir, name), null);
    if (event) events.push(event);
  }
  return events.sort((a, b) => String(b.declared_at).localeCompare(String(a.declared_at)));
}

/**
 * After a restart: a run that was `running` becomes `interrupted` (retryable with the same identity),
 * and a run that was still `queued` starts again, so a queued assessment survives the process.
 */
export async function recoverAssessments() {
  const recovered = { interrupted: [], resumed: [] };
  for (const universe of await readdir(assessmentsRoot()).catch(() => [])) {
    const directory = join(assessmentsRoot(), universe);
    if (!(await stat(directory).then((info) => info.isDirectory(), () => false))) continue;
    const runs = await listAssessments(universe).catch(() => []);
    for (const record of runs) {
      if (record.status === 'running') {
        record.status = 'interrupted';
        record.finished_at = nowIso();
        record.error = 'interrupted by a server restart; retry reuses the same frozen packet';
        await writeJson(runFile(universe, record.version, record.run_id), record);
        recovered.interrupted.push(record.run_id);
        continue;
      }
      if (record.status === 'queued') {
        launch(universe, record);
        recovered.resumed.push(record.run_id);
      }
    }
  }
  return recovered;
}

/** Wait for every assessment this process started; used by the check suite. */
export async function settleAssessments(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while ((running.size > 0 || pending.size > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return running.size === 0 && pending.size === 0;
}

/**
 * Record the human decision on a design or craft proposal: the only bridge between a phase and a later
 * writing request (§8.4). The record lives outside the universe, names the accepted version it was
 * written against, and cannot be replaced once it exists for the same proposal and version — an
 * approval that could be quietly rewritten would not be an approval.
 */
export async function recordApproval({ universeId, proposal, decision, reviewer = null, directions = [], version = null }) {
  if (!['approved', 'declined'].includes(decision)) {
    throw new UniverseError('BAD_DECISION', 'An approval is `approved` or `declined`.', 400);
  }
  const body = typeof proposal === 'string' ? null : proposal;
  const path = typeof proposal === 'string' ? String(proposal).trim() : null;
  if (!body && !path) {
    throw new UniverseError('BAD_PROPOSAL', 'An approval names the proposal file it decides on, or carries the proposal itself.', 400);
  }
  const acceptedVersion = version ?? await currentVersion(universeId);
  if (acceptedVersion === null) {
    throw new UniverseError('UNSTABLE_VERSION', 'This book is being written right now; an approval needs a stable accepted version.', 409);
  }
  const current = await currentVersion(universeId);
  if (current !== null && current !== acceptedVersion) {
    throw new UniverseError(
      'STALE_REQUEST',
      `The proposal was written against ${String(acceptedVersion).slice(0, 24)}… but the accepted version is ${String(current).slice(0, 24)}…; read it again before deciding.`,
      409
    );
  }
  const cleanDirections = [];
  for (const entry of Array.isArray(directions) ? directions : []) {
    const text = String(entry ?? '').trim();
    if (!text || text.length > MAX_APPROVAL_DIRECTION_CHARS) {
      throw new UniverseError('BAD_DIRECTIONS', `Every accepted direction is a non-empty instruction of at most ${MAX_APPROVAL_DIRECTION_CHARS} characters.`, 400);
    }
    cleanDirections.push(text);
    if (cleanDirections.length > MAX_APPROVAL_DIRECTIONS) {
      throw new UniverseError('BAD_DIRECTIONS', `At most ${MAX_APPROVAL_DIRECTIONS} directions are accepted at once.`, 400);
    }
  }
  if (decision === 'declined' && cleanDirections.length > 0) {
    throw new UniverseError('BAD_DECISION', 'A declined proposal carries no accepted directions.', 400);
  }
  const serialized = body ? JSON.stringify(body, null, 2) : null;
  const proposalSha = body ? sha256(serialized) : sha256(await readFile(path).catch(() => Buffer.from('')));
  const slug = proposalSha.slice(0, 16);
  const directory = join(universeWorkspace(universeId), versionSlug(acceptedVersion), 'approvals');
  await mkdir(directory, { recursive: true });
  const target = join(directory, `approval-${slug}.json`);
  if (await stat(target).then(() => true, () => false)) {
    throw new UniverseError('ALREADY_DECIDED', `Proposal ${slug} already has a decision for this version; an approval is not rewritten.`, 409);
  }
  const record = {
    schema_version: 'approval.v1',
    universe_id: universeId,
    version: acceptedVersion,
    proposal_sha256: proposalSha,
    proposal_path: path,
    proposal: body ? true : false,
    decision,
    reviewer: reviewer ? String(reviewer).slice(0, 120) : null,
    directions: cleanDirections,
    decided_at: nowIso()
  };
  const staging = `${target}.staging-${randomBytes(4).toString('hex')}`;
  await writeFile(staging, JSON.stringify(record, null, 2), 'utf8');
  await rename(staging, target);
  if (serialized) {
    // The proposal itself is kept beside the decision so the approval stays auditable after the
    // workspace of the phase that produced it is gone.
    await writeFile(join(directory, `proposal-${slug}.json`), serialized, 'utf8');
  }
  return { ...record, path: relative(assessmentsRoot(), target) };
}

export async function listApprovals(universeId) {
  const approvals = [];
  for (const versionDir of await readdir(universeWorkspace(universeId)).catch(() => [])) {
    if (versionDir === 'arc-events') continue;
    for (const name of await readdir(join(universeWorkspace(universeId), versionDir, 'approvals')).catch(() => [])) {
      if (!name.startsWith('approval-')) continue;
      const record = await readJson(join(universeWorkspace(universeId), versionDir, 'approvals', name), null);
      if (record) approvals.push(record);
    }
  }
  return approvals.sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)));
}

