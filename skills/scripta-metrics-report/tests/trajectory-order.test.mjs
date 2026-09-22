// C74: an emotional trajectory is a series over a declared population, in a declared order.
//
// The incoming array order is the disclosure order and is retained as such; the published series is
// ordered by the declared chronology, which has to be complete and unambiguous before it can be
// claimed. Coverage is the fraction of the selected segments the trajectory actually assessed, the
// omissions are named, and a quiet point stays a description of the arc rather than a defect.

import test from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';
import { readFileSync } from 'node:fs';

import { buildEap } from '../scripts/lib/rubric.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runReport, sha256, tempDir } from './helpers.mjs';

const scope = { kind: 'chapter', chapters: [1], segments: [] };

function point(segmentId, overrides = {}) {
  return {
    segment_id: segmentId,
    focalization: 'marinarul',
    valence: 0,
    tension: 1,
    evidence: ['ev1'],
    uncertainty: 'The register could read as exhaustion.',
    ...overrides,
  };
}

function eap(annotation, selectedSegmentIds, declaredSegmentIds = selectedSegmentIds) {
  return buildEap(annotation, {
    scope,
    segmentIds: declaredSegmentIds,
    selectedSegmentIds,
    fallbackReason: 'no EAP annotation supplied',
  });
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

test('a reversed supplied story position is normalized into the declared chronology', () => {
  const metric = eap(
    {
      status: 'judged',
      ordering: 'story',
      trajectory: [
        point('seg1', { story_order: 2, tension: 3 }),
        point('seg2', { story_order: 1, tension: 2 }),
        point('seg3', { story_order: 0, tension: 0 }),
      ],
    },
    ['seg1', 'seg2', 'seg3'],
  );
  assert.equal(metric.status, 'judged');
  assert.equal(metric.ordering, 'story', 'the published series really is in the declared chronology');
  assert.deepEqual(metric.trajectory.map((p) => p.segment_id), ['seg3', 'seg2', 'seg1']);
  assert.deepEqual(metric.trajectory.map((p) => p.story_order), [0, 1, 2]);
  assert.deepEqual(metric.trajectory.map((p) => p.disclosure_index), [2, 1, 0], 'the received order is retained');
  assert.equal(metric.detail.ordering_declared, 'story');
  assert.equal(metric.detail.ordering_normalized, true);
  assert.equal(metric.coverage, 1);
});

test('the declared chronology must be complete and unambiguous before it can be claimed', () => {
  assertCode(
    () => eap({ status: 'judged', ordering: 'story', trajectory: [point('seg1', { story_order: 0 }), point('seg2')] }, ['seg1', 'seg2']),
    'INVALID_ANNOTATIONS',
  );
  assertCode(
    () =>
      eap(
        { status: 'judged', ordering: 'story', trajectory: [point('seg1', { story_order: 1 }), point('seg2', { story_order: 1 })] },
        ['seg1', 'seg2'],
      ),
    'INVALID_ANNOTATIONS',
  );
  // A disclosure-ordered series may still declare its chronology; it is then reported, not obeyed.
  const declared = eap(
    { status: 'judged', ordering: 'disclosure', trajectory: [point('seg1', { story_order: 1 }), point('seg2', { story_order: 0 })] },
    ['seg1', 'seg2'],
  );
  assert.equal(declared.ordering, 'disclosure');
  assert.deepEqual(declared.trajectory.map((p) => p.segment_id), ['seg1', 'seg2']);
  assert.equal(declared.detail.ordering_normalized, false);
});

test('one assessed segment among many reports its coverage and names the omissions', () => {
  const metric = eap({ status: 'judged', trajectory: [point('seg2')] }, ['seg1', 'seg2', 'seg3', 'seg4']);
  assert.equal(metric.status, 'judged');
  assert.equal(metric.coverage, 0.25);
  assert.deepEqual(metric.detail.selected_segments, ['seg1', 'seg2', 'seg3', 'seg4']);
  assert.deepEqual(metric.detail.assessed_segments, ['seg2']);
  assert.deepEqual(metric.detail.omitted_segments, ['seg1', 'seg3', 'seg4']);
  assert.ok(metric.detail.note.includes('3 of 4 selected segments were not assessed'), metric.detail.note);
});

test('a trajectory that assesses nothing inside the selection is unavailable, not a judgement', () => {
  const metric = eap({ status: 'judged', trajectory: [point('seg9')] }, ['seg1', 'seg2'], ['seg1', 'seg2', 'seg9']);
  assert.equal(metric.status, 'not_assessable');
  assert.deepEqual(metric.detail.outside_selection, ['seg9']);
  assert.ok(metric.missing_reason.includes('no segment of the selection'), metric.missing_reason);
});

test('one segment is one reading: a repeated point is refused, two focalizations are kept apart', () => {
  assertCode(
    () => eap({ status: 'judged', trajectory: [point('seg1'), point('seg1', { tension: 2 })] }, ['seg1']),
    'INVALID_ANNOTATIONS',
  );
  const twoVoices = eap(
    {
      status: 'judged',
      trajectory: [
        point('seg1', { focalization: 'marinarul', valence: -1 }),
        point('seg1', { focalization: 'preotul', valence: 1 }),
      ],
    },
    ['seg1'],
  );
  assert.equal(twoVoices.status, 'judged');
  assert.equal(twoVoices.coverage, 1, 'one assessed segment, read from two focalizations');
  assert.deepEqual(
    twoVoices.detail.focalization_series.map((entry) => `${entry.focalization}:${entry.segments.join(',')}`),
    ['marinarul:seg1', 'preotul:seg1'],
  );
  assert.ok(twoVoices.detail.note.includes('2 focalizations'), twoVoices.detail.note);
});

test('low tension is described and never treated as a defect', () => {
  const metric = eap({ status: 'judged', trajectory: [point('seg1', { tension: 0 }), point('seg2', { tension: 4 })] }, ['seg1', 'seg2']);
  assert.equal(metric.status, 'judged');
  assert.equal(metric.value, null, 'no scalar is derived from the series');
  assert.deepEqual(metric.detail.low_tension_segments, ['seg1']);
  assert.equal(metric.detail.min_tension, 0);
  assert.ok(metric.detail.note.includes('describes the arc'), metric.detail.note);
  assert.equal(metric.qualified, undefined, 'a quiet point does not qualify the result as a defect');
});

test('the report shows the declared chronology, the retained reading order and the real coverage', () => {
  const root = tempDir('metrics-c74-');
  try {
    const fx = buildReportFixture(root, {
      annotations: (annotations) => {
        annotations.metrics.EAP.ordering = 'story';
        annotations.metrics.EAP.trajectory = [
          { ...annotations.metrics.EAP.trajectory[0], segment_id: 'seg2', story_order: 1 },
          { ...annotations.metrics.EAP.trajectory[1], segment_id: 'seg1', story_order: 0 },
        ];
      },
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.deepEqual(bundle.metrics.EAP.trajectory.map((p) => p.segment_id), ['seg1', 'seg2']);
    assert.deepEqual(bundle.metrics.EAP.trajectory.map((p) => p.disclosure_index), [1, 0]);
    assert.deepEqual(bundle.metrics.EAP.detail.selected_segments, ['seg1']);
    assert.equal(bundle.metrics.EAP.coverage, 1);
    const view = readFileSync(join(out, '04-score-justification.md'), 'utf8');
    assert.ok(view.includes('Trajectory (ordered by story)'), view);
    assert.ok(view.includes('assessed_segments: seg1'), view);
    const metricsView = readFileSync(join(out, '03-metrics-and-indicators.md'), 'utf8');
    assert.ok(metricsView.includes('`EAP` | judged | trajectory of 2 ordered segments'), metricsView);
  } finally {
    cleanup([root]);
  }
});

test('overlapping arc membership is one population, and each selected scene is counted once', () => {
  const root = tempDir('metrics-c74-arcs-');
  try {
    const fx = buildReportFixture(root, {
      profileScopeKind: 'arc',
      arcs: ['arc1', 'arc2'],
      contextChapters: [],
      annotations: (annotations, { chapter1, chapter2 }) => {
        // Only the trajectory is under test here; the other annotations are cleared so this case
        // isolates the segment population. A scene scope admits evidence inside its scene ranges only,
        // so the quotations are anchored at the opening words of each scene.
        const anchor = (id, chapter, file) => {
          const quote = chapter.toString('utf8').slice(0, 8);
          annotations.evidence.push({ id, file, sha256: sha256(chapter), start: 0, end: Buffer.byteLength(quote, 'utf8'), quote });
          return id;
        };
        const evA = anchor('evA', chapter1, 'chapters/0001.md');
        const evB = anchor('evB', chapter2, 'chapters/0002.md');
        const eap = annotations.metrics.EAP;
        eap.emotional_fit.evidence = [evA];
        annotations.metrics = { EAP: eap };
        delete annotations.continuity;
        annotations.findings = [];
        annotations.indicators = [];
        annotations.preserved_qualities = { passages: [] };
        annotations.requirements.outcomes = [{ rule: 'stg-structure-1', output: 'arc1', outcome: 'pass', evidence: [evA] }];
        annotations.segments.push({ id: 'arc2', kind: 'arc', label: 'the second vigil', members: ['seg1'] });
        annotations.metrics.EAP.ordering = 'disclosure';
        annotations.metrics.EAP.trajectory = [
          { segment_id: 'seg2', focalization: 'marinarul', valence: -1, tension: 0, evidence: [evB], uncertainty: 'The quiet register could read as exhaustion.' },
          { segment_id: 'seg1', focalization: 'marinarul', valence: 1, tension: 2, evidence: [evA], uncertainty: 'The lift may be relief rather than hope.' },
        ];
      },
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.deepEqual(bundle.scope.population.sort(), ['arc1', 'arc2', 'seg1', 'seg2']);
    assert.deepEqual(bundle.metrics.EAP.detail.selected_segments, ['seg1', 'seg2']);
    assert.equal(bundle.metrics.EAP.coverage, 1, 'the shared scene is one assessed unit');
  } finally {
    cleanup([root]);
  }
});
