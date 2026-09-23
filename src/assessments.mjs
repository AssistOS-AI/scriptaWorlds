// The assessment workflow: run one separate-phase skill over one frozen packet, keep the run as a
// durable record outside the universe, decide on a proposal, and record arc completions. The packet
// itself lives in `./assessment-packet.mjs`.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, lstat, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { config } from './config.mjs';
import { nowIso, readJson, writeJson } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { skillsDir } from './paths.mjs';
import { annotationsFile, corpusFile, profileFile, resolveAssessmentInputs } from './assessment-inputs.mjs';
import { acceptedChapters } from './universe-chapters.mjs';
import { genericProfile } from './generic-profile.mjs';
import { ANNOTATION_MODES, TEACHING_CASES_LIMIT, generateAnnotations, loadAnnotationExamples, loadRubricAnchors, verifyStoredAnnotations } from './annotation-stage.mjs';
import { promptIdentity } from './annotation-prompt.mjs';
import {
  CHARTER_FILE,
  RULES_FILE,
  buildApplicableRules,
  buildRegistryDocument,
  collectAuthoringContext,
  loadPublishedRuleSet,
  registryRequirements
} from './review-context.mjs';
import { runContinuitySubstage, scopeContinuityToSelection } from './continuity-substage.mjs';
import { evaluatorJournalPath, readJournal } from './turn-console.mjs';
import { listFeedback } from './feedback-entries.mjs';
import { truncate } from './io.mjs';
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
// A run identifier as this module writes it. A directory that looks like a review of this universe is one:
// anything else at that level is a write that escaped the run it belonged to.
const RUN_ID_PATTERN = /^\d{8}T\d{6}-(continuity|metrics)-[0-9a-f]{4}$/;
// The features that own their own directories inside a universe's workspace. A review writes inside its own
// run directory; everything named here belongs to another feature and is none of the review's business.
const WORKSPACE_FEATURES = ['arc-events', 'feedback'];
const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
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
/** The continuity result a caller supplied inside an annotations bundle, or `null`. */
function suppliedContinuity(annotations) {
  if (!annotations || typeof annotations !== 'object') return null;
  const continuity = annotations.continuity ?? annotations.continuity_result ?? null;
  return continuity && typeof continuity === 'object' && !Array.isArray(continuity) ? continuity : null;
}

/**
 * Bind a supplied continuity result to the packet it claims to describe. The report skill reads the
 * population from `scope.chapters_reviewed`, then `scope.chapters`, then a top-level `chapters`, so the host
 * reads the same fields and refuses a result whose declared source identity is not this packet's accepted
 * version, or whose population names text this packet does not contain or does not cover the selection the
 * review was asked about. A result bound to another version is historical evidence, not a current input.
 */
function bindContinuitySource({ continuity, version, selectedChapters, packetChapters }) {
  const hasSource = typeof continuity.source_version === 'string' && continuity.source_version.length > 0;
  const hasVersion = typeof continuity.version === 'string' && continuity.version.length > 0;
  if (hasSource && hasVersion && continuity.source_version !== continuity.version) {
    throw new UniverseError(
      'BAD_CONTINUITY_SOURCE',
      `The supplied continuity result names two versions (${continuity.source_version} and ${continuity.version}); a result cannot describe two sources.`,
      400
    );
  }
  const declared = hasSource ? continuity.source_version : hasVersion ? continuity.version : null;
  if (declared === null) {
    throw new UniverseError(
      'BAD_CONTINUITY_SOURCE',
      'The supplied continuity result declares no source version, so it cannot be bound to the captured version; supply `source_version`.',
      400
    );
  }
  if (declared !== version) {
    throw new UniverseError(
      'BAD_CONTINUITY_SOURCE',
      `The supplied continuity result was written against ${declared} but this packet is ${version}; a result about another version is historical, not current.`,
      400
    );
  }
  const scope = continuity.scope && typeof continuity.scope === 'object' ? continuity.scope : {};
  const chapters = (value) => (Array.isArray(value) ? value.filter(Number.isInteger) : null);
  const population = chapters(scope.chapters_reviewed) ?? chapters(scope.chapters) ?? chapters(continuity.chapters) ?? null;
  const omitted = chapters(scope.omitted) ?? chapters(continuity.omitted) ?? [];
  const present = new Set(packetChapters);
  const unknown = [...(population ?? []), ...omitted].filter((number) => !present.has(number));
  if (unknown.length > 0) {
    throw new UniverseError(
      'BAD_CONTINUITY_SCOPE',
      `The supplied continuity result names chapters ${unknown.join(', ')}, which the captured version does not contain.`,
      400
    );
  }
  const uncovered = population ? selectedChapters.filter((number) => !population.includes(number)) : [];
  if (uncovered.length > 0) {
    throw new UniverseError(
      'BAD_CONTINUITY_SCOPE',
      `The supplied continuity result covers chapters ${population.join(', ') || 'none'} and says nothing about ${uncovered.join(', ')}, which this review selects.`,
      400
    );
  }
  return {
    declared_field: hasSource ? 'source_version' : 'version',
    source_version: version,
    population: population ?? [...packetChapters],
    omitted,
    scope_declared: population !== null,
    sha256: sha256(JSON.stringify(continuity))
  };
}

/** The identity of a bound continuity result, as an input fingerprint sees it. */
const continuityIdentity = (bound) => (bound ? sha256(JSON.stringify(bound)) : null);

/**
 * The declared corpus references of one run, as its packet will carry them. The manifest is captured
 * verbatim, so a reference's declared source identity travels to the report with it; this reads the same
 * declaration back for the run record and enforces the shape at the boundary — an identity is exactly
 * `{ id, version }`, both non-empty, because half of an identity cannot be verified and must not be guessed
 * from bytes. Byte identity is never turned into source identity here: two references with the same bytes and
 * no declaration stay independent, which is the case overlap measurement exists to find.
 */
function declaredCorpusReferences(corpus) {
  if (!corpus || typeof corpus !== 'object') return null;
  const manifest = corpus.manifest ?? null;
  if (manifest === null) return null;
  const references = Array.isArray(manifest) ? manifest : manifest.references;
  if (!Array.isArray(references)) return null;
  return references.map((reference) => {
    const id = typeof reference?.id === 'string' && reference.id.length > 0 ? reference.id : null;
    const path = typeof reference?.path === 'string' ? reference.path : null;
    const source = reference?.source ?? null;
    if (source !== null) {
      const shape = source && typeof source === 'object' && !Array.isArray(source) ? Object.keys(source).sort().join(',') : null;
      const usable = shape === 'id,version'
        && typeof source.id === 'string' && source.id.length > 0
        && typeof source.version === 'string' && source.version.length > 0;
      if (!usable) {
        throw new UniverseError(
          'INVALID_CORPUS',
          `The corpus reference ${JSON.stringify(id ?? path)} declares a source that is not exactly \`{ id, version }\` with both values non-empty; a declared identity needs the source and its version before it can be verified.`,
          400
        );
      }
    }
    return {
      id,
      path,
      sha256: typeof reference?.sha256 === 'string' ? reference.sha256 : null,
      source: source === null ? null : { id: source.id, version: source.version }
    };
  });
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

/**
 * The lifecycle of one executing run: the record the executor holds, the child it currently owns (the
 * annotation stage or the phase), and whether a cancellation was asked. Cancellation, retry and shutdown
 * all act on this one object, so a late success can never overwrite a cancellation written elsewhere and
 * a cancelled child can never be retried while it still lives.
 */
const controllers = new Map();

function controllerFor(universeId, record) {
  let controller = controllers.get(record.run_id);
  if (!controller) {
    controller = { universeId, record, child: null, cancelled: false };
    controllers.set(record.run_id, controller);
  }
  controller.record = record;
  return controller;
}

const releaseController = (runId) => {
  controllers.delete(runId);
};

/** Stop every live review child: what server shutdown does before it releases ownership of the workspace. */
export function stopAssessmentChildren() {
  for (const controller of controllers.values()) {
    controller.cancelled = true;
    if (controller.child) {
      controller.child.kill('SIGTERM');
      setTimeout(() => controller.child.kill('SIGKILL'), 5_000).unref();
    }
  }
}
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
      // A phase runner never throws at its caller: whatever happens, the run records it, and the run's
      // lifecycle controller is released with it — a controller left behind would keep every later
      // `settleAssessments` waiting for a child that no longer exists.
      record.status = 'error';
      record.error = `the assessment runner failed: ${error?.message ?? error}`;
      record.finished_at = nowIso();
      releaseController(record.run_id);
      await writeJson(runFile(universeId, record.version, record.run_id), record).catch(() => {});
      return record;
    })
    .finally(async () => {
      pending.delete(record.run_id);
      // A settled run keeps no live call: the field describes what is executing, and once the runner has
      // returned nothing is — whatever the outcome was.
      if (record.in_flight) {
        record.in_flight = null;
        await writeJson(runFile(universeId, record.version, record.run_id), record).catch(() => {});
      }
    });
  pending.set(record.run_id, task);
  return task;
}

/** Start one review of one frozen version. The universe is never written by a phase. */
/**
 * The scope one run was asked for, resolved against the frozen packet: the request's selection wins over the
 * profile's, and the packet's own coverage is the fallback. Every chapter named — selected or context — must
 * exist in the captured version, so a request can never silently attach a review to text that version does
 * not have; `fromTurn` is honoured because the packet is the authority this reads.
 */
function resolveRequestedScope({ scope, chapters, profile, captured }) {
  const requestSelection = scope && typeof scope === 'object'
    ? { ...scope, chapters: Array.isArray(chapters) && chapters.length > 0 ? chapters : scope.chapters }
    : (Array.isArray(chapters) && chapters.length > 0 ? { chapters } : null);
  const declared = requestSelection
    ?? (profile && typeof profile === 'object' && profile.scope && typeof profile.scope === 'object' ? profile.scope : null)
    ?? null;
  const capturedChapters = (captured.manifest.files ?? [])
    .filter((file) => file.role === 'chapter' && Number.isInteger(file.chapter))
    .map((file) => file.chapter)
    .sort((a, b) => a - b);
  const whole = () => ({ kind: 'book', chapters: [...capturedChapters], segments: [], arcs: [], context_chapters: [], omitted: [] });
  if (!declared) return whole();
  const numbers = (value) => (Array.isArray(value) ? value.filter(Number.isInteger) : []);
  const selected = numbers(declared.chapters);
  const context = numbers(declared.context_chapters).filter((number) => !selected.includes(number));
  const present = new Set(capturedChapters);
  const unknown = [...selected, ...context].filter((number) => !present.has(number));
  if (unknown.length > 0) {
    throw new UniverseError(
      'BAD_SCOPE',
      `Chapters ${unknown.join(', ')} are not part of the captured version; a review cannot be about text that version does not have.`,
      400
    );
  }
  const resolvedSelected = selected.length === 0 ? [...capturedChapters] : selected;
  return {
    kind: typeof declared.kind === 'string' ? declared.kind : (resolvedSelected.length === capturedChapters.length ? 'book' : 'chapter'),
    chapters: resolvedSelected,
    segments: Array.isArray(declared.segments) ? declared.segments.filter((entry) => typeof entry === 'string') : [],
    arcs: Array.isArray(declared.arcs) ? declared.arcs.filter((entry) => typeof entry === 'string') : [],
    context_chapters: context,
    omitted: capturedChapters.filter((number) => !resolvedSelected.includes(number) && !context.includes(number))
  };
}

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
  // The declared corpus identity is checked before anything is captured: a manifest whose references declare
  // a source that cannot be verified must not leave a frozen packet behind for a run that never happens.
  const corpusReferences = declaredCorpusReferences(corpus);
  // The authoring context and the applicable rules are captured with the packet: the charter of the
  // universe, the request the selected chapters were written from, an approved brief and the accepted
  // directions, plus the general rule set the report skill publishes. A document that does not exist is
  // recorded as absent with its reason — an imported book has no authoring request, and that is not a
  // requirement the book could fail — while the rules themselves are the host's to declare.
  const contextVersion = await currentVersion(universeId);
  if (contextVersion === null) {
    throw new UniverseError(
      'UNSTABLE_VERSION',
      'This book is being written right now; a packet captured now would not be an accepted version. Wait for the turn, or capture from a finished turn\'s snapshot.',
      409
    );
  }
  const published = await loadPublishedRuleSet(skillsDir);
  const approvals = await listApprovals(universeId).catch(() => []);
  const acceptedNumbers = (await acceptedChapters(universeId)).map((chapter) => chapter.number).sort((a, b) => a - b);
  const namedChapters = (Array.isArray(chapters) && chapters.length > 0
    ? chapters
    : Array.isArray(scope?.chapters) && scope.chapters.length > 0 ? scope.chapters : acceptedNumbers)
    .filter(Number.isInteger);
  const authoringContext = await collectAuthoringContext({
    universeId,
    version: contextVersion,
    chapters: namedChapters,
    request,
    brief,
    intention,
    approvals
  });
  const appliedRules = buildApplicableRules({ published, context: authoringContext });
  const registryDocument = buildRegistryDocument({ published, context: authoringContext, rules: appliedRules });
  const registryContent = `${JSON.stringify(registryDocument, null, 2)}\n`;
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${phase}-${randomBytes(2).toString('hex')}`;
  const captured = await capturePacket(universeId, {
    runId,
    fromTurn,
    extraFiles: [
      ...declared.files,
      // The registry is a declared input of the packet: role `rules`, one artifact of that role.
      { path: RULES_FILE, role: 'rules', artifact_id: 'rules', content: registryContent },
      // The charter travels beside the manifest as the resource of that role, the way a corpus reference
      // text travels with its manifest: it is what the rules were derived from, and the evaluator reads it.
      ...(authoringContext.charter.present ? [{ path: CHARTER_FILE, role: 'rules', content: authoringContext.charter.text, declared: false }] : [])
    ]
  });
  if (captured.manifest.version !== contextVersion) {
    throw new UniverseError(
      'UNSTABLE_VERSION',
      'The accepted version changed while the packet was being captured; ask again from the version you meant to review.',
      409
    );
  }
  // The identity of the standard, not of the moment it was written: `captured_at` describes when this file
  // was written and changes on every request, so it is excluded and two requests that measure a book against
  // the same charter, brief and directions keep the same identity.
  const contextSha256 = sha256(JSON.stringify({ ...registryDocument, captured_at: null }));
  const profilePath = declared.paths.profile ? join(captured.dir, 'input', declared.paths.profile) : null;
  // The scope this run was asked for: the request's selection, else the profile's, else the packet's own
  // coverage. It carries the selected chapters, the explicitly permitted context, the segments and arcs a
  // design declared, and what is omitted — and every chapter in it is verified against the captured
  // version rather than against whatever the live store looks like today.
  const requestedScope = resolveRequestedScope({ scope, chapters, profile, captured });
  // A supplied continuity result is bound to this packet before anything is recorded about it: the version
  // it names must be the captured one and its population must be chapters this version holds and this review
  // covers, so a stale or foreign result can never pass as a current input.
  const supplied = suppliedContinuity(annotations);
  const boundContinuity = supplied
    ? bindContinuitySource({
        continuity: supplied,
        version: captured.manifest.version,
        selectedChapters: requestedScope.chapters,
        packetChapters: (captured.manifest.files ?? []).filter((file) => file.role === 'chapter').map((file) => file.chapter).sort((a, b) => a - b)
      })
    : null;
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
    // What the evaluator saw and produced: the prompt version, the resources it was built from, the exact
    // prompt with its hash, the launched evaluator's identity and the bytes of the document it answered with.
    annotation_prompt_sha256: null,
    annotation_resources: null,
    annotation_provenance: null,
    annotation_evaluator_id: null,
    packet_intact: true,
    // The result the review published, with the revision a reader's reaction binds to.
    result_revision: null,
    result_files: null,
    published_at: null,
    // A re-evaluation of an earlier run, and the run it re-evaluates: the two are never the same record, so a
    // published report is never replaced under the reader who read it.
    reassesses_run_id: null,
    evaluation_attempt: 1,
    reused_annotations: false,
    // The continuity result a run was given, as it was bound to this packet.
    continuity_source: boundContinuity,
    // What the continuity substage of this run did, once it has run: it is a separate deterministic child
    // over the same packet and the same selection, and its result travels to the metrics phase beside the
    // observations. A substage that fails is recorded here and never fails the review.
    continuity_substage: null,
    // The package file of the continuity result, when this review supplied itself with one.
    continuity_annotations: null,
    // The bounded reading of this review: the units its plan declared, the state of each one, and the limits
    // it was planned under. They are written before the evaluator runs and again as each unit completes.
    annotation_plan: null,
    annotation_units: null,
    annotation_reading: null,
    // What a declared corpus said about itself: the source identity of every reference, as declared, and the
    // candidate identity it is compared against (the packet's own universe and accepted version). Identity is
    // a declaration here; bytes only ever say that two texts are the same text.
    corpus_references: corpusReferences,
    corpus_candidate_identity: corpus === null || corpus === undefined
      ? null
      : { id: captured.manifest.universe_id ?? universeId, version: captured.manifest.version },
    request_text: authoringContext.request.text ? String(authoringContext.request.text).slice(0, 2000) : null,
    intention_text: authoringContext.intention.text ? String(authoringContext.intention.text).slice(0, 1000) : null,
    brief_text: authoringContext.brief.text ? String(authoringContext.brief.text).slice(0, 2000) : null,
    // The authoring context the packet carries and the rules the host declared from it, with the hash of the
    // document that states both, so a reader can see the standard this review measured against.
    context_file: RULES_FILE,
    context_sha256: contextSha256,
    authoring_context: { ...registryDocument.authoring, missing: registryDocument.missing },
    applied_rules: appliedRules.map((rule) => rule.id),
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
    continuitySha256: continuityIdentity(boundContinuity),
    // Who produces the observations and what they are shown is part of what the review is: a deterministic
    // run and a model run over the same text are two different reviews, as is the same request worded
    // differently or bound to a different intention.
    mode: annotationMode,
    evaluator: annotationMode === 'generic' ? annotationModel : null,
    prompt: await promptIdentity(skillsDir),
    request: record.request_text,
    brief: record.brief_text,
    intention: record.intention_text,
    // The standard the review measures against is part of what the review is: two runs whose charter, brief
    // or accepted directions differ, and whose applicable rules therefore differ, are not the same review.
    rules: record.context_sha256
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
/**
 * Whether this run already holds the observations it was asked for, so a re-render or a retry does not pay
 * twice. The stored document is verified against the hash and the source it was accepted with: it must be
 * the exact bytes that were published, and it must still validate against the frozen packet. A stored
 * document that changed is refused — never silently re-used and never quietly regenerated.
 */
async function reuseGeneratedAnnotations(universeId, record) {
  if (!record.generated_annotations) return { reusable: false, reason: 'none stored' };
  const dir = runDir(universeId, record.version, record.run_id);
  const verdict = await verifyStoredAnnotations({
    skillsDir,
    directory: dir,
    inputDir: join(dir, 'input'),
    record
  });
  if (!verdict.ok) return { reusable: false, reason: verdict.reason, refused: true };
  record.annotations_sha256 = verdict.sha256;
  return { reusable: true };
}

/**
 * The annotation stage of one queued run: read the frozen packet, ask the configured evaluator for a
 * document, validate it against the packet, and keep it beside the run. The record is updated in place so
 * that the attempt history survives a restart, and the phase that follows reads the accepted document from
 * outside the packet — the evidence the review was asked about is never touched.
 */
async function generateAnnotationsForRun(universeId, record, controller = null, continuity = null) {
  const dir = runDir(universeId, record.version, record.run_id);
  const inputDir = join(dir, 'input');
  const manifest = await readJson(join(inputDir, 'manifest.json'), null);
  if (!manifest) return { ok: false, reason: 'the frozen packet of this run is gone' };
  const files = [];
  for (const file of manifest.files) {
    const text = await readFile(join(inputDir, file.path), 'utf8').catch(() => null);
    if (text !== null) files.push({ path: file.path, role: file.role, sha256: file.sha256, bytes: file.bytes, text });
  }
  // The material the evaluator is given is the report skill's own: the anchored rubric, the indicator
  // definitions and a bounded selection of real cases in the book's language. A missing file or a selection
  // that cannot be produced fails the run by name instead of quietly sending a thinner prompt.
  const anchors = await loadRubricAnchors(skillsDir);
  const examples = await loadAnnotationExamples(skillsDir, {
    language: manifest.book?.language ?? 'en',
    limit: TEACHING_CASES_LIMIT
  });
  // The registry of applicable rules travels with the packet, because it is part of what the review is:
  // a run whose charter, brief or accepted directions differ is a different review.
  const registry = await readFile(join(inputDir, RULES_FILE), 'utf8').then((raw) => JSON.parse(raw), () => null);
  // What the evaluator is doing right now, written beside the run while it happens. A real call needs
  // minutes, and a record that only named the attempts after they ended left the console of a running
  // review with nothing to show — indistinguishable, to a reader, from a run that had stopped.
  let inflight = null;
  const persistInflight = () => {
    record.in_flight = inflight ? { ...inflight } : null;
    return writeJson(runFile(universeId, record.version, record.run_id), record).catch(() => {});
  };
  const generated = await generateAnnotations({
    skillsDir,
    runDir: dir,
    inputDir,
    manifest,
    files,
    scope: record.requested_scope ?? record.scope ?? { kind: 'book' },
    book: manifest.book,
    request: record.request_text,
    intention: record.intention_text,
    brief: record.brief_text,
    context: record.authoring_context ?? null,
    registry,
    continuity,
    anchors,
    examples,
    packetResources: record.resources ?? [],
    timeoutMs: config.assessmentTimeoutMs,
    model: record.annotation_model ?? config.model,
    onChild: controller
      ? (child) => {
        controller.child = child;
        // The process that answers is named while it answers, so a reader of the console sees the call and
        // the child that carries it, not only the fact that something was asked.
        if (inflight && child?.pid) {
          inflight.pid = child.pid;
          persistInflight();
        }
      }
      : null,
    onAttemptStart: controller ? (entry) => { inflight = entry; persistInflight(); } : null
  });
  // The attempt records accumulate across evaluations: a retry or a re-evaluation appends its own calls
  // instead of erasing the history of the ones before it.
  record.annotation_attempts = [...(record.annotation_attempts ?? []), ...generated.attempts];
  record.annotation_errors = (generated.validation?.errors ?? []).slice(0, 12);
  record.annotation_prompt_version = generated.prompt_version;
  record.annotation_prompt_sha256 = generated.prompt?.sha256 ?? null;
  record.annotation_resources = generated.provenance?.resources ?? null;
  record.annotation_provenance = generated.provenance ?? null;
  record.annotation_evaluator_id = generated.provenance?.evaluator_id ?? null;
  record.packet_intact = generated.packet_intact;
  // The reading itself, per unit, survives the stage even when it fails: a retry resumes the units that
  // were already read, and a reader of the run can see which parts of the book were attempted.
  record.annotation_plan = generated.plan ?? record.annotation_plan ?? null;
  record.annotation_units = generated.units ?? record.annotation_units ?? null;
  record.annotation_reading = generated.reading ?? record.annotation_reading ?? null;
  if (!generated.ok) {
    const reasons = [
      ...(generated.validation?.errors ?? []).slice(0, 3),
      ...(generated.integrity_errors ?? []).slice(0, 3)
    ];
    return {
      ok: false,
      reason: reasons.join('; ') || 'the annotation stage produced no usable document'
    };
  }
  record.generated_annotations = generated.relativePath;
  record.annotations_sha256 = generated.sha256;
  record.annotation_model = generated.model ?? record.annotation_model;
  await writeJson(runFile(universeId, record.version, record.run_id), record);
  return { ok: true, generated };
}

/**
 * The continuity substage of one metrics run: the continuity skill reviews the same frozen packet and the
 * same selection in a separate deterministic child, and its published result is scoped to what this run was
 * asked about. It is data for the metrics phase, not a gate on it: a substage that cannot run is recorded
 * with its reason, and the literary report still publishes what it measured.
 */
async function prepareContinuity(universeId, record, controller = null) {
  if (record.phase !== 'metrics') return null;
  // A caller that brought its own continuity result has already been bound at request time; the substage
  // would review the same packet to answer a question that was already answered.
  if (record.continuity_source) return null;
  const directory = runDir(universeId, record.version, record.run_id);
  const inputDir = join(directory, 'input');
  const substage = await runContinuitySubstage({
    directory,
    inputDir,
    version: record.version,
    timeoutMs: config.assessmentTimeoutMs,
    // The substage child is owned by the same lifecycle controller as every other child of this run, so a
    // cancellation stops it and shutdown waits for it like the annotation and phase children.
    controller: controller ? (child) => { controller.child = child; } : null
  });
  if (!substage.ok) {
    record.continuity_substage = { ok: false, reason: substage.reason, exit_code: substage.exit_code ?? null };
    return null;
  }
  const manifest = await readJson(join(inputDir, 'manifest.json'), null);
  const packetChapters = (manifest?.files ?? [])
    .filter((file) => file.role === 'chapter' && Number.isInteger(file.chapter))
    .map((file) => file.chapter)
    .sort((a, b) => a - b);
  const selection = (record.requested_scope?.chapters ?? []).filter(Number.isInteger);
  const scoped = scopeContinuityToSelection({
    result: substage.result,
    selection: selection.length > 0 ? selection : packetChapters,
    packetChapters,
    sourceVersion: record.version,
    sourceSha256: substage.sha256,
    sourcePath: relative(assessmentsRoot(), substage.path)
  });
  const document = `${JSON.stringify(scoped, null, 2)}\n`;
  const documentPath = 'generated/continuity.json';
  // The run's `generated/` directory belongs to the host, not to the evaluator: it is created here so the
  // substage of a deterministic review — which never reaches the annotation stage — still has a place for
  // its result.
  await mkdir(join(directory, 'generated'), { recursive: true });
  await writeFile(join(directory, documentPath), document, 'utf8');
  record.continuity_substage = {
    ok: true,
    reused: substage.reused === true,
    result: relative(assessmentsRoot(), substage.path),
    sha256: substage.sha256,
    document: documentPath,
    document_sha256: sha256(document),
    population: scoped.scope.chapters_reviewed,
    counts: scoped.counts,
    evaluated_from: scoped.evaluated_from
  };
  record.continuity_source = {
    declared_field: 'source_version',
    source_version: record.version,
    population: scoped.scope.chapters_reviewed,
    omitted: scoped.scope.omitted,
    scope_declared: true,
    source: 'substage',
    sha256: sha256(JSON.stringify(scoped))
  };
  return scoped;
}

export async function executeAssessment(universeId, record) {
  const directory = runDir(universeId, record.version, record.run_id);
  const inputDir = join(directory, 'input');
  const resultDir = join(directory, 'result');
  record.status = 'running';
  record.started_at = nowIso();
  await writeJson(runFile(universeId, record.version, record.run_id), record);
  await mkdir(resultDir, { recursive: true });
  // What the workspace holds before any child of this run exists: a write that escapes the run directory is
  // what appears afterwards and was not there before.
  const boundaryBefore = await scanWriteBoundary(universeId, record);

  // Who produces the semantic observations is decided at request time, but the work happens here: a review
  // whose observations come from the configured evaluator spends one or two model calls, and a caller must
  // not be made to hold an HTTP request open for that. The run exists from the start, so the interface
  // shows it as running while the evaluator reads, and a retry that already holds an accepted document
  // reuses it instead of paying for another reading.
  const controller = controllerFor(universeId, record);
  if (controller.cancelled) {
    record.status = 'cancelled';
    record.finished_at = nowIso();
    await writeJson(runFile(universeId, record.version, record.run_id), record);
    releaseController(record.run_id);
    return record;
  }
  // The continuity substage runs before the reading: it is deterministic, it reviews the same frozen packet
  // and the same selection, and it costs no model call. Its result is data for the metrics phase, never a
  // gate on it, and a substage that cannot run leaves the run to publish what it did measure.
  let continuity = null;
  try {
    continuity = await prepareContinuity(universeId, record, controller);
  } catch (error) {
    record.continuity_substage = { ok: false, reason: `the continuity substage failed: ${String(error?.message ?? error).slice(0, 200)}` };
    continuity = null;
  }
  if (controller.cancelled) {
    record.status = 'cancelled';
    record.finished_at = nowIso();
    await writeJson(runFile(universeId, record.version, record.run_id), record);
    releaseController(record.run_id);
    return record;
  }
  if (record.annotation_mode === 'generic') {
    const reuse = await reuseGeneratedAnnotations(universeId, record);
    if (!reuse.reusable && reuse.refused) {
      // The document this run was going to re-render is not the document it accepted: a changed stored
      // artifact is a broken run, not an invitation to call the evaluator again and publish something else.
      record.status = 'error';
      record.error = `annotation stage: ${reuse.reason}`;
      record.finished_at = nowIso();
      await writeJson(runFile(universeId, record.version, record.run_id), record);
      releaseController(record.run_id);
      return record;
    }
    record.reused_annotations = reuse.reusable;
    if (!reuse.reusable) {
      // The stage may itself fail — a bad packet, an unwritable workspace, a bug in the validator. A thrown
      // error is this run's error: the record says what happened and the controller is released, instead of a
      // run that stays `running` for every later reader.
      let staged;
      try {
        staged = await generateAnnotationsForRun(universeId, record, controller, continuity);
      } catch (error) {
        record.status = 'error';
        record.error = `annotation stage: ${String(error?.message ?? error).slice(0, 400)}`;
        record.finished_at = nowIso();
        await writeJson(runFile(universeId, record.version, record.run_id), record);
        releaseController(record.run_id);
        return record;
      }
      if (controller.cancelled) {
        record.status = 'cancelled';
        record.finished_at = nowIso();
        await writeJson(runFile(universeId, record.version, record.run_id), record);
        releaseController(record.run_id);
        return record;
      }
      if (!staged.ok) {
        record.status = 'error';
        record.error = `annotation stage: ${staged.reason}`;
        record.finished_at = nowIso();
        await writeJson(runFile(universeId, record.version, record.run_id), record);
        releaseController(record.run_id);
        return record;
      }
    }
  }
  // A deterministic metrics review calls no model, but its continuity substage did run: the host writes the
  // verified continuity result into an annotations document of its own, so the report computes CCI and CAD
  // from bytes a child produced while every semantic result stays honestly unavailable.
  let hostAnnotationsPath = null;
  if (record.phase === 'metrics' && record.annotation_mode === 'deterministic' && !record.annotations) {
    // The rules are the host's declaration rather than a model observation, so a deterministic review can
    // still measure compliance against them: every applicable pair is reported as unresolved by the report,
    // and the registry version, the rules and the continuity result are what the compliance views show.
    const registry = await readFile(join(inputDir, RULES_FILE), 'utf8').then((raw) => JSON.parse(raw), () => null);
    const document = `${JSON.stringify({
      schema_version: 'annotations.v1',
      source_version: record.version,
      continuity: continuity ?? null,
      requirements: registry ? registryRequirements(registry, []) : null
    }, null, 2)}\n`;
    await writeFile(join(directory, 'generated', 'continuity-annotations.json'), document, 'utf8');
    hostAnnotationsPath = join(directory, 'generated', 'continuity-annotations.json');
    record.continuity_annotations = 'generated/continuity-annotations.json';
    await writeJson(runFile(universeId, record.version, record.run_id), record);
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
    annotationsPath: hostAnnotationsPath ?? (record.generated_annotations ? join(directory, record.generated_annotations) : null),
    trigger: record.trigger,
    arcId: record.arc_id
  });
  const outcome = await new Promise((resolve) => {
    const child = spawn(process.execPath, [command.script, ...command.args], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PI_NO_TITLE: '1' }
    });
    controller.child = { kill: (signal = 'SIGTERM') => child.kill(signal), pid: child.pid };
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
  record.exit_code = outcome.code;
  record.finished_at = nowIso();
  let envelope = null;
  try {
    envelope = JSON.parse(outcome.stdout.trim().split('\n').pop());
  } catch {
    envelope = null;
  }
  if (envelope) record.envelope = envelope;
  // The published set is decided here, from the entries that actually exist: a report is a regular file with
  // a plain file name inside the run's own result directory. A symbolic link that escapes that area, or any
  // other entry, is refused — and a run that produced one publishes nothing at all.
  const refusedOutputs = [];
  const published = [];
  for (const entry of await readdir(resultDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && OUTPUT_NAME_PATTERN.test(entry.name)) published.push(entry.name);
    else {
      refusedOutputs.push({
        name: entry.name,
        reason: entry.isSymbolicLink() ? 'a symbolic link, not a file inside the review output area' : 'not a plain file name inside the review output area'
      });
    }
  }
  const escapedWrites = (await scanWriteBoundary(universeId, record)).filter((path) => !boundaryBefore.includes(path));
  record.output_boundary = { ok: refusedOutputs.length === 0, refused: refusedOutputs };
  record.write_boundary = { ok: escapedWrites.length === 0, escapes: escapedWrites };
  if (controller.cancelled) {
    // A cancellation wins over a late success: the run was asked to stop and nothing it published counts.
    record.status = 'cancelled';
    record.error = null;
    record.outputs = [];
  } else if (refusedOutputs.length > 0 || escapedWrites.length > 0) {
    record.status = 'error';
    record.outputs = [];
    record.error = refusedOutputs.length > 0
      ? `the run published ${refusedOutputs.map((entry) => `${entry.name} (${entry.reason})`).join(', ')}`
      : `the review wrote outside its own run directory: ${escapedWrites.join(', ')}`;
  } else if (outcome.code === 0) {
    record.status = 'done';
    record.error = null;
    record.outputs = published.sort();
  } else {
    record.status = 'error';
    record.outputs = [];
    const reason = (envelope?.errors ?? []).map((entry) => `${entry.code ?? 'ERROR'}: ${entry.message ?? ''}`).join('; ');
    record.error = reason || outcome.stderr.trim().split('\n').pop() || `the phase exited with code ${outcome.code}`;
  }
  if (record.status === 'done') {
    // The revision a reader's reaction binds to: the bytes of every published file, hashed as they exist now.
    const files = [];
    for (const name of record.outputs) {
      const bytes = await readFile(join(resultDir, name)).catch(() => null);
      files.push({ name, sha256: bytes ? sha256(bytes) : null, bytes: bytes ? bytes.length : null });
    }
    record.result_files = files;
    record.result_revision = `sha256:${sha256(files.map((file) => `${file.name}\t${file.sha256}\t${file.bytes}\n`).join(''))}`;
    record.published_at = nowIso();
  } else {
    record.result_files = null;
    record.result_revision = null;
    record.published_at = null;
  }
  record.log = { stdout: outcome.stdout.slice(-20_000), stderr: outcome.stderr.slice(-8_000) };
  await writeJson(runFile(universeId, record.version, record.run_id), record);
  releaseController(record.run_id);
  return record;
}

/**
 * The two areas a review must not write: the frozen packet beside it and the live universe outside. The host
 * cannot sandbox a child process, so after every child has terminated it verifies the areas it owns — the
 * version directory that holds the run and the workspace that holds the versions. Only run directories, arc
 * events and feedback belong there, so a file that appeared among them is a write that escaped, named
 * exactly, and the run publishes nothing. The list is read before the children start and compared after, so
 * what a forgotten file of some other tool looks like is not this run's fault.
 */
async function scanWriteBoundary(universeId, record) {
  const strays = [];
  const workspace = universeWorkspace(universeId);
  const versionDir = join(workspace, versionSlug(record.version));
  for (const entry of await readdir(versionDir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      // Another run's directory, the approvals of this version, or a run directory written by an older tool:
      // all of them are containers a review may not have created and may not be blamed for.
      if (entry.name === 'approvals' || RUN_ID_PATTERN.test(entry.name)) continue;
      if (await stat(join(versionDir, entry.name, 'run.json')).then(() => true, () => false)) continue;
    }
    strays.push(relative(assessmentsRoot(), join(versionDir, entry.name)));
  }
  for (const entry of await readdir(workspace, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && (isVersionDir(entry.name) || WORKSPACE_FEATURES.includes(entry.name))) continue;
    strays.push(relative(assessmentsRoot(), join(workspace, entry.name)));
  }
  return strays;
}

/**
 * The absolute path of one file a run published. Only the names that run lists can be read, and only as
 * plain file names, so a request cannot name a path into the result directory or outside it. What is
 * published is also checked against what was published: a symbolic link, a file that is no longer a plain
 * file, or bytes that differ from the revision the run recorded are refused, because a reader's reaction
 * refers to the report revision it saw.
 */
export async function runOutputPath(universeId, runId, name) {
  const wanted = String(name ?? '');
  if (!OUTPUT_NAME_PATTERN.test(wanted) || wanted.includes('..')) {
    throw new UniverseError('BAD_FILE', 'A report file is a plain file name, not a path.', 400);
  }
  const run = await readAssessment(universeId, runId);
  if (!Array.isArray(run.outputs) || !run.outputs.includes(wanted)) {
    throw new UniverseError('NOT_FOUND', `This run published no file named ${JSON.stringify(wanted)}.`, 404);
  }
  const path = join(assessmentsRoot(), run.result_dir, wanted);
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile()) {
    throw new UniverseError('RESULT_CHANGED', `The published file ${JSON.stringify(wanted)} is not a plain file inside the result directory any more.`, 409);
  }
  const recorded = (run.result_files ?? []).find((file) => file.name === wanted) ?? null;
  if (recorded?.sha256) {
    const bytes = await readFile(path).catch(() => null);
    if (!bytes || sha256(bytes) !== recorded.sha256) {
      throw new UniverseError('RESULT_CHANGED', `The published file ${JSON.stringify(wanted)} is not the revision this run published; a reaction to it would refer to different text.`, 409);
    }
  }
  return path;
}

export async function readAssessment(universeId, runId) {
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  const current = await currentVersion(universeId);
  return { ...found.record, historical: current !== null && found.record.version !== current };
}

/** The two states in which a run owns a child and keeps writing under its directory. */
const LIVE_STATUSES = ['queued', 'running'];
// The ceiling the turn console keeps, for the same reason: a console longer than this is not read faster by
// being unreadable, and the journal itself is bounded as it is written.
const MAX_CONSOLE_CHARS = 400_000;

function consoleClock(value) {
  const time = new Date(value ?? Date.now()).getTime();
  return Number.isNaN(time) ? '--:--:--' : new Date(time).toISOString().slice(11, 19);
}

/** The scope of one run as the console names it: a chapter, chapters, or the whole book. */
function consoleScope(scope) {
  if (!scope) return '—';
  if (scope.kind === 'book') return 'the whole book';
  const chapters = Array.isArray(scope.chapters) ? scope.chapters : [];
  if (chapters.length === 0) return String(scope.kind);
  return `${chapters.length === 1 ? 'chapter' : 'chapters'} ${chapters.join(', ')}`;
}

/** How one run ended, as the console states it. A live run has no such line: nothing is claimed about it. */
function consoleSettleLine(record) {
  const outputs = Array.isArray(record.outputs) ? record.outputs : [];
  if (record.status === 'done') {
    return `✓ done — published ${outputs.length} file(s)${record.result_revision ? ` · revision ${record.result_revision}` : ''}`;
  }
  if (record.status === 'cancelled') return '✗ cancelled — the run stopped before it published anything';
  const reason = record.error ?? (Array.isArray(record.annotation_errors) ? record.annotation_errors[0] : null);
  return `✗ ${String(record.status ?? 'unknown').replace(/_/g, ' ')}${reason ? ` — ${reason}` : ''}`;
}

/**
 * The facts of one run as console lines, each carrying the time it happened: when it was created, the call
 * the evaluator is answering right now, every call that finished, the continuity substage, and the line that
 * says how it ended. The attempt records are the durable half; the line for a call in flight is what makes a
 * review that needs minutes readable while it needs them.
 */
function recordConsoleLines(record) {
  const lines = [];
  const line = (at, text) => lines.push({ at: at ?? record.created_at ?? null, text: `[${consoleClock(at)}] ${text}` });
  const arc = record.trigger === 'arc' && record.arc_id ? ` · arc ${record.arc_id}` : '';
  const phase = record.phase === 'continuity' ? 'continuity' : 'metrics';
  line(record.created_at, `created — ${phase} review · ${consoleScope(record.requested_scope ?? record.scope)}${arc}`);
  if (record.started_at) line(record.started_at, 'running');
  const reading = record.annotation_reading;
  if (reading && Number.isFinite(reading.units_planned)) {
    line(record.started_at ?? record.created_at, `reading — ${reading.units_planned} unit(s) planned, ${reading.units_completed ?? 0} read, ${reading.units_failed ?? 0} failed, ${reading.units_reused ?? 0} reused`);
  }
  for (const attempt of Array.isArray(record.annotation_attempts) ? record.annotation_attempts : []) {
    const what = `${attempt.call ?? 'call'}${attempt.unit ? ` ${attempt.unit}` : ''} · attempt ${attempt.attempt ?? 1} · ${attempt.model ?? 'unknown model'}`;
    line(attempt.started_at, `→ ${what}`);
    const seconds = Number.isFinite(attempt.duration_ms) ? ` — ${Math.round(attempt.duration_ms / 1000)} s` : '';
    const why = attempt.ok === true
      ? ''
      : ` — ${(Array.isArray(attempt.errors) ? attempt.errors[0] : null)
        ?? (attempt.exit_code != null ? `the evaluator exited with code ${attempt.exit_code}` : 'the call did not succeed')}`;
    line(attempt.finished_at, `${attempt.ok === true ? '✓' : '✗'} ${what}${seconds}${why}`);
  }
  const inflight = record.in_flight;
  if (inflight && LIVE_STATUSES.includes(record.status)) {
    const what = `${inflight.call ?? 'call'}${inflight.unit ? ` ${inflight.unit}` : ''} · attempt ${inflight.attempt ?? 1} · ${inflight.model ?? 'the model'}`;
    const budget = Number.isFinite(inflight.timeout_ms) ? ` of a ${Math.round(inflight.timeout_ms / 1000)} s budget` : '';
    line(inflight.started_at, `… ${what} — in flight since ${consoleClock(inflight.started_at)}${budget}${inflight.pid ? ` · pid ${inflight.pid}` : ''}`);
  }
  const substage = record.continuity_substage;
  if (substage) {
    const reason = substage.reason ? ` — ${substage.reason}` : (substage.document ? ` — ${substage.document}` : '');
    line(record.finished_at ?? record.started_at ?? record.created_at, `${substage.ok ? '✓' : '✗'} continuity substage${substage.reused ? ' (reused)' : ''}${reason}`);
  }
  if (!LIVE_STATUSES.includes(record.status)) line(record.finished_at ?? record.created_at, consoleSettleLine(record));
  return lines;
}

/**
 * The console of one review run as a client reads it: the facts the record kept, merged in time order with the
 * journal the evaluator child wrote while it worked. `source` is `journal` once the evaluator has streamed
 * anything and `record` for a run whose child produced no stream at all. It is the same shape a turn's console
 * answers, so a reader watches a review the way they watch a chapter being written.
 */
export async function readAssessmentConsole(universeId, runId) {
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  const record = found.record;
  const journal = await readJournal(evaluatorJournalPath(runDir(universeId, record.version, record.run_id)));
  const lines = [
    ...recordConsoleLines(record).map((entry, index) => ({ ...entry, rank: 0, index })),
    ...journal.lines.map((entry, index) => ({ ...entry, rank: 1, index }))
  ]
    // Equal timestamps keep the record's own lines first: what the host knows about the run frames what the
    // evaluator was doing inside it.
    .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.text);
  return {
    console: {
      text: lines.length > 0 ? truncate(lines.join('\n'), MAX_CONSOLE_CHARS) : 'Nothing was recorded for this run.',
      live: LIVE_STATUSES.includes(record.status),
      updatedAt: journal.updatedAt ?? record.finished_at ?? record.started_at ?? record.created_at ?? null,
      source: journal.lines.length > 0 ? 'journal' : 'record'
    }
  };
}

/**
 * Delete one stored review: its frozen packet, its attempts, its console and whatever it published. A run that
 * is still queued or running is refused — a live child reads that directory — so a caller cancels first and
 * deletes what stopped. Evidence that names the run is a second refusal: a newer run that re-evaluates it and
 * a reader's stored response both point at this report, and deleting it would leave them pointing at nothing.
 * The book is never touched: a phase writes outside `universes/`.
 */
export async function deleteAssessment(universeId, runId) {
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  if (LIVE_STATUSES.includes(found.record.status) || controllers.has(runId)) {
    throw new UniverseError('STILL_LIVE', `Assessment ${runId} is ${found.record.status}; cancel it before deleting it.`, 409);
  }
  const successor = (await listAssessments(universeId)).find((run) => run.reassesses_run_id === runId);
  if (successor) {
    throw new UniverseError('REFERENCED', `Assessment ${successor.run_id} re-evaluates this run; delete that one first.`, 409);
  }
  const { feedback } = await listFeedback(universeId).catch(() => ({ feedback: [] }));
  const answers = (Array.isArray(feedback) ? feedback : []).filter((entry) => entry.run_id === runId);
  if (answers.length > 0) {
    throw new UniverseError('REFERENCED', `${answers.length} reader response(s) refer to this report; withdraw or delete them before deleting it.`, 409);
  }
  await rm(runDir(universeId, found.record.version, runId), { recursive: true, force: true });
  return { run_id: runId, version: found.record.version, phase: found.record.phase };
}

export async function cancelAssessment(universeId, runId) {
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  if (!LIVE_STATUSES.includes(found.record.status)) {
    throw new UniverseError('NOT_CANCELLABLE', `Assessment ${runId} is ${found.record.status}.`, 409);
  }
  const controller = controllers.get(runId);
  if (controller) {
    // The executing record itself is cancelled, not a separately loaded copy: the executor sees the flag
    // before its next stage and a late success loses to it.
    controller.cancelled = true;
    if (controller.child) {
      controller.child.kill('SIGTERM');
      setTimeout(() => controller.child.kill('SIGKILL'), 5_000).unref();
    }
    controller.record.status = 'cancelled';
    controller.record.finished_at = nowIso();
    controller.record.error = null;
    await writeJson(runFile(universeId, controller.record.version, runId), controller.record);
    return controller.record;
  }
  found.record.status = 'cancelled';
  found.record.finished_at = nowIso();
  found.record.error = null;
  await writeJson(runFile(universeId, found.record.version, runId), found.record);
  return found.record;
}

/**
 * Re-run an unfinished assessment with the same identity: the same frozen packet and run id, one more
 * attempt. A published `done` run is not retried: its report is the evidence a reader's reaction refers to,
 * so it is kept exactly as it was published and a re-evaluation becomes a new run (`reassessAssessment`).
 * The attempt records of the earlier attempts are kept: a retry appends, it never erases.
 */
export async function retryAssessment(universeId, runId) {
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  if (LIVE_STATUSES.includes(found.record.status)) {
    throw new UniverseError('NOT_RETRYABLE', `Assessment ${runId} is still ${found.record.status}.`, 409);
  }
  if (found.record.status === 'done') {
    throw new UniverseError(
      'ALREADY_PUBLISHED',
      `Assessment ${runId} published a result; a published report is kept as it was published. Re-evaluate it as a new run.`,
      409
    );
  }
  if (controllers.has(runId)) {
    throw new UniverseError('NOT_RETRYABLE', `Assessment ${runId} is being cancelled; wait for its child to stop.`, 409);
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
  found.record.outputs = [];
  found.record.result_revision = null;
  found.record.result_files = null;
  found.record.published_at = null;
  // The phase of the new attempt needs an empty output directory of its own, and nothing here was ever
  // published: the attempt records, the log and the reason of the earlier attempt stay in the record.
  await rm(join(universeWorkspace(universeId), versionSlug(found.record.version), runId, 'result'), { recursive: true, force: true });
  await writeJson(runFile(universeId, found.record.version, runId), found.record);
  launch(universeId, found.record);
  return found.record;
}

/**
 * Re-evaluate a published assessment as a new run. The frozen packet is the one the earlier run reviewed, so
 * the new run answers the same question about the same text; what it may not do is replace the earlier
 * report. `annotations: 'reuse'` re-renders the reading the earlier run accepted, after verifying it against
 * the hash and the source it was saved with; `annotations: 'regenerate'` asks the evaluator for a new reading
 * and pays for one. The new record names the run it re-evaluates, and the earlier run is not written again.
 */
export async function reassessAssessment(universeId, runId, { annotations = 'reuse', annotationModel = null } = {}) {
  if (!['reuse', 'regenerate'].includes(annotations)) {
    throw new UniverseError('BAD_MODE', 'A re-evaluation reuses the accepted annotations or regenerates them.', 400);
  }
  const found = await readRun(universeId, runId);
  if (!found) throw new UniverseError('NOT_FOUND', `Assessment ${runId} does not exist.`, 404);
  if (found.record.status !== 'done') {
    throw new UniverseError('NOT_REASSESSABLE', `Assessment ${runId} is ${found.record.status}; only a published run is re-evaluated as a new one.`, 409);
  }
  const previousDir = join(universeWorkspace(universeId), versionSlug(found.record.version), runId);
  const previousInput = join(previousDir, 'input');
  const manifest = await readJson(join(previousInput, 'manifest.json'), null);
  if (!manifest) {
    throw new UniverseError('NO_PACKET', `Assessment ${runId} lost its frozen packet; start a new assessment instead.`, 409);
  }
  let reused = null;
  if (annotations === 'reuse' && found.record.generated_annotations) {
    const verdict = await verifyStoredAnnotations({ skillsDir, directory: previousDir, inputDir: previousInput, record: found.record });
    if (!verdict.ok) {
      throw new UniverseError(
        'ANNOTATIONS_CHANGED',
        `Assessment ${runId} cannot be re-rendered: ${verdict.reason}. Re-evaluate it with regenerated annotations instead.`,
        409
      );
    }
    reused = found.record.generated_annotations;
  }
  const newRunId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${found.record.phase}-${randomBytes(2).toString('hex')}`;
  const target = runDir(universeId, found.record.version, newRunId);
  // The packet is copied, never re-captured: a re-evaluation is about the same frozen text, and the copy is
  // byte-identical to what the earlier run read.
  await cp(previousInput, join(target, 'input'), { recursive: true });
  await mkdir(join(target, 'result'), { recursive: true });
  const record = {
    ...found.record,
    run_id: newRunId,
    status: 'queued',
    created_at: nowIso(),
    started_at: null,
    finished_at: null,
    exit_code: null,
    error: null,
    outputs: [],
    result_revision: null,
    result_files: null,
    published_at: null,
    envelope: null,
    log: null,
    attempts: 1,
    reassesses_run_id: runId,
    evaluation_attempt: (found.record.evaluation_attempt ?? 1) + 1,
    reused_annotations: false,
    annotation_model: annotationModel ?? found.record.annotation_model,
    annotation_attempts: found.record.annotation_attempts ?? null,
    annotation_errors: null,
    generated_annotations: null,
    annotations_sha256: null,
    historical: false,
    input_dir: relative(assessmentsRoot(), join(target, 'input')),
    result_dir: relative(assessmentsRoot(), join(target, 'result'))
  };
  if (reused) {
    // The accepted reading travels with the new run so the phase can re-render it without a model call; its
    // hash travels too, so the run can prove it re-rendered the bytes that were accepted.
    await cp(join(previousDir, reused), join(target, reused));
    record.generated_annotations = reused;
    record.annotations_sha256 = found.record.annotations_sha256;
    record.reused_annotations = true;
    for (const name of ['generated/provenance.json', 'generated/prompt.txt']) {
      await cp(join(previousDir, name), join(target, name)).catch(() => {});
    }
  }
  await writeJson(runFile(universeId, record.version, newRunId), record);
  launch(universeId, record);
  return record;
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
        record.in_flight = null;
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
  while ((controllers.size > 0 || pending.size > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return controllers.size === 0 && pending.size === 0;
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

