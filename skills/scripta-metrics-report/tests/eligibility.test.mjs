// C62: a score exists only for judged, complete inputs. Unavailable, inapplicable and failed results keep
// their diagnostic detail but never a number, the emotional fit is a judgement of its own with the same
// discipline, and the aggregate names exactly which prerequisite is missing instead of consuming a cached
// number. Valid zeros stay zeros.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, runReport, tempDir } from './helpers.mjs';

function readJsonOr(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

const AGG = {
  enabled: true,
  policy: 'research',
  weights: { cs: 0.4, oi: 0.3, emotional_fit: 0.3 },
  emotional_fit: { procedure: 'separate-judgement', intent: 'the stated intention' },
  scope: 'chapter 1',
  rubric_version: 'rubric-anchors.v1',
  corpus_version: 'corpus.v1',
};

function fitRecord(overrides = {}) {
  return {
    status: 'judged',
    evaluator: 'human-1',
    fit: 70,
    rationale: 'the register answers the stated intention',
    evidence: ['ev1'],
    intention_binding: 'the stated intention',
    ...overrides,
  };
}

function reportFor(options) {
  const root = tempDir('metrics-eligibility-');
  const fx = buildReportFixture(root, options);
  const out = join(root, 'out');
  const env = runReport(fx, out, {});
  // A refused report publishes nothing; the caller reads the exit and the envelope instead.
  return { fx, env, out, bundle: readJsonOr(join(out, 'assessment.json')) };
}

test('the reviewed scenario: unavailable and failed metrics never contribute a number to NQS', () => {
  const { env, bundle } = reportFor({
    profile: { aggregation: AGG },
    annotations: (annotations) => {
      annotations.metrics.CS.status = 'not_assessable';
      annotations.metrics.OI.status = 'error';
      annotations.metrics.EAP.status = 'not_assessable';
      annotations.metrics.EAP.emotional_fit = fitRecord({ fit: 100 });
    },
  });
  assert.equal(env.status, 0, env.stdout);
  assert.equal(bundle.metrics.CS.value, null, 'CS must have no value while not assessable');
  assert.equal(bundle.metrics.OI.value, null, 'OI must have no value while failed');
  assert.equal(bundle.metrics.EAP.status, 'not_assessable');
  assert.equal(bundle.metrics.NQS.status, 'not_assessable');
  assert.equal(bundle.metrics.NQS.value, null);
  assert.ok(bundle.metrics.NQS.missing_reason.includes('CS'), bundle.metrics.NQS.missing_reason);
  assert.ok(bundle.metrics.NQS.missing_reason.includes('OI'), bundle.metrics.NQS.missing_reason);
});

test('a judged emotional fit that lacks its own evidence cannot feed the aggregate, and the reason says what is missing', () => {
  const { env, bundle } = reportFor({
    profile: { aggregation: AGG },
    annotations: (annotations) => {
      annotations.metrics.EAP.emotional_fit = fitRecord({ evidence: [] });
    },
  });
  assert.equal(env.status, 0, env.stdout);
  assert.equal(bundle.metrics.NQS.status, 'not_assessable');
  assert.equal(bundle.metrics.NQS.value, null);
  assert.ok(bundle.metrics.NQS.missing_reason.includes('EMOTIONAL_FIT'), bundle.metrics.NQS.missing_reason);
  assert.ok(bundle.metrics.NQS.missing_reason.includes('cited passage'), bundle.metrics.NQS.missing_reason);
});

test('a bare emotional-fit number is refused by the report, not consumed', () => {
  const { env } = reportFor({
    profile: { aggregation: AGG },
    annotations: (annotations) => {
      annotations.metrics.EAP.emotional_fit = 100;
    },
  });
  assert.equal(env.status, 2, env.stdout);
  assert.ok(env.stdout.includes('INVALID_ANNOTATIONS'), env.stdout);
});

test('judged complete inputs keep the known arithmetic, and a valid zero stays a zero', () => {
  const { bundle } = reportFor({
    profile: { aggregation: AGG },
    annotations: (annotations) => {
      annotations.metrics.EAP.emotional_fit = fitRecord({ fit: 70 });
    },
  });
  const cs = bundle.metrics.CS.value;
  const oi = bundle.metrics.OI.value;
  assert.ok(typeof cs === 'number' && typeof oi === 'number');
  const expected = 0.4 * cs + 0.3 * oi + 0.3 * 70;
  assert.equal(bundle.metrics.NQS.status, 'computed');
  assert.ok(Math.abs(bundle.metrics.NQS.value - expected) < 0.01, `NQS ${bundle.metrics.NQS.value} vs ${expected}`);

  const zeroed = reportFor({
    profile: { aggregation: AGG },
    annotations: (annotations) => {
      for (const dimension of Object.values(annotations.metrics.CS.dimensions)) dimension.rating = 0;
      annotations.metrics.EAP.emotional_fit = fitRecord({ fit: 0 });
    },
  });
  assert.equal(zeroed.bundle.metrics.CS.value, 0, 'a valid zero score is preserved, not treated as missing');
  assert.equal(zeroed.bundle.metrics.NQS.status, 'computed');
});

test('every non-judged status leaves no value, and a partial dimension demotes the metric', () => {
  for (const status of ['not_assessable', 'not_applicable', 'error']) {
    const { env, bundle } = reportFor({
      profile: { aggregation: AGG },
      annotations: (annotations) => {
        annotations.metrics.CS.status = status;
      },
    });
    assert.equal(env.status, 0, env.stdout);
    assert.equal(bundle.metrics.CS.status, status);
    assert.equal(bundle.metrics.CS.value, null, `CS with status ${status} must have no value`);
    assert.equal(bundle.metrics.NQS.status, 'not_assessable');
    assert.equal(bundle.metrics.NQS.value, null);
  }
  const partial = reportFor({
    profile: { aggregation: AGG },
    annotations: (annotations) => {
      delete annotations.metrics.CS.dimensions.causal_support;
    },
  });
  assert.equal(partial.bundle.metrics.CS.status, 'not_assessable');
  assert.equal(partial.bundle.metrics.CS.value, null);
  assert.ok(partial.bundle.metrics.CS.missing_reason.includes('causal_support'), partial.bundle.metrics.CS.missing_reason);
});

test.after(() => {
  cleanup([]);
});
