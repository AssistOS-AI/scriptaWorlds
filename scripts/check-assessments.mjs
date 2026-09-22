// The external assessment group of `scripts/check.mjs`: the requested and arc-end orchestration.
//
// It proves the properties a host depends on: a packet is only captured from a stable accepted version;
// the phases run outside the book and never change a byte of it; an identical request is deduplicated;
// an intervening rewrite makes an older result historical; a restart preserves the identity of a queued
// run and turns a running one into a retriable `interrupted`; and an arc-completion event is a real,
// versioned record rather than a planned flag.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  cancelAssessment,
  declareArcCompletion,
  listArcEvents,
  listAssessments,
  readAssessment,
  recoverAssessments,
  retryAssessment,
  settleAssessments,
  startAssessment
} from '../src/assessments.mjs';
import { assessmentsRoot, currentVersion } from '../src/assessment-packet.mjs';
import { listApprovals, recordApproval } from '../src/assessments.mjs';
import { universeDir } from '../src/paths.mjs';
import { bookWithTwoChapters, inventory, turnRecord } from './check-fixtures.mjs';

const PROFILE = {
  schema_version: 'profile.v1',
  profile_id: 'check-assessments',
  scope: { kind: 'book', chapters: [1, 2], context_chapters: [] },
  aggregation: { enabled: false }
};
export async function runAssessmentChecks({ ok, fail, checkSeed, tempDirs }) {
  const universe = await bookWithTwoChapters(checkSeed, 'assess');
  tempDirs.push(universe.id);
  const workspaceUniverse = join(assessmentsRoot(), universe.id);
  try {
    const before = await inventory(universe.id);

    // A packet is captured only from a stable accepted version: a queued or running turn is refused.
    {
      await turnRecord(universe.id, 9, { kind: 'chapter', status: 'running', request: 'writing', chapterNumber: 3, startedAt: new Date().toISOString() });
      let code = 'accepted';
      try {
        await startAssessment({ universeId: universe.id, phase: 'continuity' });
      } catch (error) {
        code = error.code;
      }
      await rm(join(universeDir(universe.id), 'turns', '0009.json'), { force: true });
      const version = await currentVersion(universe.id);
      if (code === 'UNSTABLE_VERSION' && version?.startsWith('sha256:')) {
        ok('assessments: a packet is refused while a turn of the book is queued or running, and the accepted version is available once it is stable');
      } else {
        fail(`assessments/stability: code=${code}, version=${version}`);
      }
    }

    // The continuity phase runs over the frozen packet and publishes outside the book.
    let continuityRun = null;
    {
      continuityRun = await startAssessment({ universeId: universe.id, phase: 'continuity' });
      await settleAssessments();
      const settled = await readAssessment(universe.id, continuityRun.run_id);
      const published = settled.outputs ?? [];
      const insideWorkspace = settled.input_dir.startsWith(`${universe.id}/`) && settled.result_dir.startsWith(`${universe.id}/`);
      if (settled.status === 'done' && published.includes('continuity-result.json') && insideWorkspace && settled.historical === false) {
        ok(`assessments: the continuity phase publishes ${published.join(', ')} into the external workspace and reports the version it reviewed`);
      } else {
        fail(`assessments/continuity: status=${settled.status}, outputs=${JSON.stringify(published)}, dirs=${settled.input_dir}/${settled.result_dir}, error=${settled.error}`);
      }
    }

    // The metrics phase publishes the bundle and its views from the same kind of packet.
    let metricsRun = null;
    {
      metricsRun = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE });
      await settleAssessments();
      const settled = await readAssessment(universe.id, metricsRun.run_id);
      const published = settled.outputs ?? [];
      const expected = ['assessment.json', 'index.md', '01-stg-compliance.md', '03-metrics-and-indicators.md', '05-detected-issues.md'];
      const missing = expected.filter((name) => !published.includes(name));
      const assessment = await readFile(join(assessmentsRoot(), settled.result_dir, 'assessment.json'), 'utf8').then(JSON.parse, () => null);
      if (settled.status === 'done' && missing.length === 0 && assessment?.version === settled.version) {
        ok(`assessments: the metrics phase publishes the bundle and its five views (${published.length} files) for the frozen version`);
      } else {
        fail(`assessments/metrics: status=${settled.status}, missing=${JSON.stringify(missing)}, version=${assessment?.version}, error=${settled.error}`);
      }
    }

    // An identical request is deduplicated instead of producing a second run of the same version.
    {
      const again = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE });
      if (again.deduplicated === true && again.run_id === metricsRun.run_id) {
        ok('assessments: the same phase, version, profile and trigger is deduplicated onto the run that already exists');
      } else {
        fail(`assessments/dedup: deduplicated=${again.deduplicated}, run=${again.run_id} vs ${metricsRun.run_id}`);
      }
    }

    // A phase that fails never touches the book: the run records the error and the store is unchanged.
    {
      const failed = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: { schema_version: 'profile.v1', profile_id: 'broken', scope: { kind: 'chapter', chapters: [999], context_chapters: [] } }, force: true });
      await settleAssessments();
      const settled = await readAssessment(universe.id, failed.run_id);
      const after = await inventory(universe.id);
      const diff = [...after.keys()].filter((path) => !before.has(path));
      if (settled.status === 'error' && settled.error && diff.length === 0) {
        ok(`assessments: a failing phase is recorded as an error (\`${String(settled.error).slice(0, 48)}…\`) and never writes into the book`);
      } else {
        fail(`assessments/failure: status=${settled.status}, error=${settled.error}, universe additions=${JSON.stringify(diff)}`);
      }
    }

    // A missing profile is refused before anything is captured.
    {
      let code = 'accepted';
      try {
        await startAssessment({ universeId: universe.id, phase: 'metrics' });
      } catch (error) {
        code = error.code;
      }
      if (code === 'NO_PROFILE') ok('assessments: the metrics phase without a profile is refused with NO_PROFILE');
      else fail(`assessments/profile: expected NO_PROFILE, received ${code}`);
    }

    // Cancelling is a state machine: a queued run can be cancelled, and a settled one cannot.
    {
      const runId = '20260922T120000-continuity-dead';
      const queued = {
        schema_version: 'assessment-run.v1',
        run_id: runId,
        universe_id: universe.id,
        phase: 'continuity',
        trigger: 'requested',
        arc_id: null,
        version: continuityRun.version,
        scope: continuityRun.scope,
        profile_sha256: null,
        annotations: false,
        input_dir: continuityRun.input_dir,
        result_dir: continuityRun.result_dir,
        status: 'queued',
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        exit_code: null,
        error: null,
        outputs: [],
        historical: false
      };
      const directory = join(workspaceUniverse, continuityRun.version.replace(/^sha256:/, 'sha256-'), runId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'run.json'), JSON.stringify(queued), 'utf8');
      const cancelled = await cancelAssessment(universe.id, runId);
      let second = 'accepted';
      try {
        await cancelAssessment(universe.id, runId);
      } catch (error) {
        second = error.code;
      }
      await rm(directory, { recursive: true, force: true });
      if (cancelled.status === 'cancelled' && second === 'NOT_CANCELLABLE') {
        ok('assessments: a queued run can be cancelled and a settled one answers NOT_CANCELLABLE');
      } else {
        fail(`assessments/cancel: status=${cancelled.status}, second=${second}`);
      }
    }

    // A restart keeps the identity of a queued run, and turns a running one into a retriable interrupted.
    {
      const runId = '20260922T120001-continuity-restart';
      const directory = join(workspaceUniverse, continuityRun.version.replace(/^sha256:/, 'sha256-'), runId);
      await mkdir(directory, { recursive: true });
      const base = { ...continuityRun, run_id: runId, status: 'running', outputs: [], error: null };
      await writeFile(join(directory, 'run.json'), JSON.stringify(base), 'utf8');
      const recovered = await recoverAssessments();
      const interrupted = await readAssessment(universe.id, runId);
      await rm(directory, { recursive: true, force: true });
      if (recovered.interrupted.includes(runId) && interrupted.status === 'interrupted' && interrupted.run_id === runId) {
        ok('assessments: a running run becomes interrupted after a restart, keeping its identity and its frozen packet');
      } else {
        fail(`assessments/restart: recovered=${JSON.stringify(recovered.interrupted)}, status=${interrupted.status}`);
      }
    }

    // A rewrite of the book makes the older result historical, and a retry reuses the same frozen packet.
    {
      await writeFile(join(universeDir(universe.id), 'chapters', '0002-two.md'), '# Two\n\nA different second chapter, written by hand after the assessment.\n', 'utf8');
      const listed = await listAssessments(universe.id);
      const older = listed.find((run) => run.run_id === metricsRun.run_id);
      const retried = await retryAssessment(universe.id, continuityRun.run_id);
      await settleAssessments();
      const afterRetry = await readAssessment(universe.id, continuityRun.run_id);
      const packet = await readFile(join(workspaceUniverse, continuityRun.input_dir.replace(`${universe.id}/`, ''), 'manifest.json'), 'utf8').then(JSON.parse, () => null);
      if (older?.historical === true && retried.attempts === 2 && afterRetry.status === 'done' && afterRetry.version === continuityRun.version && packet?.version === continuityRun.version) {
        ok('assessments: an intervening rewrite marks the older result historical, and a retry re-runs the same frozen packet');
      } else {
        fail(`assessments/freshness: historical=${older?.historical}, attempts=${retried.attempts}, status=${afterRetry.status}, packet=${packet?.version}`);
      }
      await retryAssessment(universe.id, metricsRun.run_id).catch(() => null);
      await settleAssessments();
    }

  // An approval is the only bridge from a proposal to a later writing request: it records the decision,
  // the version it was written against, the directions it accepts, and it is never rewritten.
  {
    const proposal = { schema_version: 'prose-profile.v1', profile_id: 'quiet-keeper', based_on_version: continuityRun.version };
    let stale = 'accepted';
    try {
      await recordApproval({
        universeId: universe.id,
        proposal,
        decision: 'approved',
        version: 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
      });
    } catch (error) {
      stale = error.code;
    }
    const approval = await recordApproval({
      universeId: universe.id,
      proposal,
      decision: 'approved',
      reviewer: 'the author',
      directions: ['Keep the keeper flat in the aftermath.']
    });
    let again = 'accepted';
    try {
      await recordApproval({ universeId: universe.id, proposal, decision: 'declined' });
    } catch (error) {
      again = error.code;
    }
    let declinedWithDirections = 'accepted';
    try {
      await recordApproval({ universeId: universe.id, proposal: { other: true }, decision: 'declined', directions: ['x'] });
    } catch (error) {
      declinedWithDirections = error.code;
    }
    const listed = await listApprovals(universe.id);
    if (stale === 'STALE_REQUEST' && approval.decision === 'approved' && approval.directions.length === 1
      && again === 'ALREADY_DECIDED' && declinedWithDirections === 'BAD_DECISION'
      && listed.length === 1 && approval.version === (await currentVersion(universe.id))) {
      ok('assessments: an approval records the decision, its version and its accepted directions, refuses a stale proposal, and is never rewritten');
    } else {
      fail(`assessments/approval: stale=${stale}, decision=${approval.decision}, directions=${approval.directions?.length}, again=${again}, declined=${declinedWithDirections}, listed=${listed.length}`);
    }
  }

    // An arc-completion event is a versioned record, and the assessment it implies is deduplicated.
    {
      const first = await declareArcCompletion({ universeId: universe.id, arcId: 'arc-ledger', note: 'the district answers', profile: PROFILE });
      await settleAssessments();
      const second = await declareArcCompletion({ universeId: universe.id, arcId: 'arc-ledger', profile: PROFILE });
      const events = await listArcEvents(universe.id);
      const runsForArc = (await listAssessments(universe.id)).filter((run) => run.arc_id === 'arc-ledger');
      if (first.event.version.startsWith('sha256:') && events.length === 1 && runsForArc.length === 1 && second.run?.deduplicated === true) {
        ok('assessments: an arc-completion event records the stable arc id and the accepted version, and its assessment is deduplicated by arc, version and profile');
      } else {
        fail(`assessments/arc: version=${first.event.version}, events=${events.length}, runs=${runsForArc.length}, second=${second.run?.deduplicated}`);
      }
    }

    // Everything above ran outside the book: the store is byte-identical.
    {
      const after = await inventory(universe.id);
      const changed = [];
      for (const [path, hash] of before) if (path !== 'chapters/0002-two.md' && after.get(path) !== hash) changed.push(path);
      const added = [...after.keys()].filter((path) => !before.has(path));
      if (changed.length === 0 && added.length === 0) {
        ok('assessments: the whole orchestration leaves the store untouched apart from the chapter this check wrote by hand');
      } else {
        fail(`assessments/store: changed=${JSON.stringify(changed)}, added=${JSON.stringify(added)}`);
      }
    }

  } finally {
    await rm(workspaceUniverse, { recursive: true, force: true });
  }
}
