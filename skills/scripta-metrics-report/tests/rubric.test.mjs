import test from 'node:test';
import assert from 'node:assert/strict';

import { buildComponentMetric, buildEap, parseRubricProfile } from '../scripts/lib/rubric.mjs';

const rubric = parseRubricProfile(undefined);
const scope = { kind: 'chapter', chapters: [1], segments: ['seg1'] };

function cs(dimensions) {
  return { status: 'judged', evaluator: 'human-1', dimensions };
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

/* ------------------------------ CS / OI / NCS (C16, C17) ------------------------------ */

test('CS computes its scalar from four anchored dimensions with evidence and arithmetic', () => {
  const metric = buildComponentMetric(
    'CS',
    cs({
      referential_clarity: rating(3),
      discourse_connection: rating(3),
      causal_support: rating(3),
      temporal_intelligibility: rating(3),
    }),
    { scope, rubric, fallbackReason: 'no CS annotation supplied' },
  );
  assert.equal(metric.status, 'judged');
  assert.equal(metric.value_kind, 'components');
  assert.equal(metric.value, 75);
  assert.deepEqual(Object.keys(metric.components), [
    'referential_clarity',
    'discourse_connection',
    'causal_support',
    'temporal_intelligibility',
  ]);
  assert.equal(metric.components.temporal_intelligibility.rating, 3);
  assert.deepEqual(metric.evidence, ['ev1']);
  assert.ok(metric.detail.arithmetic.includes('100 * (3 + 3 + 3 + 3) / (4 * 4) = 75'));
  assert.equal(metric.coverage, 1);
});

test('a missing CS dimension leaves the scalar unavailable instead of completing the score', () => {
  const metric = buildComponentMetric(
    'CS',
    cs({ referential_clarity: rating(4), discourse_connection: rating(4), causal_support: rating(4) }),
    { scope, rubric, fallbackReason: 'no CS annotation supplied' },
  );
  assert.equal(metric.status, 'not_assessable');
  assert.equal(metric.value, null);
  assert.deepEqual(metric.detail.missing_dimensions, ['temporal_intelligibility']);
  assert.ok(metric.missing_reason.includes('temporal_intelligibility'), metric.missing_reason);
  assert.equal(metric.coverage, 0.75);
});

test('a bare CS scalar is classified as unsupported legacy data, never as a score', () => {
  const metric = buildComponentMetric('CS', { status: 'judged', value: 100, evaluator: 'human-1' }, {
    scope,
    rubric,
    fallbackReason: 'no CS annotation supplied',
  });
  assert.equal(metric.status, 'not_assessable');
  assert.equal(metric.value, null);
  assert.equal(metric.detail.legacy_value, 100);
  assert.ok(metric.missing_reason.includes('unsupported legacy data'), metric.missing_reason);
  assert.ok(metric.missing_reason.includes('referential_clarity'), metric.missing_reason);
});

test('component dimensions are validated: scale, rationale, evidence and known names', () => {
  const withBadRating = { ...cs({ referential_clarity: rating(5) }) };
  assertCode(
    () => buildComponentMetric('CS', withBadRating, { scope, rubric, fallbackReason: 'x' }),
    'INVALID_ANNOTATIONS',
  );
  assertCode(
    () => buildComponentMetric('CS', cs({ referential_clarity: { rating: 2, evidence: ['ev1'] } }), {
      scope,
      rubric,
      fallbackReason: 'x',
    }),
    'INVALID_ANNOTATIONS',
  );
  assertCode(
    () => buildComponentMetric('CS', cs({ referential_clarity: { rating: 2, rationale: 'ok', evidence: [] } }), {
      scope,
      rubric,
      fallbackReason: 'x',
    }),
    'INVALID_ANNOTATIONS',
  );
  assertCode(
    () => buildComponentMetric('CS', cs({ banana: rating(2) }), { scope, rubric, fallbackReason: 'x' }),
    'INVALID_ANNOTATIONS',
  );
});

test('OI computes its scalar only against a declared comparison scope', () => {
  const metric = buildComponentMetric(
    'OI',
    {
      status: 'judged',
      evaluator: 'human-1',
      comparison_scope: 'declared genre references',
      dimensions: { perspective: rating(2), dramatic_development: rating(2), expression: rating(2) },
    },
    { scope, rubric, fallbackReason: 'no OI annotation supplied' },
  );
  assert.equal(metric.status, 'judged');
  assert.equal(metric.value, 50);
  assert.equal(metric.comparison_scope, 'declared genre references');
  assertCode(
    () =>
      buildComponentMetric(
        'OI',
        { status: 'judged', dimensions: { perspective: rating(2), dramatic_development: rating(2), expression: rating(2) } },
        { scope, rubric, fallbackReason: 'x' },
      ),
    'INVALID_ANNOTATIONS',
  );
});

test('NCS keeps novelty and cliché reliance separate with no combined score', () => {
  const metric = buildComponentMetric(
    'NCS',
    {
      status: 'judged',
      evaluator: 'human-1',
      dimensions: {
        novelty: { rating: 3, rationale: 'Fresh staging of a familiar vigil.', evidence: ['ev4'] },
        cliche_reliance: { rating: 1, rationale: 'One conventional figure, earned by context.', evidence: ['ev1'] },
      },
    },
    { scope, rubric, fallbackReason: 'no NCS annotation supplied' },
  );
  assert.equal(metric.status, 'judged');
  assert.equal(metric.value, null);
  assert.equal(metric.components.novelty.rating, 3);
  assert.equal(metric.components.cliche_reliance.rating, 1);
  assert.ok(metric.components.cliche_reliance.rationale.includes('conventional'));
  assert.ok(metric.missing_reason.includes('no combined NCS'), metric.missing_reason);
});

test('an unexplained NCS scalar is unsupported legacy data and a missing dimension blocks the pair', () => {
  const legacy = buildComponentMetric('NCS', { status: 'judged', value: 40 }, { scope, rubric, fallbackReason: 'x' });
  assert.equal(legacy.status, 'not_assessable');
  assert.equal(legacy.detail.legacy_value, 40);
  const partial = buildComponentMetric('NCS', { status: 'judged', dimensions: { novelty: rating(3) } }, {
    scope,
    rubric,
    fallbackReason: 'x',
  });
  assert.equal(partial.status, 'not_assessable');
  assert.deepEqual(partial.detail.missing_dimensions, ['cliche_reliance']);
});

/* ------------------------------ EAP trajectory (C16) ------------------------------ */

const eapPoint = (overrides) => ({
  segment_id: 'seg1',
  focalization: 'marinarul',
  valence: 0,
  tension: 1,
  evidence: ['ev1'],
  uncertainty: 'The register could read as exhaustion.',
  ...overrides,
});

test('EAP is an ordered trajectory with evidence, uncertainty and a declared ordering', () => {
  const metric = buildEap(
    {
      status: 'judged',
      emotional_fit: 55,
      ordering: 'story',
      trajectory: [
        eapPoint({ segment_id: 'seg1', story_order: 1, valence: 1, tension: 2 }),
        eapPoint({ segment_id: 'seg2', story_order: 0, valence: -1, tension: 0 }),
      ],
    },
    { scope, segmentIds: ['seg1', 'seg2'], selectedSegmentIds: ['seg1', 'seg2'], fallbackReason: 'no EAP annotation supplied' },
  );
  assert.equal(metric.status, 'judged');
  assert.equal(metric.value_kind, 'trajectory');
  assert.equal(metric.value, null, 'no scalar is derived from a trajectory');
  assert.equal(metric.ordering, 'story');
  // The series is published in the declared chronology with the reading order retained.
  assert.deepEqual(metric.trajectory.map((point) => point.segment_id), ['seg2', 'seg1']);
  assert.deepEqual(metric.trajectory.map((point) => point.disclosure_index), [1, 0]);
  assert.deepEqual(metric.trajectory.map((point) => point.story_order), [0, 1]);
  assert.equal(metric.trajectory[0].tension, 0);
  assert.ok(metric.trajectory[0].uncertainty.length > 0);
  assert.deepEqual(metric.evidence, ['ev1']);
  assert.equal(metric.coverage, 1, 'both selected segments were assessed');
  assert.equal(metric.detail.min_tension, 0, 'a quiet aftermath keeps its low intensity');
  assert.deepEqual(metric.detail.low_tension_segments, ['seg2']);
  assert.ok(metric.detail.note.includes('high tension is not automatically good'));
  assert.ok(metric.detail.note.includes('not a defect'));
});

test('a mixed story-time series must declare its ordering', () => {
  assertCode(
    () =>
      buildEap(
        { status: 'judged', trajectory: [eapPoint({ story_order: 0 })] },
        { scope, segmentIds: ['seg1'], fallbackReason: 'x' },
      ),
    'INVALID_ANNOTATIONS',
  );
});

test('EAP refuses a bare scalar, a fit-only annotation, unknown segments and out-of-range axes', () => {
  const legacy = buildEap({ status: 'judged', value: 55 }, { scope, segmentIds: ['seg1'], fallbackReason: 'x' });
  assert.equal(legacy.status, 'not_assessable');
  assert.equal(legacy.detail.legacy_value, 55);
  assert.ok(legacy.missing_reason.includes('unsupported legacy data'), legacy.missing_reason);

  const fitOnly = buildEap({ status: 'judged', emotional_fit: 55 }, { scope, segmentIds: ['seg1'], fallbackReason: 'x' });
  assert.equal(fitOnly.status, 'not_assessable');
  assert.ok(fitOnly.missing_reason.includes('emotional-fit'), fitOnly.missing_reason);

  assertCode(
    () => buildEap({ status: 'judged', trajectory: [eapPoint({ segment_id: 'nope' })] }, { scope, segmentIds: ['seg1'], fallbackReason: 'x' }),
    'UNKNOWN_SEGMENT',
  );
  assertCode(
    () => buildEap({ status: 'judged', trajectory: [eapPoint({ valence: 3 })] }, { scope, segmentIds: ['seg1'], fallbackReason: 'x' }),
    'OUT_OF_RANGE',
  );
  assertCode(
    () => buildEap({ status: 'judged', trajectory: [eapPoint({ tension: 9 })] }, { scope, segmentIds: ['seg1'], fallbackReason: 'x' }),
    'OUT_OF_RANGE',
  );
  assertCode(
    () => buildEap({ status: 'judged', trajectory: [eapPoint({ uncertainty: '' })] }, { scope, segmentIds: ['seg1'], fallbackReason: 'x' }),
    'INVALID_ANNOTATIONS',
  );
  assertCode(
    () => buildEap({ status: 'judged', trajectory: [{ ...eapPoint(), evidence: [] }] }, { scope, segmentIds: ['seg1'], fallbackReason: 'x' }),
    'INVALID_ANNOTATIONS',
  );
});
