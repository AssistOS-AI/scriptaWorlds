// C64: a semantic judgement, indicator, trajectory, finding or preserved passage must rest on evidence
// from the selected text. A quotation outside the selection is refused with EVIDENCE_OUT_OF_SCOPE; a
// judgement whose evidence is entirely in the declared context chapters is demoted, not scored; and a
// metric's coverage reflects the text its evidence actually touched, not the count of dimensions.
import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildEvidenceScope } from '../scripts/lib/selection.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runReport, sha256, tempDir } from './helpers.mjs';

function csCite(a, id) {
  for (const dimension of Object.values(a.metrics.CS.dimensions)) dimension.evidence = [id];
}

test('buildEvidenceScope separates selected text, declared context and out-of-scope bytes', () => {
  const selection = {
    chapters: [1],
    contextChapters: [2],
    ranges: [{ file: 'chapters/0001.md', chapter: 1, start: 0, end: 100 }],
  };
  const chapterByPath = new Map([
    ['chapters/0001.md', 1],
    ['chapters/0002.md', 2],
  ]);
  const scopeOf = buildEvidenceScope({ selection, chapterByPath });
  assert.equal(scopeOf({ file: 'chapters/0001.md', start: 0, end: 50 }), 'selected');
  assert.equal(scopeOf({ file: 'chapters/0001.md', start: 0, end: 100 }), 'selected');
  // A quote in the selected chapter but outside the declared scene range is out of scope.
  assert.equal(scopeOf({ file: 'chapters/0001.md', start: 150, end: 160 }), 'out');
  // A quote that straddles the declared scene range is not fully inside it.
  assert.equal(scopeOf({ file: 'chapters/0001.md', start: 90, end: 120 }), 'out');
  // A quote in a declared context chapter explains but never scores.
  assert.equal(scopeOf({ file: 'chapters/0002.md', start: 0, end: 10 }), 'context');
  // A chapter outside both is out of scope.
  assert.equal(scopeOf({ file: 'chapters/0003.md', start: 0, end: 10 }), 'out');
});

test('a valid chapter-2 quote under a chapter-1 selection with no context is refused', () => {
  const root = tempDir('evidence-scope-out-');
  try {
    const fx = buildReportFixture(root, {
      scopeChapters: [1],
      contextChapters: [],
      annotations: (a) => csCite(a, 'ev3'),
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 2, env.stdout);
    assert.equal(env.envelope.code, 'EVIDENCE_OUT_OF_SCOPE');
    assert.ok(env.envelope.error.includes('ev3'), env.envelope.error);
    assert.ok(!existsSync(out), 'a refused report publishes nothing');
  } finally {
    cleanup([root]);
  }
});

test('a judgement whose evidence is entirely context is demoted, not scored', () => {
  const root = tempDir('evidence-scope-context-');
  try {
    const fx = buildReportFixture(root, {
      scopeChapters: [1],
      contextChapters: [2],
      annotations: (a) => csCite(a, 'ev3'),
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.metrics.CS.status, 'not_assessable');
    assert.equal(bundle.metrics.CS.value, null);
    assert.ok(bundle.metrics.CS.missing_reason.includes('context'), bundle.metrics.CS.missing_reason);
    // EAP still cites a selected chapter-1 point, so it keeps its judgement.
    assert.equal(bundle.metrics.EAP.status, 'judged');
  } finally {
    cleanup([root]);
  }
});

test('a scene scope refuses a quote in the selected chapter but outside the scene range', () => {
  const root = tempDir('evidence-scope-scene-');
  try {
    const text1 = 'alfa bravo charlie delta echo foxtrot golf hotel india juliett';
    const chapter1 = Buffer.from(text1, 'utf8');
    const half = Buffer.byteLength('alfa bravo charlie delta echo', 'utf8');
    const quote = 'foxtrot';
    const start = Buffer.byteLength('alfa bravo charlie delta echo ', 'utf8');
    const end = start + Buffer.byteLength(quote, 'utf8');
    const fx = buildReportFixture(root, {
      chapters: { 1: text1, 2: 'kilo lima mike' },
      profileScopeKind: 'scene',
      segments: ['seg1'],
      contextChapters: [],
      noContinuity: true,
      annotations: (a) => {
        a.segments = [{ id: 'seg1', chapter: 1, kind: 'scene', label: 'first half', start: 0, end: half }];
        a.evidence = [
          { id: 'e-out', file: 'chapters/0001.md', sha256: sha256(chapter1), start, end, quote },
        ];
        a.metrics = {
          CS: {
            status: 'judged',
            evaluator: 'human-1',
            dimensions: {
              referential_clarity: { rating: 3, rationale: 'clear', evidence: ['e-out'] },
              discourse_connection: { rating: 3, rationale: 'clear', evidence: ['e-out'] },
              causal_support: { rating: 3, rationale: 'clear', evidence: ['e-out'] },
              temporal_intelligibility: { rating: 3, rationale: 'clear', evidence: ['e-out'] },
            },
          },
        };
        a.indicators = [];
        a.preserved_qualities = { passages: [] };
        delete a.requirements;
      },
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 2, env.stdout);
    assert.equal(env.envelope.code, 'EVIDENCE_OUT_OF_SCOPE');
  } finally {
    cleanup([root]);
  }
});

test('a full-book selection with evidence in one chapter reports honest coverage, not 1', () => {
  const root = tempDir('evidence-scope-book-');
  try {
    const fx = buildReportFixture(root, {
      profileScopeKind: 'book',
      scopeChapters: [],
      contextChapters: [],
      annotations: (a) => csCite(a, 'ev1'),
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.deepEqual(bundle.scope.chapters, [1, 2]);
    assert.equal(bundle.metrics.CS.status, 'judged');
    assert.equal(bundle.metrics.CS.value, 75);
    assert.equal(bundle.metrics.CS.coverage, 0.5, 'one evidenced chapter of two is honest coverage');
  } finally {
    cleanup([root]);
  }
});

test('the fixture default stays green: all evidence lies in the selected chapter', () => {
  const root = tempDir('evidence-scope-default-');
  try {
    const fx = buildReportFixture(root);
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.metrics.CS.status, 'judged');
    assert.equal(bundle.metrics.CS.value, 75);
    assert.equal(bundle.metrics.EAP.status, 'judged');
    assert.equal(bundle.metrics.CS.coverage, 1, 'chapter 1 alone is the selection and it is evidenced');
  } finally {
    cleanup([root]);
  }
});
