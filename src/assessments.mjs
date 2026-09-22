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
import {
  EXTRA_ROLES,
  PHASES,
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
function phaseCommand(phase, { inputDir, resultDir, profilePath }) {
  if (phase === 'continuity') {
    return {
      script: join(skillsDir, 'scripta-continuity-review', 'scripts', 'review-continuity.mjs'),
      args: ['--input', inputDir, '--out', resultDir]
    };
  }
  if (phase === 'metrics') {
    if (!profilePath) throw new UniverseError('NO_PROFILE', 'The metrics phase needs a profile.', 400);
    return {
      script: join(skillsDir, 'scripta-metrics-report', 'scripts', 'build-report.mjs'),
      args: ['--input', inputDir, '--out', resultDir, '--profile', profilePath]
    };
  }
  throw new UniverseError('BAD_PHASE', `Unknown assessment phase (${PHASES.join('|')}).`, 400);
}

async function readRun(universeId, runId) {
  for (const versionDir of await readdir(universeWorkspace(universeId)).catch(() => [])) {
    if (versionDir === 'arc-events') continue;
    for (const name of await readdir(join(universeWorkspace(universeId), versionDir)).catch(() => [])) {
      const record = await readJson(join(universeWorkspace(universeId), versionDir, name, 'run.json'), null);
      if (record?.run_id === runId) return { record, versionDir };
    }
  }
  return null;
}

/** Every run of a universe, newest first, with its freshness against the current accepted version. */
export async function listAssessments(universeId) {
  const runs = [];
  for (const versionDir of await readdir(universeWorkspace(universeId)).catch(() => [])) {
    if (versionDir === 'arc-events') continue;
    for (const name of await readdir(join(universeWorkspace(universeId), versionDir)).catch(() => [])) {
      const record = await readJson(join(universeWorkspace(universeId), versionDir, name, 'run.json'), null);
      if (record) runs.push(record);
    }
  }
  const current = await currentVersion(universeId);
  return runs
    .map((record) => ({ ...record, historical: current !== null && record.version !== current }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

const running = new Map();
const pending = new Map();

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
export async function startAssessment({ universeId, phase = 'metrics', profile = null, annotations = null, corpus = null, fromTurn = null, trigger = 'requested', arcId = null, force = false }) {
  if (!PHASES.includes(phase)) {
    throw new UniverseError('BAD_PHASE', `Unknown assessment phase (${PHASES.join('|')}).`, 400);
  }
  if (phase === 'metrics' && !profile) {
    throw new UniverseError('NO_PROFILE', 'The metrics phase needs a profile (schema_version profile.v1).', 400);
  }
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${phase}-${randomBytes(2).toString('hex')}`;
  const captured = await capturePacket(universeId, {
    runId,
    fromTurn,
    extras: {
      ...(profile ? { profile } : {}),
      ...(annotations ? { annotations } : {}),
      ...(corpus ? { corpus } : {})
    }
  });
  const profilePath = profile ? join(captured.dir, 'input', EXTRA_ROLES.profile) : null;
  const record = {
    schema_version: RUN_SCHEMA,
    run_id: runId,
    universe_id: universeId,
    phase,
    trigger,
    arc_id: arcId ?? null,
    version: captured.manifest.version,
    scope: captured.manifest.scope,
    profile_sha256: profilePath ? sha256(await readFile(profilePath)) : null,
    annotations: annotations ? true : false,
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
  if (!force) {
    const duplicate = (await listAssessments(universeId)).find((run) => run.phase === phase
      && run.version === record.version
      && (run.profile_sha256 ?? null) === record.profile_sha256
      && Boolean(run.annotations) === Boolean(record.annotations)
      && run.arc_id === record.arc_id
      && (run.status === 'done' || run.status === 'running' || run.status === 'queued'));
    if (duplicate) {
      await rm(captured.dir, { recursive: true, force: true });
      return { ...duplicate, deduplicated: true };
    }
  }
  await writeJson(runFile(universeId, record.version, runId), record);
  launch(universeId, record);
  return record;
}

/** Run the phase as a child process, record the outcome, and never touch the store. */
export async function executeAssessment(universeId, record) {
  const directory = runDir(universeId, record.version, record.run_id);
  const inputDir = join(directory, 'input');
  const resultDir = join(directory, 'result');
  const profilePath = record.profile_sha256 ? join(inputDir, EXTRA_ROLES.profile) : null;
  const command = phaseCommand(record.phase, { inputDir, resultDir, profilePath });
  record.status = 'running';
  record.started_at = nowIso();
  await writeJson(runFile(universeId, record.version, record.run_id), record);
  await mkdir(resultDir, { recursive: true });
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
export async function declareArcCompletion({ universeId, arcId, note = null, phase = 'metrics', profile = null }) {
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
  // The event is the durable fact. The assessment it implies starts when the host supplies a profile,
  // because the metrics phase cannot run without one.
  const run = profile ? await startAssessment({ universeId, phase, profile, trigger: 'arc', arcId: cleanId }) : null;
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

