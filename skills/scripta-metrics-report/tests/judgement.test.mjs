import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildAeg } from '../scripts/lib/timing.mjs';
import { buildCr } from '../scripts/lib/contamination.mjs';
import { buildNqs, checkNqs, parseAggregation, validateDependencyGraph } from '../scripts/lib/aggregate.mjs';
import { baseMetric, buildMetrics, computeCad, computeCci } from '../scripts/lib/metrics.mjs';
import { buildComponentMetric, buildEap, parseRubricProfile } from '../scripts/lib/rubric.mjs';
import { sha256, tempDir, cleanup, writeFile } from './helpers.mjs';

/** The judged-metric side of the same contract: aggregates, timing and contamination. */
const rubric = parseRubricProfile(undefined);
const scope = { kind: 'chapter', chapters: [1], segments: ['seg1'] };

function cs(dimensions) {
  return { status: 'judged', evaluator: 'human-1', dimensions };
}

function eapPoint(overrides) {
  return {
    segment_id: 'seg1',
    focalization: 'marinarul',
    valence: 0,
    tension: 1,
    evidence: ['ev1'],
    uncertainty: 'The register could read as exhaustion.',
    ...overrides,
  };
}

function rating(value, evidence = ['ev1']) {
  return { rating: value, rationale: `rating ${value}`, evidence };
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}


const weights = { cs: 0.4, oi: 0.35, emotional_fit: 0.25 };
const enabledProfile = (overrides = {}) => ({
  enabled: true,
  policy: 'research',
  weights,
  emotional_fit: { procedure: 'separate-judgement', intent: 'a quiet elegiac aftermath' },
  scope: 'chapters 1-2',
  corpus_version: 'corpus.v1',
  rubric_version: 'rubric-anchors.v1',
  ...overrides,
});

test('NQS is disabled by default', () => {
  const result = checkNqs({ enabled: false, values: { CS: 80, OI: 80, EMOTIONAL_FIT: 80 } });
  assert.equal(result.status, 'not_assessable');
  assert.ok(result.reason.includes('disabled by default'));
});

test('NQS never redistributes weights around missing inputs', () => {
  const result = checkNqs({ enabled: true, values: { CS: 80, OI: null, EMOTIONAL_FIT: 80 } });
  assert.equal(result.status, 'not_assessable');
  assert.deepEqual(result.missing, ['OI']);
});

test('NQS is computed from its components under a research profile, ignoring a free-standing value', () => {
  const aggregation = parseAggregation(enabledProfile());
  const metric = buildNqs({
    aggregation,
    values: { CS: 75, OI: 50, EMOTIONAL_FIT: 55 },
    scope,
    baseMetricFor: baseMetric,
    annotatedValue: 99,
  });
  assert.equal(metric.status, 'computed');
  assert.ok(Math.abs(metric.value - (0.4 * 75 + 0.35 * 50 + 0.25 * 55)) < 1e-9);
  assert.equal(metric.detail.annotated_value_ignored, 99);
  assert.ok(metric.detail.note.includes('research profile'));
  assert.equal(metric.qualified, true, 'a research profile is labelled experimental');
  assert.ok(metric.detail.arithmetic.includes('0.4 * 75'));
});

test('zero components cannot produce a high NQS: there is no penalty or bonus term', () => {
  const aggregation = parseAggregation(enabledProfile());
  const metric = buildNqs({ aggregation, values: { CS: 0, OI: 0, EMOTIONAL_FIT: 0 }, scope, baseMetricFor: baseMetric });
  assert.equal(metric.status, 'computed');
  assert.equal(metric.value, 0);
  assert.notEqual(metric.value, 99);
});

test('an absent emotional intention, an incompatible version or a missing input keeps NQS unavailable', () => {
  const noIntent = buildNqs({
    aggregation: parseAggregation(enabledProfile({ emotional_fit: { procedure: 'separate-judgement' } })),
    values: { CS: 75, OI: 50, EMOTIONAL_FIT: 55 },
    scope,
    baseMetricFor: baseMetric,
  });
  assert.equal(noIntent.status, 'not_assessable');
  assert.ok(noIntent.missing_reason.includes('emotional intention'), noIntent.missing_reason);

  const missing = buildNqs({
    aggregation: parseAggregation(enabledProfile()),
    values: { CS: 75, OI: null, EMOTIONAL_FIT: 55 },
    scope,
    baseMetricFor: baseMetric,
  });
  assert.equal(missing.status, 'not_assessable');
  assert.deepEqual(missing.detail.missing, ['OI']);

  const incompatible = buildNqs({
    aggregation: { ...parseAggregation(enabledProfile()), profile_version: 'nqs-profile.v2' },
    values: { CS: 75, OI: 50, EMOTIONAL_FIT: 55 },
    scope,
    baseMetricFor: baseMetric,
  });
  assert.equal(incompatible.status, 'not_assessable');
  assert.ok(incompatible.missing_reason.includes('incompatible'), incompatible.missing_reason);
});

test('a production profile stays unavailable until calibration evidence exists', () => {
  const production = parseAggregation(enabledProfile({ policy: 'production' }));
  const uncalibrated = buildNqs({ aggregation: production, values: { CS: 75, OI: 50, EMOTIONAL_FIT: 55 }, scope, baseMetricFor: baseMetric });
  assert.equal(uncalibrated.status, 'not_assessable');
  assert.ok(uncalibrated.missing_reason.includes('calibration'), uncalibrated.missing_reason);

  const calibrated = buildNqs({
    aggregation: parseAggregation(
      enabledProfile({ policy: 'production', calibration: { study_id: 'c34-pilot', held_out: true, evidence: ['ev1'] } }),
    ),
    values: { CS: 75, OI: 50, EMOTIONAL_FIT: 55 },
    scope,
    baseMetricFor: baseMetric,
  });
  assert.equal(calibrated.status, 'computed');
  assert.equal(calibrated.qualified, false);
  assert.ok(calibrated.detail.note.includes('calibration evidence'));
});

test('the aggregation profile requires non-negative weights that sum to one', () => {
  assertCode(() => parseAggregation(enabledProfile({ weights: { cs: 0.5, oi: 0.4, emotional_fit: 0.4 } })), 'INVALID_PROFILE');
  assertCode(() => parseAggregation(enabledProfile({ weights: { cs: -0.5, oi: 1, emotional_fit: 0.5 } })), 'INVALID_PROFILE');
  assertCode(() => parseAggregation(enabledProfile({ profile_version: 'nqs-profile.v9' })), 'SCHEMA_VERSION');
  assertCode(() => parseAggregation({ enabled: true }), 'INVALID_PROFILE');
  assert.deepEqual(parseAggregation({ enabled: false }).weights, null);
});

test('the dependency graph rejects cycles and accepts leaf inputs', () => {
  assert.equal(validateDependencyGraph({ A: ['B'], B: ['A'] }).ok, false);
  assert.ok(validateDependencyGraph({ A: ['B'], B: ['A'] }).errors.some((e) => e.includes('cycle')));
  assert.equal(validateDependencyGraph({ NQS: ['CS', 'OI', 'EMOTIONAL_FIT'] }).ok, true);
});

/* ------------------------------ CCI / CAD ------------------------------ */

test('CCI holds the value back with bounds when comparisons stay unresolved', () => {
  const partial = computeCci({ eligible_comparisons: 4, consistent: 2, contradicted: 1, unresolved: 1 });
  assert.equal(partial.value, null);
  assert.equal(partial.coverage, 0.75);
  assert.equal(partial.lower_bound, 50);
  assert.equal(partial.upper_bound, 75);
  assert.equal(computeCci({ eligible_comparisons: 2, consistent: 2, contradicted: 0, unresolved: 0 }).value, 100);
  assert.equal(computeCci({ eligible_comparisons: 0, consistent: 0, contradicted: 0, unresolved: 0 }).status, 'not_applicable');
});

test('CAD counts one candidate per underlying defect and stays not_applicable without changes', () => {
  const findings = [
    { id: 'a', kind: 'unsupported_change', status: 'confirmed', defect_id: 'drift-1' },
    { id: 'b', kind: 'unsupported_change', status: 'confirmed', defect_id: 'drift-1' },
    { id: 'c', kind: 'unsupported_change', status: 'dismissed', defect_id: 'drift-2' },
  ];
  const cad = computeCad(findings);
  assert.equal(cad.detail.change_candidates, 2);
  assert.deepEqual(cad.detail.linked_symptoms, ['b']);
  assert.equal(cad.value, 50);
  assert.equal(computeCad([]).status, 'not_applicable');
  assert.equal(computeCad([]).missing_reason, 'no character change candidates');
});

/* ------------------------------ AEG (C19) ------------------------------ */

function timingStudy(overrides = {}) {
  return {
    id: 'study-1',
    task_id: 'chapter-1-draft',
    scope: 'chapter 1',
    aggregation: 'paired_gains',
    baseline: { active_minutes: 10, revision_minutes: 0, interruptions: 1, accepted: true, criterion: 'accepted after one review pass' },
    assisted: { active_minutes: 12, revision_minutes: 0, interruptions: 0, accepted: true, criterion: 'accepted after one review pass', model_wait_minutes: 30 },
    server_elapsed_minutes: 45,
    ...overrides,
  };
}

function aeg(studies, options = {}) {
  return buildAeg(
    { schema_version: 'timing-study.v1', consent: 'opt_in', studies },
    {
      baseMetricFor: baseMetric,
      scope,
      fallbackReason: 'no opt-in AEG timing annotation supplied',
      legacyAnnotation: options.legacyAnnotation,
    },
  );
}

test('AEG computes the reproduced negative gain: 10 minutes baseline against 12 minutes assisted', () => {
  const metric = aeg([timingStudy()]);
  assert.equal(metric.status, 'computed');
  assert.equal(metric.value, -20);
  assert.equal(metric.aggregation, 'paired_gains');
  assert.equal(metric.coverage, 1);
  assert.equal(metric.detail.sample_size, 1);
  assert.equal(metric.detail.model_wait_minutes_total, 30, 'model wait is recorded but never counted as human time');
  assert.ok(metric.detail.arithmetic.includes('100 * (10 - 12) / 10 = -20'));
  assert.ok(metric.detail.note.includes('server elapsed time'));
  assert.equal(metric.detail.studies[0].server_elapsed_minutes, 45);
});

test('revision time counts as human time while a zero baseline and missing timings stay unavailable', () => {
  const withRevision = aeg([
    timingStudy({ assisted: { active_minutes: 10, revision_minutes: 2, interruptions: 0, accepted: true, criterion: 'accepted after one review pass' } }),
  ]);
  assert.equal(withRevision.value, -20);
  const zeroBaseline = aeg([
    timingStudy({ baseline: { active_minutes: 0, revision_minutes: 0, interruptions: 0, accepted: true, criterion: 'c' }, assisted: { active_minutes: 5, revision_minutes: 0, interruptions: 0, accepted: true, criterion: 'c' } }),
  ]);
  assert.equal(zeroBaseline.status, 'not_assessable');
  assert.ok(zeroBaseline.missing_reason.includes('positive human time'), zeroBaseline.missing_reason);
  const missingTiming = aeg([timingStudy({ baseline: { revision_minutes: 0, interruptions: 0, accepted: true, criterion: 'c' } })]);
  assert.equal(missingTiming.status, 'not_assessable');
  assert.ok(missingTiming.missing_reason.includes('active_minutes'), missingTiming.missing_reason);
});

test('unequal acceptance criteria are not comparable, and mixing aggregations is refused', () => {
  const unequal = aeg([
    timingStudy({ assisted: { active_minutes: 12, revision_minutes: 0, interruptions: 0, accepted: true, criterion: 'accepted without review', model_wait_minutes: 5 } }),
  ]);
  assert.equal(unequal.status, 'not_assessable');
  assert.ok(unequal.missing_reason.includes('unequal acceptance criteria'), unequal.missing_reason);

  const mixed = aeg([timingStudy(), timingStudy({ id: 'study-2', aggregation: 'total_time' })]);
  assert.equal(mixed.status, 'not_assessable');
  assert.ok(mixed.missing_reason.includes('aggregation'), mixed.missing_reason);
});

test('a bare annotated AEG number is unsupported legacy data, not a measurement', () => {
  const metric = buildAeg(undefined, {
    baseMetricFor: baseMetric,
    scope,
    fallbackReason: 'no opt-in AEG timing annotation supplied',
    legacyAnnotation: { value: 40 },
  });
  assert.equal(metric.status, 'not_assessable');
  assert.equal(metric.detail.legacy_value, 40);
  assert.ok(metric.missing_reason.includes('unsupported legacy data'), metric.missing_reason);
  assertCode(() => aeg([timingStudy({ aggregation: 'guessed' })]), 'INVALID_TIMING');
});

/* ------------------------------ CR (C20) ------------------------------ */

function crFixture(dataset, options = {}) {
  const root = options.root ?? tempDir('metrics-cr-');
  mkdirSync(join(root, 'dataset'), { recursive: true });
  const content = options.content ?? 'one training record per line\n';
  const file = writeFile(root, 'dataset/corpus.txt', content);
  const record = {
    model_identity: 'deepseek/deepseek-v4-flash (provider card)',
    corpus: { description: 'documented open subset', files: [{ path: 'dataset/corpus.txt', sha256: options.sha ?? sha256(Buffer.from(content, 'utf8')) }] },
    evaluation_population: { description: 'twenty held-out probes', items: 20 },
    overlap_criterion: 'exact eight-token overlap',
    access: 'available',
    provenance: 'provider card and local mirror',
    coverage: 1,
    checked_items: 20,
    matched_items: 0,
    ...dataset,
  };
  return { root, file, record };
}

test('CR computes a rate from checked counts and records its dataset provenance', () => {
  const { root, record } = crFixture({ matched_items: 3 });
  try {
    const metric = buildCr({ status: 'judged', evaluator: 'author', training_dataset: record }, {
      baseMetricFor: baseMetric,
      scope,
      annotationsDir: root,
    });
    assert.equal(metric.status, 'computed');
    assert.equal(metric.value, 15);
    assert.equal(metric.coverage, 1);
    assert.equal(metric.detail.training_dataset.checked_items, 20);
    assert.equal(metric.detail.training_dataset.corpus.files[0].sha256, record.corpus.files[0].sha256);
    assert.equal(metric.detail.training_dataset.qualified, false);
    assert.ok(metric.detail.note.includes('fully checked'));
  } finally {
    cleanup([root]);
  }
});

test('an empty training-dataset declaration and an inconsistent declared value are refused', () => {
  const { root } = crFixture({});
  try {
    assertCode(
      () => buildCr({ status: 'judged', training_dataset: {}, value: 0 }, { baseMetricFor: baseMetric, scope, annotationsDir: root }),
      'INVALID_TRAINING_DATASET',
    );
    assertCode(
      () =>
        buildCr(
          { status: 'judged', training_dataset: crFixture({ matched_items: 3 }).record, value: 99 },
          { baseMetricFor: baseMetric, scope, annotationsDir: root },
        ),
      'INVALID_TRAINING_DATASET',
    );
    assertCode(
      () =>
        buildCr(
          { status: 'judged', training_dataset: crFixture({ coverage: 0.5 }).record },
          { baseMetricFor: baseMetric, scope, annotationsDir: root },
        ),
      'INVALID_TRAINING_DATASET',
    );
  } finally {
    cleanup([root]);
  }
});

test('an inaccessible training set, an unchecked population and a partial subset are distinguished', () => {
  const inaccessible = crFixture({ access: 'inaccessible' });
  try {
    const metric = buildCr({ status: 'judged', training_dataset: inaccessible.record }, {
      baseMetricFor: baseMetric,
      scope,
      annotationsDir: inaccessible.root,
    });
    assert.equal(metric.status, 'not_assessable');
    assert.ok(metric.missing_reason.includes('inaccessible'), metric.missing_reason);
  } finally {
    cleanup([inaccessible.root]);
  }

  const unchecked = crFixture({ checked_items: 0, matched_items: 0, coverage: 0 });
  try {
    const metric = buildCr({ status: 'judged', training_dataset: unchecked.record }, {
      baseMetricFor: baseMetric,
      scope,
      annotationsDir: unchecked.root,
    });
    assert.equal(metric.status, 'not_assessable');
    assert.equal(metric.value, null);
    assert.ok(metric.missing_reason.includes('zero is not a measurement'), metric.missing_reason);
  } finally {
    cleanup([unchecked.root]);
  }

  const partial = crFixture({ access: 'partial_subset', coverage: 0.5, checked_items: 10, matched_items: 0 });
  try {
    const metric = buildCr({ status: 'judged', training_dataset: partial.record }, {
      baseMetricFor: baseMetric,
      scope,
      annotationsDir: partial.root,
    });
    assert.equal(metric.status, 'computed');
    assert.equal(metric.value, 0);
    assert.equal(metric.qualified, true);
    assert.ok(metric.detail.note.includes('limited finding'), metric.detail.note);
    assert.ok(metric.detail.note.includes('says nothing about the rest of training'));
  } finally {
    cleanup([partial.root]);
  }
});

test('CR verifies every referenced dataset file and never downloads one', () => {
  const fixture = crFixture({});
  try {
    assertCode(
      () =>
        buildCr(
          { status: 'judged', training_dataset: crFixture({ corpus: { description: 'x', files: [{ path: 'dataset/missing.txt', sha256: 'a'.repeat(64) }] } }).record },
          { baseMetricFor: baseMetric, scope, annotationsDir: fixture.root },
        ),
      'MISSING_FILE',
    );
    assertCode(
      () =>
        buildCr(
          {
            status: 'judged',
            training_dataset: crFixture({ corpus: { description: 'x', files: [{ path: 'dataset/corpus.txt', sha256: 'b'.repeat(64) }] } }).record,
          },
          { baseMetricFor: baseMetric, scope, annotationsDir: fixture.root },
        ),
      'HASH_MISMATCH',
    );
    assertCode(
      () =>
        buildCr(
          { status: 'judged', training_dataset: crFixture({ corpus: { description: 'x', files: [] } }).record },
          { baseMetricFor: baseMetric, scope, annotationsDir: fixture.root },
        ),
      'INVALID_TRAINING_DATASET',
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('CR without a dataset declaration is unavailable, never zero, and other metrics do not become it', () => {
  const absent = buildCr(undefined, { baseMetricFor: baseMetric, scope, annotationsDir: '/tmp' });
  assert.equal(absent.status, 'not_assessable');
  assert.equal(absent.value, null);
  assert.ok(absent.missing_reason.includes('never reported as zero'), absent.missing_reason);
  const legacy = buildCr({ value: 0 }, { baseMetricFor: baseMetric, scope, annotationsDir: '/tmp' });
  assert.equal(legacy.status, 'not_assessable');
  assert.ok(legacy.missing_reason.includes('unsupported legacy data'), legacy.missing_reason);
});

/* ------------------------------ wiring ------------------------------ */

test('buildMetrics keeps every metric object discriminated and populated', () => {
  const assessed = {
    CS: buildComponentMetric('CS', cs({
      referential_clarity: rating(3),
      discourse_connection: rating(3),
      causal_support: rating(3),
      temporal_intelligibility: rating(3),
    }), { scope, rubric, fallbackReason: 'x' }),
    OI: buildComponentMetric('OI', { status: 'judged', comparison_scope: 'declared', dimensions: { perspective: rating(2), dramatic_development: rating(2), expression: rating(2) } }, { scope, rubric, fallbackReason: 'x' }),
    NCS: buildComponentMetric('NCS', { status: 'judged', dimensions: { novelty: rating(3), cliche_reliance: rating(1) } }, { scope, rubric, fallbackReason: 'x' }),
    EAP: buildEap({ status: 'judged', trajectory: [eapPoint({})] }, { scope, segmentIds: ['seg1'], fallbackReason: 'x' }),
    CR: buildCr(undefined, { baseMetricFor: baseMetric, scope, annotationsDir: '/tmp' }),
    AEG: aeg([timingStudy()]),
  };
  const metrics = buildMetrics({
    scope,
    assessed,
    nqs: buildNqs({ aggregation: parseAggregation({ enabled: false }), values: { CS: 75, OI: 50, EMOTIONAL_FIT: 55 }, scope, baseMetricFor: baseMetric }),
    car: { status: 'computed', value: 100, coverage: 1, missing_reason: null },
    si: { status: 'computed', value: 0, pairs: [], comparison_scope: 'external_corpus', missing_reason: null },
    top: { status: 'not_assessable', value: null, matched_positions: 0, eligible_tokens: 0, spans: [], missing_reason: 'empty' },
    cci: null,
    cad: null,
    continuityReason: 'no continuity-result.v1 supplied in the annotations bundle',
    corpusReason: null,
  });
  assert.equal(Object.keys(metrics).length, 12);
  assert.equal(metrics.CS.value, 75);
  assert.equal(metrics.EAP.value_kind, 'trajectory');
  assert.equal(metrics.NCS.value, null);
  assert.equal(metrics.CCI.status, 'not_assessable');
  assert.ok(metrics.CCI.missing_reason.includes('continuity-result.v1'));
  assert.equal(metrics.TOP.status, 'not_assessable');
  for (const metric of Object.values(metrics)) {
    assert.ok(metric.registry_version, `${metric.id} registry_version`);
    assert.ok(Array.isArray(metric.evidence), `${metric.id} evidence`);
  }
});
