// The regression group of `scripts/check.mjs` (correction C84): the boundaries the review of the review
// subsystem named, each exercised through the artifact the product publishes rather than through a
// success envelope.
//
// The report boundaries run `buildReportFixture` and `runReport` from the metrics skill's own test
// folder — the same fixture the skill suite uses, so a check cannot drift away from it — and read the
// published bundle, the published views and the CLI's own error envelope. The host boundaries build a
// real temporary universe with the store's functions and read the run records back.
//
// Nothing here treats `exit 0` as proof: an exit code is only ever read together with the document that
// was or was not published, with the code the envelope names, or with the value the bundle carries.
import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAPTER_1, buildReportFixture } from '../skills/scripta-metrics-report/tests/report-fixture.mjs';
import { runReport } from '../skills/scripta-metrics-report/tests/helpers.mjs';
import { bookWithTwoChapters } from './check-fixtures.mjs';
import { buildAnnotationPrompt } from '../src/annotation-prompt.mjs';
import { listAssessments, readAssessment, startAssessment } from '../src/assessments.mjs';
import { currentVersion } from '../src/assessment-packet.mjs';

/** The research profile every aggregate assertion below is read against. */
const AGGREGATE = {
  enabled: true,
  policy: 'research',
  weights: { cs: 0.4, oi: 0.35, emotional_fit: 0.25 },
  emotional_fit: { procedure: 'separate-judgement', intent: 'a quiet elegiac aftermath' },
  scope: 'chapter 1',
  rubric_version: 'rubric-anchors.v1',
  corpus_version: 'corpus.v1'
};

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function readTextOr(file, fallback = '') {
  return readFile(file, 'utf8').catch(() => fallback);
}

/** Collect the stated problems: every entry is either `true` (the boundary held) or the reason it did not. */
function problemsOf(checks) {
  return checks.filter((entry) => entry !== true);
}

/** Run one report fixture and read back what it published, or what it refused with. */
async function report(root, name, options, extra = {}) {
  const fx = buildReportFixture(join(root, name), options);
  const out = join(root, `${name}-out`);
  const env = runReport(fx, out, extra);
  const published = join(out, 'assessment.json');
  const bundle = await readJson(published).catch(() => null);
  const views = new Map();
  if (bundle) {
    for (const file of await readdir(out).catch(() => [])) {
      views.set(file, await readTextOr(join(out, file)));
    }
  }
  return { fx, env, out, bundle, views };
}

/**
 * The report boundaries: what the correction asked the review to prove about its own artifacts. Each
 * block states the boundary it reproduces, then the observable that has to hold.
 */
async function reportBoundaries({ ok, fail, root }) {
  // The exact EAP shape the annotation prompt requests. The prompt text and the consumer are two
  // independently written halves of one contract, so the check reads the prompt first and then builds
  // the document it asks for: a trajectory record per declared segment with segment_id, valence,
  // tension, evidence and uncertainty, an optional story_order that obliges `ordering: story`, and a
  // separate emotional_fit with its fit, rationale, evidence and intention_binding.
  {
    const prompt = buildAnnotationPrompt({
      book: { title: 'The Ledger District', language: 'ro', last_accepted_chapter: 2 },
      scope: { kind: 'chapter', chapters: [1] },
      readingList: {
        selected: [{ path: 'chapters/0001.md' }],
        context: [{ path: 'chapters/0002.md' }],
        omitted: []
      },
      coverage: { chapters: [1], version: 'sha256:fixture' },
      model: 'check/model'
    });
    const requested = ['segment_id', 'valence', 'tension', 'uncertainty', 'story_order', 'ordering', 'emotional_fit', 'intention_binding'];
    const unrequested = requested.filter((field) => !prompt.includes(field));

    const asked = {
      ordering: 'story',
      trajectory: [
        { segment_id: 'seg1', story_order: 1, focalization: 'marinarul', valence: 1, tension: 2, evidence: ['ev1'], uncertainty: 'The lift may be relief rather than hope.' },
        { segment_id: 'seg2', story_order: 0, focalization: 'marinarul', valence: -1, tension: 0, evidence: ['ev3'], uncertainty: 'The quiet register could also read as exhaustion.' }
      ],
      emotional_fit: {
        status: 'judged',
        evaluator: 'human-1',
        fit: 55,
        rationale: 'The register answers the elegiac intention.',
        evidence: ['ev1'],
        intention_binding: 'a quiet elegiac aftermath'
      }
    };
    const shaped = await report(root, 'eap-shape', {
      profile: { aggregation: AGGREGATE },
      // Both declared segments are inside the selection, so a trajectory that follows the prompt
      // assesses the whole of it: chapter 2 is read here, not kept as context.
      profileScopeKind: 'book',
      scopeChapters: [1, 2],
      contextChapters: [],
      annotations: (annotations) => { annotations.metrics.EAP = { status: 'judged', evaluator: 'human-1', ...asked }; }
    });

    // The same document with the `uncertainty` sentence the prompt requires left out: the report must
    // refuse the incomplete series instead of publishing a trajectory with a hole in it.
    const holed = await report(root, 'eap-hole', {
      profileScopeKind: 'book',
      scopeChapters: [1, 2],
      contextChapters: [],
      annotations: (annotations) => {
        annotations.metrics.EAP = { status: 'judged', evaluator: 'human-1', ...asked };
        delete annotations.metrics.EAP.trajectory[0].uncertainty;
      }
    });

    const eap = shaped.bundle?.metrics?.EAP;
    const chronology = (eap?.trajectory ?? []).map((point) => point.segment_id).join(',');
    const nqs = shaped.bundle?.metrics?.NQS;
    const justification = shaped.views.get('04-score-justification.md') ?? '';
    const problems = problemsOf([
      unrequested.length === 0 || `the prompt never asks for ${unrequested.join(', ')}`,
      shaped.env.status === 0 || `the shaped document was refused (status ${shaped.env.status}, ${shaped.env.envelope?.code})`,
      eap?.status === 'judged' || `EAP status ${eap?.status}`,
      eap?.ordering === 'story' || `EAP ordering ${eap?.ordering}`,
      chronology === 'seg2,seg1' || `trajectory ${chronology} is not the declared chronology`,
      eap?.detail?.ordering_normalized === true || `ordering_normalized ${eap?.detail?.ordering_normalized}`,
      eap?.coverage === 1 || `EAP coverage ${eap?.coverage} of the selected segments`,
      (eap?.detail?.assessed_segments ?? []).length === 2 || `assessed segments ${JSON.stringify(eap?.detail?.assessed_segments)}`,
      // The separately judged emotional fit is consumed by the aggregate, which shows its arithmetic.
      nqs?.status === 'computed' || `NQS ${nqs?.status} (${nqs?.missing_reason ?? 'no reason'})`,
      String(nqs?.detail?.arithmetic ?? '').includes('0.25 * 55') || `the aggregate arithmetic never used the declared fit 55: ${nqs?.detail?.arithmetic}`,
      justification.includes('55') || 'the published justification does not show the fit the aggregate consumed',
      holed.env.status === 2 && holed.env.envelope?.code === 'INVALID_ANNOTATIONS' || `an uncertainty-free point answered status ${holed.env.status}/${holed.env.envelope?.code}`,
      !(await stat(join(holed.out, 'assessment.json')).then(() => true, () => false)) || 'the refused series was published anyway'
    ]);
    if (problems.length === 0) {
      ok(`regressions/eap-shape: the EAP document the annotation prompt asks for (${requested.length} requested fields, one point per declared segment) is accepted, its series is published in the declared chronology (${chronology}) with coverage 1 and its emotional fit (55) inside the aggregate arithmetic, while a point missing the requested \`uncertainty\` sentence is refused with INVALID_ANNOTATIONS and publishes nothing`);
    } else {
      fail(`regressions/eap-shape: ${problems.join('; ')}`);
    }
  }

  // Unavailable and errored aggregate inputs. A component that is not assessable is a result, not a
  // zero: NQS stays unavailable with the reason naming which prerequisite is missing, the diagnostics
  // of the aggregate are kept, and the published view says so instead of printing a number.
  {
    const fixture = await report(root, 'nqs-inputs', {
      profile: { aggregation: AGGREGATE },
      annotations: (annotations) => {
        // The judgement could not be made: the dimensions stay in the document, the status says so and
        // the reason travels with the result instead of being replaced by an empty score.
        annotations.metrics.CS.status = 'not_assessable';
        annotations.metrics.CS.missing_reason = 'The selected scene was too short to judge cohesion.';
        annotations.metrics.OI.status = 'error';
        annotations.metrics.OI.missing_reason = 'The evaluator call failed before it judged originality.';
        annotations.metrics.EAP.status = 'not_assessable';
        annotations.metrics.EAP.missing_reason = 'No segment of the selection carried a trajectory point.';
      }
    });
    const metrics = fixture.bundle?.metrics ?? {};
    const reason = String(metrics.NQS?.missing_reason ?? '');
    const justification = fixture.views.get('04-score-justification.md') ?? '';
    const metricsView = fixture.views.get('03-metrics-and-indicators.md') ?? '';
    const problems = problemsOf([
      fixture.env.status === 0 || `the fixture was refused (${fixture.env.envelope?.code})`,
      metrics.CS?.status === 'not_assessable' && metrics.CS?.value === null || `CS ${metrics.CS?.status}/${metrics.CS?.value}`,
      metrics.CS?.missing_reason === 'The selected scene was too short to judge cohesion.' || `the unavailable CS reports ${JSON.stringify(metrics.CS?.missing_reason)}`,
      metrics.OI?.status === 'error' && metrics.OI?.value === null || `an errored OI publishes ${metrics.OI?.status}/${metrics.OI?.value}`,
      metrics.OI?.missing_reason === 'The evaluator call failed before it judged originality.' || `the errored OI reports ${JSON.stringify(metrics.OI?.missing_reason)}`,
      metrics.EAP?.value === null || `EAP value ${metrics.EAP?.value}`,
      metrics.NQS?.status === 'not_assessable' || `NQS status ${metrics.NQS?.status}`,
      metrics.NQS?.value === null || `NQS value ${metrics.NQS?.value}`,
      reason.includes('CS') && reason.includes('OI') || `the NQS reason does not name the missing inputs: ${reason}`,
      metrics.NQS?.detail?.weights?.cs === 0.4 || 'the aggregate kept no diagnostic of its declared weights',
      justification.includes(reason.slice(0, 24)) || 'the published justification does not carry the reason NQS is unavailable',
      /unavailable/i.test(metricsView) || 'the published metric view does not mark the unavailable result as unavailable',
      metricsView.includes('The selected scene was too short'.slice(0, 24)) || 'the published metric view hides the reason CS was not scored'
    ]);
    if (problems.length === 0) {
      ok(`regressions/nqs-inputs: an unavailable CS ("${metrics.CS.missing_reason.slice(0, 40)}…"), an errored OI and an EAP with no trajectory point leave NQS unavailable with its reason naming CS and OI, keep the declared weights as diagnostics, and reach the published views as unavailable with their own reasons — never as a zero`);
    } else {
      fail(`regressions/nqs-inputs: ${problems.join('; ')}`);
    }
  }

  // Evidence outside the text the review was asked to read. A quotation from a chapter that was not
  // selected is refused; the same quotation from a declared context chapter does not score, it demotes
  // the judgement to an unavailable result that carries the reason.
  {
    const cite = (id) => (annotations) => {
      for (const dimension of Object.values(annotations.metrics.CS.dimensions)) dimension.evidence = [id];
    };
    const outOfSelection = await report(root, 'evidence-out', { scopeChapters: [1], contextChapters: [], annotations: cite('ev3') });
    const contextOnly = await report(root, 'evidence-context', { scopeChapters: [1], contextChapters: [2], annotations: cite('ev3') });
    const metrics = contextOnly.bundle?.metrics ?? {};
    const metricsView = contextOnly.views.get('03-metrics-and-indicators.md') ?? '';
    const problems = problemsOf([
      outOfSelection.env.status === 2 && outOfSelection.env.envelope?.code === 'EVIDENCE_OUT_OF_SCOPE'
        || `an out-of-selection quotation answered ${outOfSelection.env.status}/${outOfSelection.env.envelope?.code}`,
      String(outOfSelection.env.envelope?.error ?? '').includes('ev3') || 'the refusal does not name the evidence it refuses',
      !(await stat(join(outOfSelection.out, 'assessment.json')).then(() => true, () => false)) || 'the refused report was published anyway',
      contextOnly.env.status === 0 || `the context-only fixture was refused (${contextOnly.env.envelope?.code})`,
      metrics.CS?.status === 'not_assessable' && metrics.CS?.value === null || `context-only CS ${metrics.CS?.status}/${metrics.CS?.value}`,
      /context/i.test(String(metrics.CS?.missing_reason ?? '')) || `the demoted judgement does not say why: ${metrics.CS?.missing_reason}`,
      metrics.EAP?.status === 'judged' || `the untouched EAP lost its judgement (${metrics.EAP?.status})`,
      metricsView.includes(String(metrics.CS?.missing_reason ?? 'x').slice(0, 20)) || 'the published view hides why CS is unavailable'
    ]);
    if (problems.length === 0) {
      ok(`regressions/evidence-scope: a judgement resting on a quotation from an unselected chapter is refused with EVIDENCE_OUT_OF_SCOPE naming ev3 and publishes nothing, while the same quotation from a declared context chapter demotes CS to not_assessable (value ${metrics.CS.value}) with its reason published, leaving EAP judged`);
    } else {
      fail(`regressions/evidence-scope: ${problems.join('; ')}`);
    }
  }

  // Incomplete continuity totals. A declared total the population cannot support is refused; a
  // partition that examined one comparison out of a hundred publishes no index, states the population
  // it really reviewed and keeps the unexamined comparisons visible as unresolved.
  {
    const impossible = await report(root, 'continuity-impossible', {
      annotations: (annotations) => {
        annotations.continuity.counts = { eligible_comparisons: 1, consistent: 2, contradicted: 0, unresolved: 0 };
      }
    });
    const partial = await report(root, 'continuity-partial', {
      annotations: (annotations) => {
        annotations.continuity.counts = { eligible_comparisons: 100, consistent: 1, contradicted: 0, unresolved: 0 };
      }
    });
    const cci = partial.bundle?.metrics?.CCI;
    const index = partial.views.get('index.md') ?? '';
    const problems = problemsOf([
      impossible.env.status === 2 && impossible.env.envelope?.code === 'INVALID_ANNOTATIONS'
        || `totals the population cannot support answered ${impossible.env.status}/${impossible.env.envelope?.code}`,
      !(await stat(join(impossible.out, 'assessment.json')).then(() => true, () => false)) || 'the impossible totals were published anyway',
      partial.env.status === 0 || `the partial partition was refused (${partial.env.envelope?.code})`,
      cci?.value === null || `a partial population published a single index (${cci?.value})`,
      cci?.coverage === 0.01 || `coverage ${cci?.coverage}`,
      cci?.bounds?.lower === 1 && cci?.bounds?.upper === 100 || `bounds ${JSON.stringify(cci?.bounds)}`,
      cci?.detail?.partition?.unexamined === 99 || `unexamined ${cci?.detail?.partition?.unexamined}`,
      cci?.detail?.partition?.complete === false || 'a partition that examined one comparison of a hundred claims completeness',
      cci?.detail?.counts_source === 'declared_with_unexamined' || `counts source ${cci?.detail?.counts_source}`,
      index.includes('100') && index.includes('99') || 'the published index does not state the population it reviewed',
      (partial.bundle?.coverage?.continuity?.population ?? []).length > 0 || 'the report does not name the continuity population it counted'
    ]);
    if (problems.length === 0) {
      ok(`regressions/continuity-totals: totals above the population are refused with INVALID_ANNOTATIONS and nothing is written, while a partition of 1 consistent comparison among 100 publishes no CCI value, ${cci.coverage * 100}% coverage, bounds ${cci.bounds.lower}..${cci.bounds.upper} and ${cci.detail.partition.unexamined} comparisons carried as unresolved rather than as consistency`);
    } else {
      fail(`regressions/continuity-totals: ${problems.join('; ')}`);
    }
  }

  // An independent exact copy as a corpus reference. Identical bytes are the case overlap measurement
  // exists to find: a reference stays eligible and reports full overlap unless it declares the source
  // version it copies, and only that verified declaration excludes it from the measurement.
  {
    const independent = await report(root, 'corpus-copy', { referenceText: CHAPTER_1 });
    const declared = await report(root, 'corpus-self', {
      referenceText: CHAPTER_1,
      reference: (packet) => ({ source: { id: 'test-universe', version: packet.version } })
    });
    const si = independent.bundle?.metrics?.SI;
    const top = independent.bundle?.metrics?.TOP;
    const excluded = declared.bundle?.provenance?.corpus?.exclusions ?? [];
    const problems = problemsOf([
      independent.env.status === 0 || `the copy fixture was refused (${independent.env.envelope?.code})`,
      (independent.bundle?.provenance?.corpus?.exclusions ?? []).length === 0 || 'an undeclared copy was excluded as a self-comparison',
      si?.status === 'computed' && si?.value === 1 || `SI ${si?.status}/${si?.value} on an exact copy`,
      top?.status === 'computed' && top?.value === 100 || `TOP ${top?.status}/${top?.value} on an exact copy`,
      si?.detail?.pairs?.[0]?.reference === 'ref1' || 'the overlapping reference is not named',
      si?.detail?.pairs?.[0]?.duplicate_text === true || 'the copy is not reported as duplicate text',
      si?.detail?.pairs?.[0]?.identity?.status === 'unknown' || 'the copy is attributed a source identity it never declared',
      excluded.map((entry) => `${entry.id}:${entry.reason}`).join(',') === 'ref1:same_source_version'
        || `a declared and verified self-comparison was not excluded: ${JSON.stringify(excluded)}`,
      declared.bundle?.metrics?.SI?.status === 'not_assessable' && String(declared.bundle?.metrics?.SI?.missing_reason ?? '').includes('excluded')
        || `SI after the only reference was excluded: ${declared.bundle?.metrics?.SI?.status}`
    ]);
    if (problems.length === 0) {
      ok(`regressions/corpus-copy: an exact copy of a selected chapter that declares no source identity stays an eligible reference and measures SI 1 / TOP 100 with \`duplicate_text\` naming it, while the same bytes declaring the candidate's own source version are excluded as \`ref1:same_source_version\` and leave SI unavailable because every reference was excluded`);
    } else {
      fail(`regressions/corpus-copy: ${problems.join('; ')}`);
    }
  }
}

/**
 * Wait for a run to reach a settled state, by reading the record back. The wait is bounded on purpose:
 * a suite that waits forever on a run the host never settles reports nothing at all, so the check reads
 * the record and asserts on whatever state it holds when the deadline passes.
 */
async function settle(universeId, runId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await readAssessment(universeId, runId).catch(() => null);
    if (record && ['done', 'error', 'cancelled', 'interrupted'].includes(record.status)) return record;
    if (Date.now() > deadline) return record;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * The host boundaries: what a change of mode or of evaluator model does to the identity of a review.
 * The fingerprint is the only thing that decides whether a request is the same assessment, so the check
 * reads it back from the run records and never from the returned envelope.
 */
async function identityBoundaries({ ok, fail, root, checkSeed, tempDirs }) {
  const universe = await bookWithTwoChapters(`${checkSeed}-regression`, 'regression-identity');
  tempDirs.push(universe.id);

  const deterministic = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'deterministic' });
  const deterministicRecord = await settle(universe.id, deterministic.run_id);
  const again = await startAssessment({ universeId: universe.id, phase: 'metrics', mode: 'deterministic' });
  await settle(universe.id, deterministic.run_id);
  const supplied = await startAssessment({
    universeId: universe.id,
    phase: 'metrics',
    annotations: { schema_version: 'annotations.v1', source_version: await currentVersion(universe.id) }
  });
  const suppliedRecord = await settle(universe.id, supplied.run_id);

  // A generic run of each model, with an evaluator installed on PATH that records the model it was
  // launched with: the check asserts both halves — the identity differs, and the child really received
  // the requested model rather than the configured default.
  const fake = await installModelRecorder(root);
  let firstModel = null;
  let secondModel = null;
  let firstModelRecord = null;
  let secondModelRecord = null;
  try {
    firstModel = await startAssessment({
      universeId: universe.id,
      phase: 'metrics',
      mode: 'generic',
      annotationModel: 'check/model-a',
      force: true
    });
    firstModelRecord = await settle(universe.id, firstModel.run_id);
    secondModel = await startAssessment({
      universeId: universe.id,
      phase: 'metrics',
      mode: 'generic',
      annotationModel: 'check/model-b',
      force: true
    });
    secondModelRecord = await settle(universe.id, secondModel.run_id);
  } finally {
    await fake.restore();
  }
  const launched = await readdir(fake.dir).catch(() => []);
  const launches = [];
  for (const name of launched) {
    if (!name.startsWith('launch-')) continue;
    launches.push(await readJson(join(fake.dir, name)).catch(() => ({})));
  }
  const modelsLaunched = [...new Set(launches.map((entry) => entry.model))].sort().join(',');

  const problems = problemsOf([
    again.run_id === deterministic.run_id && again.deduplicated === true
      || `the same deterministic request returned ${again.run_id} (deduplicated ${again.deduplicated}) instead of the run that existed`,
    deterministicRecord.annotation_mode === 'deterministic' || `the deterministic record says ${deterministicRecord.annotation_mode}`,
    suppliedRecord.annotation_mode === 'supplied' || `the supplied record says ${suppliedRecord.annotation_mode}`,
    supplied.run_id !== deterministic.run_id || 'a supplied review reused the run of a deterministic one',
    suppliedRecord.input_fingerprint !== deterministicRecord.input_fingerprint
      || 'changing who produces the observations did not change the identity of the review',
    deterministicRecord.input_fingerprint?.startsWith('sha256:') || `the identity is not a hash (${deterministicRecord.input_fingerprint})`,
    firstModel.run_id !== secondModel.run_id && firstModelRecord.input_fingerprint !== secondModelRecord.input_fingerprint
      || `a change of evaluator model did not change the identity (${firstModel.run_id} / ${secondModel.run_id})`,
    firstModelRecord.annotation_model === 'check/model-a' && secondModelRecord.annotation_model === 'check/model-b'
      || `the records name ${firstModelRecord.annotation_model} and ${secondModelRecord.annotation_model}`,
    modelsLaunched === 'check/model-a,check/model-b'
      || `the evaluator children were launched with ${modelsLaunched || 'no recorded model'}`,
    launches.length >= 2 && launches.every((entry) => typeof entry.model === 'string' && entry.model.startsWith('check/model-'))
      || `a child was launched without the requested model: ${JSON.stringify(launches.map((entry) => entry.model))}`,
    firstModelRecord.input_fingerprint !== deterministicRecord.input_fingerprint
      || 'a generic review and a deterministic one over the same text share an identity',
    (await listAssessments(universe.id)).filter((run) => run.input_fingerprint === deterministicRecord.input_fingerprint).length === 1
      || 'the identity of the deterministic run matches more than one record'
  ]);
  if (problems.length === 0) {
    ok(`regressions/run-identity: mode and evaluator model are part of the identity — a repeated deterministic request deduplicated onto ${deterministic.run_id}, a supplied review and a generic review of the same packet are three different fingerprints, and the two generic runs launched the evaluator with ${modelsLaunched}`);
  } else {
    fail(`regressions/run-identity: ${problems.join('; ')}`);
  }
}

/**
 * An evaluator installed as `omp` that answers nothing usable and records the arguments it was
 * launched with. The generic runs of this group are about identity and launch, so the answer itself is
 * built by the group that owns the annotation stage; the marker is written to a directory the check
 * chose, because the child's own working directory belongs to the run.
 */
async function installModelRecorder(root) {
  const dir = await mkdtemp(join(root, 'model-recorder-'));
  const previousMarkerDir = process.env.CHECK_EVALUATOR_MARKER_DIR;
  process.env.CHECK_EVALUATOR_MARKER_DIR = dir;
  await writeFile(join(dir, 'recorder.mjs'), `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

if (process.argv.includes('--version')) { process.stdout.write('model-recorder/0.0.1\\n'); process.exit(0); }
process.stdin.resume();
await new Promise((resolve) => process.stdin.on('end', resolve));
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : null;
const marker = join(process.env.CHECK_EVALUATOR_MARKER_DIR, 'launch-' + String(process.pid) + '.json');
await writeFile(marker, JSON.stringify({ model, args: process.argv.slice(2) }), 'utf8');
process.stdout.write(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'no document' } }) + String.fromCharCode(10));
process.exit(0);
`, 'utf8');
  const shim = join(dir, 'omp');
  await writeFile(shim, '#!/bin/sh\nexec node "$(dirname "$0")/recorder.mjs" "$@"\n', 'utf8');
  await chmod(shim, 0o755);
  const previousPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${previousPath}`;
  return {
    dir,
    restore: async () => {
      process.env.PATH = previousPath;
      if (previousMarkerDir === undefined) delete process.env.CHECK_EVALUATOR_MARKER_DIR;
      else process.env.CHECK_EVALUATOR_MARKER_DIR = previousMarkerDir;
    }
  };
}

export async function runRegressionChecks({ ok, fail, checkSeed, tempDirs }) {
  const root = await mkdtemp(join(tmpdir(), `check-regressions-${checkSeed}-`));
  try {
    await reportBoundaries({ ok, fail, root });
    await identityBoundaries({ ok, fail, root, checkSeed, tempDirs });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
