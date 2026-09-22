import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runCli, tempDir } from './helpers.mjs';

/**
 * Two ten-token chapters. Only chapter 2 overlaps the reference, so a chapter
 * scope has to be visible in the denominator and in the matched bytes.
 */
const CHAPTER_1 = 'alfa bravo charlie delta echo foxtrot golf hotel india juliett';
const CHAPTER_2 = 'kilo lima mike november oscar papa quebec romeo sierra tango';
const REFERENCE = `${CHAPTER_2} uniform victor whiskey`;

function run(fx, out) {
  return runCli(['--input', fx.packetDir, '--out', out, '--profile', fx.profilePath, '--annotations', fx.annotationsPath, '--corpus', fx.corpusPath]);
}

function baseFixture(root, options = {}) {
  return buildReportFixture(root, {
    chapters: { 1: CHAPTER_1, 2: CHAPTER_2 },
    referenceText: REFERENCE,
    contextChapters: [],
    ...options,
  });
}

test('the selected chapter governs the denominator and the matched bytes', () => {
  const root = tempDir('metrics-scope-');
  try {
    const chapter1 = baseFixture(join(root, 'chapter-1'), { scopeChapters: [1] });
    const first = run(chapter1, join(root, 'chapter-1', 'out'));
    assert.equal(first.status, 0, first.stdout);
    const firstBundle = readJson(join(root, 'chapter-1', 'out', 'assessment.json'));
    assert.deepEqual(firstBundle.scope.chapters, [1]);
    assert.equal(firstBundle.coverage.tokenizer.eligible_tokens, 10, 'chapter 1 has ten tokens');
    assert.equal(firstBundle.metrics.TOP.detail.eligible_tokens, 10);
    assert.equal(firstBundle.metrics.TOP.status, 'computed');
    assert.equal(firstBundle.metrics.TOP.value, 0, 'chapter 1 shares nothing with the reference');
    assert.equal(firstBundle.metrics.TOP.detail.matched_positions, 0);
    assert.equal(firstBundle.metrics.TOP.evidence.length, 0);
    const range = firstBundle.scope.ranges[0];
    assert.equal(range.chapter, 1);
    assert.equal(range.start, 0);
    assert.equal(range.end, Buffer.byteLength(CHAPTER_1, 'utf8'), 'the measured bytes are chapter 1 alone');
    assert.equal(firstBundle.metrics.SI.value, 0);

    const second = baseFixture(join(root, 'chapter-2'), { scopeChapters: [2], ruleOutputs: [2] });
    const secondRun = run(second, join(root, 'chapter-2', 'out'));
    assert.equal(secondRun.status, 0, secondRun.stdout);
    const secondBundle = readJson(join(root, 'chapter-2', 'out', 'assessment.json'));
    assert.deepEqual(secondBundle.scope.chapters, [2]);
    assert.equal(secondBundle.coverage.tokenizer.eligible_tokens, 10, 'chapter 2 keeps its own denominator');
    assert.equal(secondBundle.metrics.TOP.value, 100);
    assert.equal(secondBundle.metrics.TOP.detail.matched_positions, 10);
    assert.equal(secondBundle.metrics.TOP.detail.eligible_tokens, 10);
    assert.equal(secondBundle.metrics.SI.detail.maximum_reference, 'ref1');
    assert.equal(secondBundle.scope.ranges[0].end, Buffer.byteLength(CHAPTER_2, 'utf8'));

    const book = baseFixture(join(root, 'book'), { profileScopeKind: 'book', scopeChapters: [] });
    const bookRun = run(book, join(root, 'book', 'out'));
    assert.equal(bookRun.status, 0, bookRun.stdout);
    const bookBundle = readJson(join(root, 'book', 'out', 'assessment.json'));
    assert.deepEqual(bookBundle.scope.chapters, [1, 2], 'a book scope covers the complete inventory');
    assert.deepEqual(bookBundle.coverage.packet_chapters, [1, 2]);
    assert.equal(bookBundle.coverage.tokenizer.eligible_tokens, 20);
    assert.equal(bookBundle.metrics.TOP.detail.matched_positions, 10);
    assert.equal(bookBundle.metrics.TOP.value, 50, 'ten matched tokens out of twenty');
  } finally {
    cleanup([root]);
  }
});

test('a book scope needs a complete packet, and unknown, duplicate or invalid chapters are refused', () => {
  const root = tempDir('metrics-scope-');
  try {
    const fx = baseFixture(join(root, 'fx'), { scopeChapters: [1] });

    const unknown = baseFixture(join(root, 'unknown'), { scopeChapters: [999] });
    const unknownOut = join(root, 'unknown', 'out');
    const unknownRun = run(unknown, unknownOut);
    assert.equal(unknownRun.status, 2);
    assert.equal(unknownRun.envelope.code, 'UNKNOWN_CHAPTER');
    assert.ok(unknownRun.envelope.error.includes('999'), unknownRun.envelope.error);
    assert.ok(!existsSync(unknownOut), 'a refused scope writes nothing');

    const duplicate = baseFixture(join(root, 'duplicate'), { scopeChapters: [1, 1] });
    const duplicateRun = run(duplicate, join(root, 'duplicate', 'out'));
    assert.equal(duplicateRun.status, 2);
    assert.equal(duplicateRun.envelope.code, 'INVALID_PROFILE');

    const zero = baseFixture(join(root, 'zero'), { scopeChapters: [0] });
    const zeroRun = run(zero, join(root, 'zero', 'out'));
    assert.equal(zeroRun.status, 2);
    assert.equal(zeroRun.envelope.code, 'INVALID_PROFILE');

    // A book scope refuses a packet that is not complete.
    const partial = baseFixture(join(root, 'partial-book'), {
      chapters: { 1: CHAPTER_1 },
      lastAccepted: 2,
      profileScopeKind: 'book',
      scopeChapters: [],
      scopeKind: 'partial',
      omitted: [2],
    });
    const partialRun = runCli([
      '--input',
      partial.packetDir,
      '--out',
      join(root, 'partial-book', 'out'),
      '--profile',
      partial.profilePath,
    ]);
    assert.equal(partialRun.status, 2, partialRun.stdout);
    assert.equal(partialRun.envelope.code, 'INCOMPLETE_PACKET');

    // Context must be material outside the selection.
    const overlappingContext = buildReportFixture(join(root, 'context'), {
      chapters: { 1: CHAPTER_1, 2: CHAPTER_2 },
      referenceText: REFERENCE,
      scopeChapters: [1],
      contextChapters: [1],
    });
    const contextRun = run(overlappingContext, join(root, 'context', 'out'));
    assert.equal(contextRun.status, 2);
    assert.equal(contextRun.envelope.code, 'INVALID_PROFILE');

    assert.equal(fx.packet.version, unknown.packet.version, 'the fixtures share the same chapter bytes');
  } finally {
    cleanup([root]);
  }
});

test('a scene scope measures only its byte ranges and an arc cannot double-count them', () => {
  const root = tempDir('metrics-scene-');
  try {
    const words = (
      'alfa bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november oscar papa quebec romeo sierra tango'
    ).split(' ');
    const text = words.join(' ');
    const half = Buffer.byteLength(words.slice(0, 10).join(' '), 'utf8');
    const total = Buffer.byteLength(text, 'utf8');
    const segments = [
      { id: 'seg1', chapter: 1, kind: 'scene', label: 'first half', start: 0, end: half, provenance: 'declared' },
      { id: 'seg2', chapter: 1, kind: 'scene', label: 'second half', start: half + 1, end: total, provenance: 'declared' },
      { id: 'arc1', kind: 'arc', label: 'the whole scene', members: ['seg1', 'seg2'] },
    ];
    const sceneOptions = {
      chapters: { 1: text, 2: CHAPTER_2 },
      referenceText: words.slice(10).join(' '),
      contextChapters: [],
      profileScopeKind: 'scene',
      segments: ['seg1'],
      annotations: (annotations) => {
        annotations.segments = segments;
        annotations.evidence = [annotations.evidence[0]];
        annotations.metrics = {};
        delete annotations.continuity;
        annotations.requirements.outcomes = [{ rule: 'stg-structure-1', output: 'seg1', outcome: 'pass', evidence: ['ev1'] }];
      },
    };

    const firstHalf = buildReportFixture(join(root, 'first-half'), sceneOptions);
    const firstRun = run(firstHalf, join(root, 'first-half', 'out'));
    assert.equal(firstRun.status, 0, firstRun.stdout);
    const firstBundle = readJson(join(root, 'first-half', 'out', 'assessment.json'));
    assert.deepEqual(firstBundle.scope.segments, ['seg1']);
    assert.deepEqual(firstBundle.scope.ranges, [{ file: 'chapters/0001.md', chapter: 1, start: 0, end: half }]);
    assert.equal(firstBundle.coverage.tokenizer.eligible_tokens, 10, 'only the declared range is candidate text');
    assert.equal(firstBundle.metrics.TOP.value, 0, 'the second half is outside the measured range');

    const secondHalf = buildReportFixture(join(root, 'second-half'), {
      ...sceneOptions,
      segments: ['seg2'],
      annotations: (annotations) => {
        sceneOptions.annotations(annotations);
        annotations.requirements.outcomes = [{ rule: 'stg-structure-1', output: 'seg2', outcome: 'pass', evidence: ['ev1'] }];
      },
    });
    const secondRun = run(secondHalf, join(root, 'second-half', 'out'));
    assert.equal(secondRun.status, 0, secondRun.stdout);
    const secondBundle = readJson(join(root, 'second-half', 'out', 'assessment.json'));
    assert.equal(secondBundle.coverage.tokenizer.eligible_tokens, 10);
    assert.equal(secondBundle.metrics.TOP.value, 100);

    // Overlapping arcs select the same scenes once, not twice.
    const arcs = buildReportFixture(join(root, 'arcs'), {
      ...sceneOptions,
      segments: undefined,
      profileScopeKind: 'arc',
      arcs: ['arc1', 'arc2'],
      annotations: (annotations) => {
        annotations.segments = [...segments, { id: 'arc2', kind: 'arc', label: 'only the first', members: ['seg1'] }];
        annotations.evidence = [annotations.evidence[0]];
        annotations.metrics = {};
        delete annotations.continuity;
        annotations.requirements.outcomes = [
          { rule: 'stg-structure-1', output: 'arc1', outcome: 'pass', evidence: ['ev1'] },
          { rule: 'stg-structure-1', output: 'arc2', outcome: 'pass', evidence: ['ev1'] },
        ];
      },
    });
    const arcRun = run(arcs, join(root, 'arcs', 'out'));
    assert.equal(arcRun.status, 0, arcRun.stdout);
    const arcBundle = readJson(join(root, 'arcs', 'out', 'assessment.json'));
    assert.deepEqual(arcBundle.scope.chapters, [1]);
    assert.equal(arcBundle.coverage.tokenizer.eligible_tokens, 20, 'the overlapping arc adds no token twice');
    assert.deepEqual(arcBundle.scope.population.sort(), ['arc1', 'arc2', 'seg1', 'seg2']);
  } finally {
    cleanup([root]);
  }
});

test('the selected scope governs self-exclusion and the provenance of every metric', () => {
  const root = tempDir('metrics-self-');
  try {
    // The declared reference is byte-identical to the selected chapter: it is
    // excluded as the candidate's own source version instead of being compared.
    const fx = buildReportFixture(join(root, 'self'), {
      chapters: { 1: CHAPTER_1, 2: CHAPTER_2 },
      referenceText: CHAPTER_1,
      contextChapters: [],
      scopeChapters: [1],
    });
    const out = join(root, 'self', 'out');
    const env = run(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.metrics.SI.status, 'not_assessable');
    assert.ok(bundle.metrics.SI.missing_reason.includes('excluded'), bundle.metrics.SI.missing_reason);
    assert.deepEqual(
      bundle.provenance.corpus.exclusions.map((entry) => `${entry.id}:${entry.reason}`),
      ['ref1:same_source_version'],
    );
    assert.deepEqual(bundle.provenance.selection.chapters, [1]);
    for (const [id, metric] of Object.entries(bundle.metrics)) {
      assert.deepEqual(metric.scope.chapters, [1], `${id} records the scope it covered`);
    }
    assert.equal(bundle.indicators.narrative_coherence.status, 'judged');
    assert.equal(bundle.indicators.thematic_depth.status, 'not_assessable');
  } finally {
    cleanup([root]);
  }
});

test('scene and arc scopes refuse an incomplete declaration, an unknown member and a foreign chapter', () => {
  const root = tempDir('metrics-scope-');
  try {
    const base = {
      chapters: { 1: 'alpha beta gamma delta epsilon zeta eta theta iota kappa', 2: CHAPTER_2 },
      referenceText: 'nothing in common here at all',
      contextChapters: [],
    };

    const noSegments = buildReportFixture(join(root, 'no-segments'), {
      ...base,
      profileScopeKind: 'scene',
      segments: [],
    });
    const noSegmentsRun = run(noSegments, join(root, 'no-segments', 'out'));
    assert.equal(noSegmentsRun.status, 2);
    assert.equal(noSegmentsRun.envelope.code, 'INVALID_SCOPE');
    assert.ok(noSegmentsRun.envelope.error.includes('must not fall back'), noSegmentsRun.envelope.error);

    const unknownSegment = buildReportFixture(join(root, 'unknown-segment'), {
      ...base,
      profileScopeKind: 'scene',
      segments: ['seg9'],
    });
    const unknownRun = run(unknownSegment, join(root, 'unknown-segment', 'out'));
    assert.equal(unknownRun.status, 2);
    assert.equal(unknownRun.envelope.code, 'UNKNOWN_SEGMENT');

    const foreignChapter = buildReportFixture(join(root, 'foreign-chapter'), {
      ...base,
      annotations: (annotations) => {
        annotations.segments = [{ id: 'seg1', chapter: 9, kind: 'scene', start: 0, end: 4 }];
      },
    });
    const foreignRun = run(foreignChapter, join(root, 'foreign-chapter', 'out'));
    assert.equal(foreignRun.status, 2);
    assert.equal(foreignRun.envelope.code, 'UNKNOWN_CHAPTER');

    const emptyArc = buildReportFixture(join(root, 'empty-arc'), {
      ...base,
      annotations: (annotations) => {
        annotations.segments = [{ id: 'arc1', kind: 'arc', members: [] }];
      },
    });
    const emptyArcRun = run(emptyArc, join(root, 'empty-arc', 'out'));
    assert.equal(emptyArcRun.status, 2);
    assert.ok(['INVALID_SEGMENTS', 'UNKNOWN_SEGMENT'].includes(emptyArcRun.envelope.code), emptyArcRun.envelope.code);
  } finally {
    cleanup([root]);
  }
});

test('an inferred boundary stays visibly inferred', () => {
  const root = tempDir('metrics-inferred-');
  try {
    const fx = buildReportFixture(join(root, 'fx'), {
      chapters: { 1: CHAPTER_1, 2: CHAPTER_2 },
      referenceText: REFERENCE,
      contextChapters: [],
      profileScopeKind: 'scene',
      segments: ['seg1'],
      annotations: (annotations) => {
        annotations.segments = [{ id: 'seg1', chapter: 1, kind: 'scene', label: 'the whole chapter' }];
        annotations.evidence = [annotations.evidence[0]];
        annotations.metrics = {};
        delete annotations.continuity;
        annotations.requirements.outcomes = [{ rule: 'stg-structure-1', output: 'seg1', outcome: 'pass', evidence: ['ev1'] }];
      },
    });
    const out = join(root, 'fx', 'out');
    const env = run(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.segments[0].provenance, 'inferred');
    assert.equal(bundle.coverage.tokenizer.eligible_tokens, 10, 'an inferred boundary defaults to the whole chapter');
    const metricsView = readFileSync(join(out, '03-metrics-and-indicators.md'), 'utf8');
    assert.ok(metricsView.includes('Inferred boundaries (not declared): `seg1`'), metricsView);
  } finally {
    cleanup([root]);
  }
});
