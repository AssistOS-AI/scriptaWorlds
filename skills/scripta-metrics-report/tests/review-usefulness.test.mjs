// C83: the report is useful before it is numerical, and honest when it is empty.
//
// The review leads with what was assessed, the intention it was read against, the strengths the
// record observed and the most consequential supported problems with their passages, alternative
// readings and bounded revision options. Every metric keeps its diagnostics visible — the weights and
// declared arithmetic of the aggregate, its calibration qualification, coverage, bounds, unavailable
// reasons and component provenance — and an empty findings list states which of the three possible
// results it is: not evaluated, insufficient evidence, or no supported issue found.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { READING_STATUSES, buildReview } from '../scripts/lib/review.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runReport, tempDir } from './helpers.mjs';

function run(root, options = {}, name = 'out') {
  const fx = buildReportFixture(join(root, `fx-${name}`), options);
  const out = join(root, name);
  const env = runReport(fx, out);
  assert.equal(env.status, 0, env.stdout);
  return { out, bundle: readJson(join(out, 'assessment.json')), view: (file) => readFileSync(join(out, file), 'utf8') };
}

test('the vocabulary of reading statuses is the one the report publishes', () => {
  assert.deepEqual(READING_STATUSES, ['not_evaluated', 'insufficient_evidence', 'no_supported_issue_found', 'problems_recorded']);
  assert.equal(typeof buildReview, 'function');
});

test('the generic review leads with what was assessed, the intention, the strengths and the problems', () => {
  const root = tempDir('metrics-c83-lead-');
  try {
    const { bundle, view } = run(root);
    const review = bundle.review;
    assert.equal(review.reading_status, 'problems_recorded');
    assert.ok(review.statement.includes('supported problem'), review.statement);
    assert.deepEqual(review.assessment.judged.length > 0, true);
    assert.deepEqual(review.assessment.evaluated.map((entry) => entry.id).length > 0, true);
    assert.deepEqual(
      review.intention.declared.map((entry) => entry.source).includes('annotations.metrics.EAP.emotional_fit.intention_binding'),
      true,
      'the declared intention the judgements were bound to is named',
    );
    assert.deepEqual(review.strengths.map((entry) => entry.id), ['p1']);
    assert.ok(review.strengths[0].statement.length > 0);
    assert.equal(review.problems[0].supported, true, 'supported problems come first');
    assert.deepEqual(review.problems.map((problem) => problem.id), ['find-2', 'find-1'], 'major severity first');
    assert.equal(review.problems[0].severity, 'major');
    const first = review.problems[0];
    assert.ok(first.passages.length > 0, 'a problem carries the exact passages it rests on');
    assert.ok(first.relates_to.includes('chapter'), first.relates_to);
    assert.ok(first.intention_link.includes('declared intention'), first.intention_link);
    assert.ok(first.alternative_reading.length > 0, 'the alternative reading is preserved');
    assert.equal(first.revision_options.length, 1);
    assert.equal(first.revision_options[0].statement, 'Name the cause before the change.');
    assert.deepEqual(first.revision_options[0].preserved_in_the_same_scope, ['p1'], 'a revision keeps the strengths in view');

    const index = view('index.md');
    const issues = view('05-detected-issues.md');
    for (const text of [index, issues]) {
      assert.ok(text.includes('The review in brief') || text.includes('Review summary'), 'the summary leads the view');
      assert.ok(text.includes('problems recorded'), text.slice(0, 200));
      assert.ok(text.includes('Strengths observed'));
      assert.ok(text.includes('Align the two descriptions.'), 'a bounded revision option is shown');
      assert.ok(text.includes('Alternative reading (preserved)'));
    }
    assert.ok(index.indexOf('Review summary') < index.indexOf('## Views'), 'the summary precedes the view list');
  } finally {
    cleanup([root]);
  }
});

test('a qualified aggregate exposes its weights, arithmetic and calibration in the default view', () => {
  const root = tempDir('metrics-c83-nqs-');
  try {
    const { bundle, view } = run(root, {
      profile: {
        aggregation: {
          enabled: true,
          policy: 'research',
          weights: { cs: 0.4, oi: 0.35, emotional_fit: 0.25 },
          emotional_fit: { procedure: 'separate-judgement', intent: 'a quiet elegiac aftermath' },
          scope: 'chapter 1',
          corpus_version: 'corpus.v1',
          rubric_version: 'rubric-anchors.v1',
        },
      },
    });
    const nqs = bundle.metrics.NQS;
    assert.equal(nqs.status, 'computed');
    assert.equal(nqs.qualified, true);
    assert.ok(nqs.detail.arithmetic.includes('0.4 *'), nqs.detail.arithmetic);
    assert.deepEqual(nqs.detail.weights, { cs: 0.4, oi: 0.35, emotional_fit: 0.25 });
    assert.equal(nqs.detail.calibration, null, 'no calibration artifact is claimed without one');
    const justification = view('04-score-justification.md');
    assert.ok(justification.includes('aggregation_policy: research'), justification);
    assert.ok(justification.includes('arithmetic: 100 * (0.4 *'), 'the declared arithmetic is published');
    assert.ok(justification.includes('Qualification: limited or experimental finding'));
    assert.ok(justification.includes('Coverage: 1'), 'coverage is published next to the number');
  } finally {
    cleanup([root]);
  }
});

test('an unavailable component keeps its diagnostic data and its reason, and is never shown as zero', () => {
  const root = tempDir('metrics-c83-unavailable-');
  try {
    const { bundle, view } = run(root, {
      annotations: (annotations) => {
        delete annotations.metrics.OI.dimensions.expression;
      },
    });
    const oi = bundle.metrics.OI;
    assert.equal(oi.status, 'not_assessable');
    assert.equal(oi.value, null);
    assert.deepEqual(oi.detail.missing_dimensions, ['expression']);
    assert.equal(Object.keys(oi.components).length, 2, 'the dimensions that were judged stay readable');
    assert.ok(oi.missing_reason.includes('expression'), oi.missing_reason);
    const justification = view('04-score-justification.md');
    assert.ok(justification.includes('missing_dimensions: expression'), justification);
    assert.ok(justification.includes('never yields a full OI score'), justification);
    const metricsView = view('03-metrics-and-indicators.md');
    assert.ok(metricsView.includes('## Unavailable reasons'));
    assert.ok(metricsView.includes('`OI`: dimension expression not assessable'), metricsView);
    assert.ok(!/`OI` \| not_assessable \| 0 /.test(metricsView), 'an unavailable value is not rendered as a zero');
  } finally {
    cleanup([root]);
  }
});

test('a partial reading is insufficient evidence, not a clean report', () => {
  const root = tempDir('metrics-c83-partial-');
  try {
    const { bundle, view } = run(root, {
      annotations: (annotations) => {
        annotations.findings = [];
        annotations.continuity.findings = [];
        // Two scenes are declared, one is assessed: the trajectory covers half the population.
        annotations.segments.push({
          id: 'seg3',
          chapter: 1,
          kind: 'scene',
          label: 'the second half',
          start: 0,
          end: 40,
        });
      },
    });
    const review = bundle.review;
    assert.equal(review.reading_status, 'insufficient_evidence');
    assert.ok(review.statement.includes('insufficient evidence'), review.statement);
    assert.ok(review.problems_note.includes('reading status'), review.problems_note);
    assert.equal(review.assessment.measures.segment_coverage, 0.5);
    const issues = view('05-detected-issues.md');
    assert.ok(issues.includes('insufficient evidence'), issues);
    assert.ok(!/No findings recorded\.\s*$/m.test(issues), 'the empty list is explained, never left bare');
  } finally {
    cleanup([root]);
  }
});

test('nothing evaluated is distinguished from nothing found, and both from a clean report', () => {
  const root = tempDir('metrics-c83-empties-');
  try {
    const nothing = run(
      root,
      {
        noContinuity: true,
        annotations: (annotations) => {
          annotations.metrics = {};
          annotations.indicators = [];
          annotations.findings = [];
          annotations.preserved_qualities = { passages: [] };
          annotations.requirements.outcomes = [];
        },
      },
      'nothing',
    );
    assert.equal(nothing.bundle.review.reading_status, 'not_evaluated');
    assert.ok(nothing.bundle.review.statement.includes('the text was not read'), nothing.bundle.review.statement);
    assert.ok(nothing.view('index.md').includes('**not evaluated**'));
    assert.deepEqual(nothing.bundle.review.assessment.judged, [], 'no judgement was produced');
    assert.deepEqual(
      nothing.bundle.review.assessment.evaluated.map((entry) => entry.id).sort(),
      ['AEG', 'CAR', 'SI', 'TOP'],
      'deterministic measures are still reported; they are measurements, not a reading',
    );

    const clean = run(
      root,
      {
        annotations: (annotations) => {
          annotations.findings = [];
          annotations.continuity.findings = [];
        },
      },
      'clean',
    );
    assert.equal(clean.bundle.review.reading_status, 'no_supported_issue_found');
    assert.ok(clean.bundle.review.statement.includes('absence of a supported issue'), clean.bundle.review.statement);
    assert.ok(
      clean.view('05-detected-issues.md').includes('not a statement of literary quality'),
      'a clean reading still refuses to promise literary quality',
    );
  } finally {
    cleanup([root]);
  }
});

test('a contradictory interpretation survives revision selection', () => {
  const root = tempDir('metrics-c83-contested-');
  try {
    const { bundle, view } = run(root, {
      annotations: (annotations) => {
        annotations.continuity.findings.push({
          id: 'find-3',
          kind: 'contradiction',
          severity: 'major',
          certainty: 'tentative',
          status: 'unresolved',
          description: 'The light on the sea may be a second time of day.',
          evidence: ['ev1', 'ev2'],
          temporal: { baseline: ['ev1'], later: ['ev2'] },
          alternative_explanation: 'The two references may describe different moments.',
          repair_suggestion: 'Decide whether the scene spans one morning or two.',
        });
      },
    });
    const contested = bundle.review.problems.find((problem) => problem.id === 'find-3');
    assert.equal(contested.supported, false);
    assert.equal(contested.contested, true);
    assert.equal(contested.alternative_reading, 'The two references may describe different moments.');
    assert.equal(contested.revision_options[0].alternative_reading, 'The two references may describe different moments.');
    const issues = view('05-detected-issues.md');
    assert.ok(issues.includes('Decide whether the scene spans one morning or two.'));
    assert.ok(issues.includes('Alternative reading (preserved): The two references may describe different moments.'));
  } finally {
    cleanup([root]);
  }
});
