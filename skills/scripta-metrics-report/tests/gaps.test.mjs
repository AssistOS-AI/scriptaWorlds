/**
 * The honest-gaps contract: a measurement that cannot be made is reported as
 * unavailable with its reason — never as zero and never as a redistribution of
 * the inputs that are present — and it does not stop the observations that are
 * supported from being reported.
 *
 * The metric-level cases drive the component builders directly; the bundle
 * cases run the CLI without a corpus, a training-set record or a timing study,
 * which is what an ordinary first report actually looks like.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeIndicators } from '../scripts/lib/annotations.mjs';
import { buildComponentMetric, parseRubricProfile } from '../scripts/lib/rubric.mjs';
import { CHAPTER_1, buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runReport, tempDir } from './helpers.mjs';

const rubric = parseRubricProfile(undefined);
const scope = { kind: 'chapter', chapters: [1], segments: ['seg1'] };

function rating(value, evidence = ['ev1']) {
  return { rating: value, rationale: `rating ${value}`, evidence };
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}


/* ------------------------------ honest gaps ------------------------------ */

test('OI is scoped to the comparison that was actually performed, and an unnamed comparison is refused', () => {
  const dimensions = { perspective: rating(2), dramatic_development: rating(2), expression: rating(2) };
  // Without a declared comparison scope there is no way to say what OI measured.
  assertCode(
    () => buildComponentMetric('OI', { status: 'judged', dimensions }, { scope, rubric, fallbackReason: 'x' }),
    'INVALID_ANNOTATIONS',
  );
  const metric = buildComponentMetric(
    'OI',
    { status: 'judged', comparison_scope: 'the four Romanian references in corpus.v1', dimensions },
    { scope, rubric, fallbackReason: 'x' },
  );
  assert.equal(metric.status, 'judged');
  assert.equal(metric.value, 50);
  assert.equal(metric.comparison_scope, 'the four Romanian references in corpus.v1');
  // A missing judgement stays unavailable; it is never folded into the components present.
  const partial = buildComponentMetric('OI', { status: 'judged', comparison_scope: 'declared', dimensions: { perspective: rating(2) } }, { scope, rubric, fallbackReason: 'x' });
  assert.equal(partial.status, 'not_assessable');
  assert.equal(partial.value, null);
  assert.deepEqual(partial.detail.missing_dimensions, ['dramatic_development', 'expression']);
});

test('cultural value needs reception evidence, and its absence leaves the other indicators alone', () => {
  const normalized = normalizeIndicators([
    {
      id: 'narrative_coherence',
      status: 'judged',
      category: 'High',
      evaluator: 'model:fixture',
      rationale: 'the scenes return to one image',
      evidence: ['ev1'],
    },
  ]);
  assert.equal(normalized.cultural_value.status, 'not_assessable');
  assert.equal(normalized.cultural_value.category, null);
  assert.ok(normalized.cultural_value.missing_reason.includes('reception evidence'), normalized.cultural_value.missing_reason);
  assert.equal(normalized.narrative_coherence.status, 'judged');
  assert.equal(normalized.character_complexity.status, 'not_assessable');
  assert.ok(normalized.character_complexity.missing_reason.includes('no indicator annotation supplied'));

  // The gap is conditional, not a permanent hole: reception evidence makes the
  // judgement possible, and one supplied indicator never fills the others.
  const withReception = normalizeIndicators([
    {
      id: 'cultural_value',
      status: 'judged',
      category: 'Regional',
      evaluator: 'editor:team',
      rationale: 'two reader letters describe the setting as their own region',
      evidence: ['ev1'],
    },
  ]);
  assert.equal(withReception.cultural_value.status, 'judged');
  assert.equal(withReception.cultural_value.category, 'Regional');
  assert.equal(withReception.narrative_coherence.status, 'not_assessable');
});

/* ------------------------------ honest gaps ------------------------------ */

/** An enabled research aggregate, so a missing measurement cannot quietly change its weights. */
const RESEARCH_AGGREGATION = {
  enabled: true,
  policy: 'research',
  weights: { cs: 0.4, oi: 0.35, emotional_fit: 0.25 },
  emotional_fit: { procedure: 'separate-judgement', intent: 'a quiet elegiac aftermath' },
  scope: 'chapter 1',
  rubric_version: 'rubric-anchors.v1',
  corpus_version: 'corpus.v1',
};

test('an absent corpus, dataset and timing leave those metrics unavailable without blocking or reweighting the rest', () => {
  const root = tempDir('metrics-gaps-');
  try {
    const fx = buildReportFixture(root, {
      profile: { aggregation: RESEARCH_AGGREGATION },
      annotations: (annotations) => {
        delete annotations.timing;
        delete annotations.metrics.CR;
      },
    });
    const out = join(root, 'out');
    const env = runReport(fx, out, { corpus: null });
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));

    // A missing declared corpus: unavailable with the reason, never a zero overlap.
    for (const id of ['SI', 'TOP']) {
      assert.equal(bundle.metrics[id].status, 'not_assessable', id);
      assert.equal(bundle.metrics[id].value, null, id);
      assert.ok(bundle.metrics[id].missing_reason.includes('corpus'), bundle.metrics[id].missing_reason);
    }
    // A missing training-set record and a missing opt-in timing study.
    assert.equal(bundle.metrics.CR.status, 'not_assessable');
    assert.equal(bundle.metrics.CR.value, null);
    assert.ok(bundle.metrics.CR.missing_reason.includes('never reported as zero'), bundle.metrics.CR.missing_reason);
    assert.equal(bundle.metrics.AEG.status, 'not_assessable');
    assert.equal(bundle.metrics.AEG.value, null);
    assert.ok(bundle.metrics.AEG.missing_reason.includes('no opt-in AEG timing'), bundle.metrics.AEG.missing_reason);
    // Reception evidence is absent, so cultural value is unavailable rather than low.
    assert.equal(bundle.indicators.cultural_value.status, 'not_assessable');
    assert.equal(bundle.indicators.cultural_value.category, null);
    assert.ok(bundle.indicators.cultural_value.missing_reason.includes('reception evidence'));

    // The measurements that are supported are unaffected by those gaps.
    assert.equal(bundle.metrics.CS.status, 'judged');
    assert.equal(bundle.metrics.CS.value, 75);
    assert.equal(bundle.metrics.EAP.status, 'judged');
    assert.equal(bundle.metrics.CCI.status, 'computed');
    assert.equal(bundle.metrics.CCI.value, 50);
    assert.equal(bundle.metrics.CAR.status, 'computed');
    // The aggregate is computed from the declared weights, with nothing shifted into the gaps.
    assert.equal(bundle.metrics.NQS.status, 'computed');
    assert.deepEqual(bundle.metrics.NQS.detail.weights, RESEARCH_AGGREGATION.weights);
    assert.ok(Math.abs(bundle.metrics.NQS.value - 61.25) < 1e-9, String(bundle.metrics.NQS.value));

    const metricsView = readFileSync(join(out, '03-metrics-and-indicators.md'), 'utf8');
    assert.ok(metricsView.includes('no --corpus manifest supplied'), metricsView);
    assert.ok(!/"value":0/.test(JSON.stringify(bundle.metrics.SI)), 'an absent corpus is not a zero');
  } finally {
    cleanup([root]);
  }
});

test('a missing aggregate component leaves NQS unavailable without redistributing its weights', () => {
  const root = tempDir('metrics-gaps-');
  try {
    const fx = buildReportFixture(root, {
      profile: { aggregation: RESEARCH_AGGREGATION },
      annotations: (annotations) => { delete annotations.metrics.OI; },
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.metrics.NQS.status, 'not_assessable');
    assert.equal(bundle.metrics.NQS.value, null);
    assert.deepEqual(bundle.metrics.NQS.detail.missing, ['OI']);
    assert.deepEqual(bundle.metrics.NQS.detail.weights, RESEARCH_AGGREGATION.weights, 'no weight moves to the components present');
    assert.equal(bundle.metrics.OI.status, 'not_assessable');
    assert.equal(bundle.metrics.CS.status, 'judged');
    assert.equal(bundle.metrics.CAR.status, 'computed');
    const metricsView = readFileSync(join(out, '03-metrics-and-indicators.md'), 'utf8');
    assert.ok(metricsView.includes('never redistributed around missing inputs'), metricsView);
    assert.ok(metricsView.includes('| `CS` |'), 'the metrics that are supported are still reported');
  } finally {
    cleanup([root]);
  }
});

test('a declared corpus whose every reference is ineligible leaves SI and TOP unavailable, never zero', () => {
  const root = tempDir('metrics-gaps-');
  try {
    // The only declared reference forbids comparison, so nothing is left to
    // compare. (A reference that merely repeats the candidate's bytes is a
    // different case: it stays eligible and is measured.)
    const fx = buildReportFixture(root, { reference: { permitted_use: 'none' } });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    for (const id of ['SI', 'TOP']) {
      assert.equal(bundle.metrics[id].status, 'not_assessable', id);
      assert.equal(bundle.metrics[id].value, null, id);
      assert.ok(
        bundle.metrics[id].missing_reason.includes('every declared reference was excluded'),
        bundle.metrics[id].missing_reason,
      );
    }
    assert.deepEqual(
      bundle.provenance.corpus.exclusions.map((exclusion) => `${exclusion.id}:${exclusion.reason}`),
      ['ref1:permitted_use:none'],
      'the exclusion is named, not silently dropped',
    );
    assert.equal(bundle.provenance.corpus.references[0].excluded_reason, 'permitted_use:none');
    assert.equal(bundle.metrics.CS.status, 'judged', 'the gap does not block the rest of the report');
  } finally {
    cleanup([root]);
  }
});
