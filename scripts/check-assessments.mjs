// The external assessment group of `scripts/check.mjs`: the requested and arc-end orchestration.
//
// It proves the properties a host depends on: a packet is only captured from a stable accepted version;
// the phases run outside the book and never change a byte of it; an identical request is deduplicated;
// an intervening rewrite makes an older result historical; a restart preserves the identity of a queued
// run and turns a running one into a retriable `interrupted`; and an arc-completion event is a real,
// versioned record rather than a planned flag.
import { createHash } from 'node:crypto';
import { runAssessmentAnnotationChecks } from './check-assessment-annotations.mjs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { config } from '../src/config.mjs';
import { listApprovals, recordApproval } from '../src/assessments.mjs';
import { universeDir } from '../src/paths.mjs';
import { bookWithTwoChapters, inventory, turnRecord } from './check-fixtures.mjs';

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

const PROFILE = {
  schema_version: 'profile.v1',
  profile_id: 'check-assessments',
  scope: { kind: 'book', chapters: [1, 2], context_chapters: [] },
  aggregation: { enabled: false }
};
/**
 * The fake evaluator: a real child process that behaves like the configured agent at the process level. It
 * reads the packet from its working directory and answers with one valid `annotations.v1` document whose
 * evidence quotes are taken from the actual bytes, so the host's validation can pass or fail honestly.
 */

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
        await startAssessment({ universeId: universe.id, phase: 'continuity' , mode: 'deterministic' });
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
      continuityRun = await startAssessment({ universeId: universe.id, phase: 'continuity' , mode: 'deterministic' });
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
      metricsRun = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE , mode: 'deterministic' });
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
      const again = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE , mode: 'deterministic' });
      if (again.deduplicated === true && again.run_id === metricsRun.run_id) {
        ok('assessments: the same phase, version, profile and trigger is deduplicated onto the run that already exists');
      } else {
        fail(`assessments/dedup: deduplicated=${again.deduplicated}, run=${again.run_id} vs ${metricsRun.run_id}`);
      }
    }

    // A phase that fails never touches the book: the run records the error and the store is unchanged.
    {
      const failed = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: { schema_version: 'profile.v1', profile_id: 'broken', scope: { kind: 'chapter', chapters: [999], context_chapters: [] } }, force: true, mode: 'deterministic' });
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

    // A metrics review is a supported application mode: no hand-authored JSON, no human labels. The
    // host builds its own generic profile, components are evaluated, and the aggregate stays optional.
    {
      const generic = await startAssessment({ universeId: universe.id, phase: 'metrics' , mode: 'deterministic' });
      await settleAssessments();
      const genericRun = await readAssessment(universe.id, generic.run_id);
      const genericBundle = await readFile(join(assessmentsRoot(), genericRun.result_dir, 'assessment.json'), 'utf8').then(JSON.parse, () => null);
      const componentsPresent = ['CS', 'OI', 'NCS', 'EAP'].every((id) => genericBundle?.metrics?.[id] !== undefined);
      const aggregateOff = (genericBundle?.profile?.aggregation?.enabled ?? false) === false;
      if (genericRun.status === 'done' && genericRun.profile_source === 'generic' && componentsPresent && aggregateOff
        && (genericRun.inputs ?? []).some((input) => input.role === 'profile')) {
        ok('assessments/generic: a metrics review runs with no supplied profile, evaluates the components and keeps the aggregate off');
      } else {
        fail(`assessments/generic: status=${genericRun.status}, source=${genericRun.profile_source}, components=${componentsPresent}, aggregateOff=${aggregateOff}, error=${genericRun.error}, stdout=${String(genericRun.log?.stdout ?? '').trim().split('\n').pop()?.slice(0, 160)}`);
      }

      // Aggregation is optional, uses the research policy, and the number must follow the declared
      // arithmetic: the rubric scale is 0..4, so a component is 100 * sum(ratings) / (4 * count), and the
      // aggregate is the declared weighted mean of the components.
      const oneText = await readFile(join(universeDir(universe.id), 'chapters', '0001-one.md'), 'utf8');
      const twoText = await readFile(join(universeDir(universe.id), 'chapters', '0002-two.md'), 'utf8');
      const judged = {
        schema_version: 'annotations.v1',
        source_version: await currentVersion(universe.id),
        evidence: [
          { id: 'g1', file: 'chapters/0001-one.md', sha256: sha256hex(await readFile(join(universeDir(universe.id), 'chapters', '0001-one.md'))), start: 0, end: 40, quote: oneText.slice(0, 40) },
          { id: 'g2', file: 'chapters/0002-two.md', sha256: sha256hex(await readFile(join(universeDir(universe.id), 'chapters', '0002-two.md'))), start: 0, end: 30, quote: twoText.slice(0, 30) }
        ],
        metrics: {
          CS: {
            status: 'judged',
            evaluator: 'annotator-2',
            dimensions: {
              referential_clarity: { rating: 4, rationale: 'every referent is recoverable', evidence: ['g1'] },
              discourse_connection: { rating: 4, rationale: 'the sequence connects', evidence: ['g2'] },
              causal_support: { rating: 4, rationale: 'the causes are shown', evidence: ['g1'] },
              temporal_intelligibility: { rating: 4, rationale: 'the order survives the rearrangement', evidence: ['g2'] }
            }
          },
          OI: {
            status: 'judged',
            evaluator: 'annotator-2',
            comparison_scope: 'the two chapters of this book',
            dimensions: {
              perspective: { rating: 2, rationale: 'one focal character', evidence: ['g1'] },
              dramatic_development: { rating: 2, rationale: 'the choice is dramatized', evidence: ['g2'] },
              expression: { rating: 2, rationale: 'the voice is consistent', evidence: ['g1'] }
            }
          },
          NQS: { emotional_fit: 70 }
        }
      };
      const aggregated = await startAssessment({
        universeId: universe.id,
        phase: 'metrics',
        annotations: judged,
        aggregate: true,
        intention: 'restraint over escalation in a quiet aftermath'
      });
      await settleAssessments();
      const aggregatedRun = await readAssessment(universe.id, aggregated.run_id);
      const aggregatedBundle = await readFile(join(assessmentsRoot(), aggregatedRun.result_dir, 'assessment.json'), 'utf8').then(JSON.parse, () => null);
      const expected = 0.4 * 100 + 0.3 * 50 + 0.3 * 70; // CS all 4s → 100, OI all 2s → 50, emotional fit 70, weights 0.4/0.3/0.3
      const nqs = aggregatedBundle?.metrics?.NQS ?? null;
      const policyVisible = String(aggregatedBundle?.profile?.aggregation?.policy ?? aggregatedBundle?.metrics?.NQS?.detail?.policy ?? '') === 'research'
        || JSON.stringify(aggregatedBundle?.metrics?.NQS ?? {}).includes('research');
      if (aggregatedRun.status === 'done' && typeof nqs?.value === 'number' && Math.abs(nqs.value - expected) < 1e-6 && policyVisible) {
        ok(`assessments/generic: research aggregation over the declared weights and components gives ${expected}, with the policy and its advisory note visible`);
      } else {
        fail(`assessments/generic/aggregate: status=${aggregatedRun.status}, value=${nqs?.value}, expected=${expected}, policy=${policyVisible}, error=${aggregatedRun.error}, stdout=${String(aggregatedRun.log?.stdout ?? '').trim().split('\n').pop()?.slice(0, 160)}`);
      }

      // No intention, no aggregate: the components stand and the report says what is missing.
      const noIntention = await startAssessment({ universeId: universe.id, phase: 'metrics', annotations: judged, aggregate: true });
      await settleAssessments();
      const noIntentionRun = await readAssessment(universe.id, noIntention.run_id);
      const noIntentionBundle = await readFile(join(assessmentsRoot(), noIntentionRun.result_dir, 'assessment.json'), 'utf8').then(JSON.parse, () => null);
      const reason = String(noIntentionBundle?.metrics?.NQS?.missing_reason ?? '');
      if (noIntentionRun.status === 'done' && (noIntentionBundle?.metrics?.NQS?.value ?? null) === null && /intention/i.test(reason)) {
        ok(`assessments/generic: without a stated intention the aggregate is unavailable with its reason (${reason.slice(0, 56)}…) instead of an invented intention`);
      } else {
        fail(`assessments/generic/intention: status=${noIntentionRun.status}, value=${noIntentionBundle?.metrics?.NQS?.value}, reason=${reason}, error=${noIntentionRun.error}`);
      }

      // A supplied profile keeps working exactly as it did: the generic default never overrides it.
      const supplied = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE , mode: 'deterministic' });
      await settleAssessments();
      const suppliedRun = await readAssessment(universe.id, supplied.run_id);
      if (suppliedRun.status === 'done' && suppliedRun.profile_source === 'supplied') {
        ok('assessments/generic: a supplied profile is used unchanged, and the run records where its profile came from');
      } else {
        fail(`assessments/generic/supplied: status=${suppliedRun.status}, source=${suppliedRun.profile_source}, error=${suppliedRun.error}`);
      }
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

  // C36: the inputs a caller declares reach the phase that consumes them. The packet carries them with
  // hashes, the child process is told where they lie, and an input a phase does not support is refused
  // instead of ignored.
  {
    const liveVersion = await currentVersion(universe.id);
    const firstChapterText = await readFile(join(universeDir(universe.id), 'chapters', '0001-one.md'), 'utf8');
    const secondChapterText = await readFile(join(universeDir(universe.id), 'chapters', '0002-two.md'), 'utf8');
    const annotations = {
      schema_version: 'annotations.v1',
      source_version: liveVersion,
      request: 'the reader asked for a quieter chapter',
      brief: 'prefer restraint over escalation',
      evidence: [
        { id: 'ev1', file: 'chapters/0001-one.md', sha256: sha256hex(await readFile(join(universeDir(universe.id), 'chapters', '0001-one.md'))), start: 0, end: 40, quote: firstChapterText.slice(0, 40) },
        { id: 'ev2', file: 'chapters/0002-two.md', sha256: sha256hex(await readFile(join(universeDir(universe.id), 'chapters', '0002-two.md'))), start: 0, end: 30, quote: secondChapterText.slice(0, 30) }
      ],
      segments: [],
      metrics: {
        CS: {
          status: 'judged',
          evaluator: 'annotator-1',
          dimensions: {
            referential_clarity: { rating: 4, rationale: 'every referent is recoverable', evidence: ['ev1'] },
            discourse_connection: { rating: 3, rationale: 'the two chapters connect through the ledger', evidence: ['ev2'] },
            causal_support: { rating: 3, rationale: 'the debt causes the interest', evidence: ['ev1'] },
            temporal_intelligibility: { rating: 4, rationale: 'the order survives the rearrangement', evidence: ['ev2'] }
          }
        }
      }
    };
    const plain = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, force: true , mode: 'deterministic' });
    await settleAssessments();
    const plainBundle = await readFile(join(assessmentsRoot(), (await readAssessment(universe.id, plain.run_id)).result_dir, 'assessment.json'), 'utf8').then(JSON.parse, () => null);
    const annotated = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, annotations, force: true });
    await settleAssessments();
    const annotatedRun = await readAssessment(universe.id, annotated.run_id);
    const annotatedBundle = await readFile(join(assessmentsRoot(), annotatedRun.result_dir, 'assessment.json'), 'utf8').then(JSON.parse, () => null);
    const named = (annotatedBundle?.provenance?.files ?? []).some((file) => file.role === 'annotations');
    const component = (bundle) => bundle?.metrics?.CS?.value ?? null;
    const changed = annotatedRun.status === 'done' && named
      && component(annotatedBundle) !== null && component(annotatedBundle) !== component(plainBundle)
      && annotatedRun.annotations_sha256 !== null && (annotatedRun.inputs ?? []).some((input) => input.role === 'annotations');
    if (changed) {
      ok(`assessments/inputs: a declared annotation reaches the metrics phase, is captured with its hash, appears in provenance and moves the semantic component (${component(plainBundle)} → ${component(annotatedBundle)})`);
    } else {
      fail(`assessments/inputs/annotations: plain=${component(plainBundle)}, annotated=${component(annotatedBundle)}, named=${named}, status=${annotatedRun.status}, error=${annotatedRun.error}, stdout=${String(annotatedRun.log?.stdout ?? '').trim().split('\n').pop()?.slice(0, 200)}`);
    }

    // A corpus with its referenced text: the comparison becomes possible, and its resource is captured.
    const referenceText = `A comparison text that borrows one passage: ${(await readFile(join(universeDir(universe.id), 'chapters', '0001-one.md'), 'utf8')).split('\n')[2]?.slice(0, 120) ?? 'no passage'}\n`;
    const corpus = {
      manifest: {
        schema_version: 'corpus.v1',
        references: [{ id: 'ref-1', path: 'reference-1.txt', sha256: sha256hex(referenceText), language: 'en', provenance: 'synthetic check fixture', permitted_use: 'comparison' }]
      },
      files: { 'reference-1.txt': referenceText }
    };
    const withCorpus = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, corpus, force: true , mode: 'deterministic' });
    await settleAssessments();
    const corpusRun = await readAssessment(universe.id, withCorpus.run_id);
    const corpusBundle = await readFile(join(assessmentsRoot(), corpusRun.result_dir, 'assessment.json'), 'utf8').then(JSON.parse, () => null);
    const top = corpusBundle?.metrics?.TOP ?? null;
    const si = corpusBundle?.metrics?.SI ?? null;
    const corpusNamed = (corpusBundle?.provenance?.corpus?.references ?? []).some((reference) => reference.id === 'ref-1');
    const resources = corpusRun.resources ?? [];
    const resourceHash = resources.find((resource) => resource.path === 'corpus/reference-1.txt')?.sha256 ?? null;
    const corpusCaptured = (corpusRun.inputs ?? []).some((input) => input.role === 'corpus')
      && resourceHash !== null && resourceHash === sha256hex(referenceText);
    // An independently known property of the fixture: the reference embeds part of the book and not all
    // of it, so a working comparison must land strictly between "no shared run" and "the whole text".
    if (corpusRun.status === 'done' && corpusNamed && corpusCaptured
      && top?.status === 'computed' && !top.missing_reason
      && typeof top.value === 'number' && top.value > 0 && top.value < 100
      && si?.status === 'computed' && typeof si.value === 'number' && si.value > 0 && si.value < 100) {
      ok(`assessments/inputs: a declared corpus is captured with its reference text (hash ${resourceHash.slice(0, 12)}…), named in provenance, and turns the lexical comparison on (TOP ${top.value.toFixed(2)}, SI ${si.value.toFixed(2)})`);
    } else {
      fail(`assessments/inputs/corpus: status=${corpusRun.status}, named=${corpusNamed}, captured=${corpusCaptured}, resources=${JSON.stringify(resources)}, TOP=${JSON.stringify(top?.status)}/${top?.value}, SI=${JSON.stringify(si?.status)}, error=${corpusRun.error}, stdout=${String(corpusRun.log?.stdout ?? '').trim().split('\n').pop()?.slice(0, 220)}`);
    }

    // A corpus with no supplied text is refused at capture, before any phase runs.
    let missing = 'accepted';
    try {
      await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, corpus: { manifest: corpus.manifest }, force: true, mode: 'deterministic' });
    } catch (error) {
      missing = error.code;
    }
    // An input the phase does not consume is refused too.
    let unsupported = 'accepted';
    try {
      await startAssessment({ universeId: universe.id, phase: 'continuity', corpus , mode: 'deterministic' });
    } catch (error) {
      unsupported = error.code;
    }
    let unsupportedProfile = 'accepted';
    try {
      await startAssessment({ universeId: universe.id, phase: 'continuity', profile: PROFILE , mode: 'deterministic' });
    } catch (error) {
      unsupportedProfile = error.code;
    }
    if (missing === 'MISSING_RESOURCE' && unsupported === 'UNSUPPORTED_INPUT' && unsupportedProfile === 'UNSUPPORTED_INPUT') {
      ok('assessments/inputs: a corpus without its referenced text is refused with MISSING_RESOURCE, and an input a phase does not consume is refused with UNSUPPORTED_INPUT');
    } else {
      fail(`assessments/inputs/refusals: missing=${missing}, corpusToContinuity=${unsupported}, profileToContinuity=${unsupportedProfile}`);
    }

    // Invalid annotation and corpus data fail through the host exactly as they do through the CLI.
    const brokenAnnotations = {
      schema_version: 'annotations.v1',
      source_version: liveVersion,
      metrics: {
        CS: {
          status: 'judged',
          evaluator: 'annotator-1',
          dimensions: { referential_clarity: { rating: 3, rationale: 'cites evidence that was never declared', evidence: ['ev-missing'] } }
        }
      }
    };
    const brokenAnnotationRun = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, annotations: brokenAnnotations, force: true });
    await settleAssessments();
    const brokenSettled = await readAssessment(universe.id, brokenAnnotationRun.run_id);
    const brokenCorpusRun = await startAssessment({
      universeId: universe.id,
      phase: 'metrics',
      profile: PROFILE,
      corpus: { manifest: { schema_version: 'corpus.v1', references: [{ id: 'ref-x', path: 'reference-x.txt', sha256: sha256hex('one text'), language: 'en' }] }, files: { 'reference-x.txt': 'a different text' } },
      force: true
    }).catch((error) => ({ run_id: null, error: error.code }));
    await settleAssessments();
    const brokenCorpusSettled = brokenCorpusRun.run_id ? await readAssessment(universe.id, brokenCorpusRun.run_id) : null;
    const annotationsRefused = brokenSettled.status === 'error' && Boolean(brokenSettled.error);
    const corpusRefused = brokenCorpusRun.error === 'HASH_MISMATCH' || brokenCorpusSettled?.status === 'error';
    if (annotationsRefused && corpusRefused) {
      ok(`assessments/inputs: invalid annotations (${String(brokenSettled.error).slice(0, 40)}…) and a corpus whose text does not match its declared hash are refused, not reported as reviews`);
    } else {
      fail(`assessments/inputs/invalid: annotations=${brokenSettled.status}/${String(brokenSettled.error).slice(0, 40)}, corpus=${brokenCorpusRun.error ?? brokenCorpusSettled?.status}`);
    }

    // Continuity accepts its own annotations.
    const continuityAnnotated = await startAssessment({ universeId: universe.id, phase: 'continuity', annotations, force: true });
    await settleAssessments();
    const continuitySettled = await readAssessment(universe.id, continuityAnnotated.run_id);
    const continuityNamed = (continuitySettled.inputs ?? []).some((input) => input.role === 'annotations');
    if (continuitySettled.status === 'done' && continuityNamed) {
      ok('assessments/inputs: the continuity phase receives its declared annotations, captured inside the packet');
    } else {
      fail(`assessments/inputs/continuity: status=${continuitySettled.status}, named=${continuityNamed}, error=${continuitySettled.error}`);
    }

    // The inventory of the packet matches the files on disk: nothing is declared that does not exist.
    {
      const packetInput = join(assessmentsRoot(), corpusRun.input_dir);
      const declared = new Set((corpusRun.inputs ?? []).map((input) => input.path));
      const onDisk = [];
      const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) await walk(path);
          else onDisk.push(relative(packetInput, path));
        }
      };
      await walk(packetInput);
      const manifest = await readFile(join(packetInput, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
      const manifestPaths = new Set((manifest?.files ?? []).map((file) => file.path));
      const resourcePaths = new Set((corpusRun.resources ?? []).map((resource) => resource.path));
      const undeclared = onDisk.filter((path) => path !== 'manifest.json' && !manifestPaths.has(path) && !resourcePaths.has(path));
      const absent = [...manifestPaths].filter((path) => !onDisk.includes(path));
      const declaredPresent = [...declared].every((path) => manifestPaths.has(path));
      if (undeclared.length === 0 && absent.length === 0 && declaredPresent && manifestPaths.size >= 5) {
        ok(`assessments/inputs: the packet inventory matches the files on disk exactly (${manifestPaths.size} files, declared inputs included)`);
      } else {
        fail(`assessments/inputs/inventory: undeclared=${JSON.stringify(undeclared)}, absent=${JSON.stringify(absent)}, declaredPresent=${declaredPresent}`);
      }
    }
  }

  await runAssessmentAnnotationChecks({ ok, fail, universe });

  // C37: the identity of a run is the evidence it reviewed, not the fact that some annotation was
  // present. Changed evidence gives a different run; identical simultaneous requests converge on one;
  // a record written before identities existed is never treated as a duplicate.
  {
    const base = { schema_version: 'annotations.v1', source_version: await currentVersion(universe.id) };
    const one = { ...base, request: 'the reader asked for a quieter chapter' };
    const two = { ...base, request: 'the reader asked for a faster chapter' };
    const first = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, annotations: one });
    const second = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, annotations: two });
    await settleAssessments();
    const firstSettled = await readAssessment(universe.id, first.run_id);
    const secondSettled = await readAssessment(universe.id, second.run_id);
    const different = first.run_id !== second.run_id
      && firstSettled.input_fingerprint?.startsWith('sha256:')
      && secondSettled.input_fingerprint !== firstSettled.input_fingerprint
      && secondSettled.annotations_sha256 !== firstSettled.annotations_sha256;
    if (different) {
      ok('assessments/identity: two requests that differ only in the annotation text produce two runs with different fingerprints');
    } else {
      fail(`assessments/identity/annotations: ${first.run_id} vs ${second.run_id}, fingerprints ${firstSettled.input_fingerprint} / ${secondSettled.input_fingerprint}`);
    }

    // The same corpus with different bytes is a different review, even though the manifest path is the same.
    const textA = 'A reference text about a ledger that is read aloud in a district of stone.';
    const textB = 'A reference text about a harbour that forgets the names of its ships.';
    const corpusFor = (text) => ({
      manifest: { schema_version: 'corpus.v1', references: [{ id: 'ref-1', path: 'reference-1.txt', sha256: sha256hex(text), language: 'en', permitted_use: 'comparison' }] },
      files: { 'reference-1.txt': text }
    });
    const corpusA = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, corpus: corpusFor(textA) , mode: 'deterministic' });
    const corpusB = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, corpus: corpusFor(textB) , mode: 'deterministic' });
    await settleAssessments();
    const corpusASettled = await readAssessment(universe.id, corpusA.run_id);
    const corpusBSettled = await readAssessment(universe.id, corpusB.run_id);
    // The manifest declares the hash of its own text, so different bytes give a different manifest as
    // well: the pair is a different review twice over. The stronger case — same manifest, changed bytes —
    // cannot reach a run at all, because the capture refuses a resource that does not match the hash the
    // manifest declares (checked above).
    const corpusDiffers = corpusA.run_id !== corpusB.run_id
      && corpusASettled.corpus_manifest_sha256 !== corpusBSettled.corpus_manifest_sha256
      && corpusASettled.resources?.[0]?.sha256 !== corpusBSettled.resources?.[0]?.sha256
      && corpusASettled.input_fingerprint !== corpusBSettled.input_fingerprint;
    if (corpusDiffers) {
      ok('assessments/identity: a corpus with different reference bytes is a different review, in the manifest hash, the resource hash and the fingerprint');
    } else {
      fail(`assessments/identity/corpus: ${corpusA.run_id} vs ${corpusB.run_id}, manifest differs=${corpusASettled.corpus_manifest_sha256 !== corpusBSettled.corpus_manifest_sha256}, resources ${corpusASettled.resources?.[0]?.sha256} / ${corpusBSettled.resources?.[0]?.sha256}`);
    }

    // A different scope is a different review.
    const chapterProfile = { ...PROFILE, profile_id: 'check-assessments-chapter', scope: { kind: 'chapter', chapters: [1], context_chapters: [] } };
    const scoped = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: chapterProfile , mode: 'deterministic' });
    await settleAssessments();
    const scopedSettled = await readAssessment(universe.id, scoped.run_id);
    const bookSettled = await readAssessment(universe.id, second.run_id);
    if (scoped.run_id !== second.run_id && scopedSettled.requested_scope?.kind === 'chapter'
      && bookSettled.requested_scope?.kind === 'book' && scopedSettled.input_fingerprint !== bookSettled.input_fingerprint) {
      ok('assessments/identity: the resolved scope is recorded and part of the identity (chapter scope reviewed separately from the whole book)');
    } else {
      fail(`assessments/identity/scope: chapter=${scopedSettled.requested_scope?.kind}, book=${bookSettled.requested_scope?.kind}, fingerprints differ=${scopedSettled.input_fingerprint !== bookSettled.input_fingerprint}`);
    }

    // Simultaneous identical requests: one record, one review.
    const simultaneous = await Promise.all([
      startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, annotations: one }),
      startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, annotations: one }),
      startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, annotations: one })
    ]);
    await settleAssessments();
    const ids = new Set(simultaneous.map((run) => run.run_id));
    const runsForIdentity = (await listAssessments(universe.id)).filter((run) => run.input_fingerprint === firstSettled.input_fingerprint);
    if (ids.size >= 1 && simultaneous.every((run) => run.run_id === first.run_id) && runsForIdentity.length === 1) {
      ok('assessments/identity: three simultaneous identical requests converge on the run that already existed, with one record');
    } else {
      fail(`assessments/identity/simultaneous: returned=${[...ids].join(',')}, expected ${first.run_id}, records=${runsForIdentity.length}`);
    }

    // A record without a fingerprint is not a duplicate of anything.
    {
      const legacyId = '20260922T120002-metrics-legacy';
      const directory = join(workspaceUniverse, (await currentVersion(universe.id)).replace(/^sha256:/, 'sha256-'), legacyId);
      await mkdir(directory, { recursive: true });
      const legacy = {
        schema_version: 'assessment-run.v1',
        run_id: legacyId,
        universe_id: universe.id,
        phase: 'metrics',
        trigger: 'requested',
        arc_id: null,
        version: firstSettled.version,
        scope: firstSettled.scope,
        requested_scope: firstSettled.requested_scope,
        profile_sha256: firstSettled.profile_sha256,
        annotations: true,
        annotations_sha256: firstSettled.annotations_sha256,
        corpus_manifest_sha256: null,
        resources: [],
        input_dir: firstSettled.input_dir,
        result_dir: firstSettled.result_dir,
        status: 'done',
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
        exit_code: 0,
        error: null,
        outputs: [],
        historical: false
      };
      await writeFile(join(directory, 'run.json'), JSON.stringify(legacy), 'utf8');
      const fresh = await startAssessment({ universeId: universe.id, phase: 'metrics', profile: PROFILE, annotations: one });
      await settleAssessments();
      const legacyRuns = (await listAssessments(universe.id)).filter((run) => run.run_id === legacyId);
      await rm(directory, { recursive: true, force: true });
      if (fresh.run_id === first.run_id && legacyRuns.length === 1 && legacyRuns[0].input_fingerprint === undefined) {
        ok('assessments/identity: a record written before fingerprints existed is not proven a duplicate, and the request matches only the run with the same identity');
      } else {
        fail(`assessments/identity/legacy: matched=${fresh.run_id} (expected ${first.run_id}), legacy records=${legacyRuns.length}`);
      }
    }

    // Ordering is by creation time, with a stable tie-breaker.
    {
      const listed = await listAssessments(universe.id);
      const ordered = listed.every((run, index) => index === 0
        || String(listed[index - 1].created_at) >= String(run.created_at)
        || listed[index - 1].created_at === run.created_at);
      const sortedOnce = listed.map((run) => run.run_id).join(',');
      const again = (await listAssessments(universe.id)).map((run) => run.run_id).join(',');
      if (ordered && sortedOnce === again && listed.length >= 8) {
        ok(`assessments/identity: ${listed.length} runs are listed newest first by creation time, deterministically`);
      } else {
        fail(`assessments/identity/order: ordered=${ordered}, stable=${sortedOnce === again}, runs=${listed.length}`);
      }
    }
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
      const first = await declareArcCompletion({ universeId: universe.id, arcId: 'arc-ledger', note: 'the district answers', profile: PROFILE , mode: 'deterministic' });
      await settleAssessments();
      const second = await declareArcCompletion({ universeId: universe.id, arcId: 'arc-ledger', profile: PROFILE , mode: 'deterministic' });
      const events = await listArcEvents(universe.id);
      const runsForArc = (await listAssessments(universe.id)).filter((run) => run.arc_id === 'arc-ledger');
      // The bundle must name the event that caused it, and the same report asked for by hand must name a
      // reader request: the two vocabularies meet in `src/assessments.mjs` and nowhere else.
      const arcBundle = await readFile(join(assessmentsRoot(), runsForArc[0].result_dir, 'assessment.json'), 'utf8').then(
        (text) => JSON.parse(text),
        () => null
      );
      const requestedBundle = await readFile(join(assessmentsRoot(), metricsRun.result_dir, 'assessment.json'), 'utf8').then(
        (text) => JSON.parse(text),
        () => null
      );
      const arcProvenance = arcBundle?.trigger === 'arc' && arcBundle?.trigger_ref?.arc_id === 'arc-ledger';
      const requestedProvenance = requestedBundle?.trigger === 'request' && requestedBundle?.trigger_ref?.kind === 'request';
      if (first.event.version.startsWith('sha256:') && events.length === 1 && runsForArc.length === 1 && second.run?.deduplicated === true
        && arcProvenance && requestedProvenance) {
        ok('assessments: an arc-completion event records the stable arc id and the accepted version, its report names that event rather than a reader request, and the assessment is deduplicated by arc, version and profile');
      } else {
        fail(`assessments/arc: version=${first.event.version}, events=${events.length}, runs=${runsForArc.length}, second=${second.run?.deduplicated}, arc=${arcBundle?.trigger}/${arcBundle?.trigger_ref?.arc_id}, requested=${requestedBundle?.trigger}/${requestedBundle?.trigger_ref?.kind}`);
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
