import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_RUN,
  SHINGLE_SIZE,
  candidateShingles,
  classifyReferences,
  computeSi,
  computeTop,
  jaccard,
  shingleSet,
} from '../scripts/lib/overlap.mjs';
import { TOKENIZER_VERSION, segmentationSupport, tokenize } from '../scripts/lib/tokenize.mjs';
import { computeLexical } from '../scripts/lib/lexical.mjs';
import {
  INDICATOR_IDS,
  METRIC_IDS,
  METRICS,
  RESERVED_METRIC_IDS,
  VALUE_KINDS,
} from '../scripts/lib/registry.mjs';

function spansFor(n, size = 1) {
  return Array.from({ length: n }, (_, i) => ({ start: i * size, end: (i + 1) * size }));
}

function unitsOf(id, tokens, size = 1) {
  return [
    {
      id,
      file: `${id}.md`,
      chapter: 1,
      segment_ids: [],
      tokens,
      spans: spansFor(tokens.length, size),
      indexes: tokens.map((_, index) => index),
    },
  ];
}

/**
 * An independent union of matched candidate positions: every window of at least
 * `MIN_RUN` tokens that occurs anywhere in a reference marks its positions.
 * Deliberately naive, so the implementation cannot hide a missed match.
 */
function expectedMatchedPositions(candidateTokens, referenceTokenLists) {
  const matched = new Set();
  for (const reference of referenceTokenLists) {
    for (let i = 0; i + MIN_RUN <= candidateTokens.length; i++) {
      for (let j = 0; j + MIN_RUN <= reference.length; j++) {
        let length = 0;
        while (
          i + length < candidateTokens.length &&
          j + length < reference.length &&
          candidateTokens[i + length] === reference[j + length]
        ) {
          length += 1;
        }
        if (length >= MIN_RUN) {
          for (let position = i; position < i + length; position++) matched.add(position);
        }
      }
    }
  }
  return matched;
}

test('SI Jaccard matches an independently calculated value', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f'];
  const b = ['a', 'b', 'c', 'd', 'e', 'x'];
  // Shingles: A = {abcde, bcdef}, B = {abcde, bcdex}; intersection 1, union 3.
  const si = jaccard(shingleSet(a), shingleSet(b));
  assert.ok(Math.abs(si - 1 / 3) < 1e-9);
});

test('computeSi reports the maximum over the named corpus and names that reference', () => {
  const candidate = shingleSet(['a', 'b', 'c', 'd', 'e', 'f']);
  const refs = [
    { id: 'r1', tokens: ['a', 'b', 'c', 'd', 'e', 'x'], language: 'en' },
    { id: 'r2', tokens: ['a', 'b', 'c', 'd', 'e', 'f'], language: 'en' },
  ];
  const result = computeSi(candidate, refs);
  assert.equal(result.status, 'computed');
  assert.ok(Math.abs(result.value - 1) < 1e-9);
  assert.equal(result.pairs[0].reference, 'r2');
  assert.equal(result.maximum_reference, 'r2');
  assert.equal(result.comparison_scope, 'external_corpus');
  assert.deepEqual(result.pairs.map((pair) => pair.reference), ['r2', 'r1']);
});

test('SI on empty candidate shingles is not_assessable', () => {
  const result = computeSi(new Set(), [{ id: 'r1', tokens: ['a', 'b', 'c', 'd', 'e'] }]);
  assert.equal(result.status, 'not_assessable');
  assert.equal(result.value, null);
  assert.ok(result.missing_reason.includes(`${SHINGLE_SIZE}-token`));
});

test('a reference too short for the shingle size leaves SI unavailable, never zero', () => {
  const candidate = shingleSet(['a', 'b', 'c', 'd', 'e', 'f']);
  const result = computeSi(candidate, [{ id: 'r1', tokens: ['a', 'b', 'c'] }]);
  assert.equal(result.status, 'not_assessable');
  assert.equal(result.value, null);
  assert.ok(result.missing_reason.includes('long enough'), result.missing_reason);
});

test('excluding the same source version needs a declared identity, and duplicate bytes stay eligible', () => {
  const identity = { id: 'book-1', version: 'sha256:' + 'd'.repeat(64), hashes: new Set(['a'.repeat(64)]) };
  const references = [
    { id: 'declared-copy', sha256: 'a'.repeat(64), permitted_use: 'comparison', source: { id: 'book-1', version: 'sha256:' + 'd'.repeat(64) } },
    { id: 'book', sha256: 'a'.repeat(64), permitted_use: 'comparison' },
    { id: 'other', sha256: 'b'.repeat(64), permitted_use: 'comparison' },
    { id: 'blocked', sha256: 'c'.repeat(64), permitted_use: 'none' },
  ];
  const { eligible, exclusions, classified } = classifyReferences(references, identity);
  assert.deepEqual(eligible.map((r) => r.id), ['book', 'other']);
  assert.deepEqual(
    exclusions.map((e) => `${e.id}:${e.reason}`),
    ['declared-copy:same_source_version', 'blocked:permitted_use:none'],
  );
  assert.equal(eligible[0].identity.status, 'unknown', 'a hash is not a declaration');
  assert.equal(eligible[0].identity.bytes_match_candidate, true);
  assert.deepEqual(
    classified.map((entry) => `${entry.id}:${entry.eligible}`),
    ['declared-copy:false', 'book:true', 'other:true', 'blocked:false'],
  );
});

test('duplicate text in another reference stays eligible and is named separately from self-exclusion', () => {
  const text = Buffer.from('alpha bravo charlie delta echo foxtrot golf hotel', 'utf8');
  const candidate = {
    supported: true,
    reason: null,
    units: [
      {
        id: 'u1',
        file: 'chapters/0001.md',
        chapter: 1,
        segment_ids: [],
        tokens: ['whiskey', 'xray', 'yankee', 'zulu', 'quebec', 'romeo', 'sierra', 'tango'],
        spans: spansFor(8),
        indexes: [0, 1, 2, 3, 4, 5, 6, 7],
      },
    ],
    eligible_tokens: 8,
    files: [{ path: 'chapters/0001.md', chapter: 1, sha256: 'a'.repeat(64), bytes: text.length }],
  };
  const corpus = {
    schema_version: 'corpus.v1',
    references: [
      { id: 'r1', path: 'r1.txt', sha256: 'b'.repeat(64), language: 'en', provenance: 'survey', permitted_use: 'comparison', declared_exclusions: [], bytes: text },
      { id: 'r2', path: 'r2.txt', sha256: 'c'.repeat(64), language: 'en', provenance: 'survey', permitted_use: 'comparison', declared_exclusions: [], bytes: Buffer.from(text) },
      { id: 'same-version', path: 'book.txt', sha256: 'a'.repeat(64), language: 'en', provenance: 'the packet itself', permitted_use: 'comparison', declared_exclusions: [], source: { id: 'book-1', version: 'sha256:' + 'd'.repeat(64) }, bytes: text },
      { id: 'copy', path: 'copy.txt', sha256: 'a'.repeat(64), language: 'en', provenance: 'an independent mirror', permitted_use: 'comparison', declared_exclusions: [], bytes: text },
    ],
  };
  const result = computeLexical({
    candidate,
    corpus,
    candidateIdentity: { id: 'book-1', version: 'sha256:' + 'd'.repeat(64), hashes: new Set(['a'.repeat(64)]) },
  });
  assert.equal(result.si.comparison_scope, 'external_corpus');
  const byId = new Map(result.si.pairs.map((pair) => [pair.reference, pair]));
  assert.equal(byId.get('r1').duplicate_text, true, 'two references carrying the same text are duplicates');
  assert.equal(byId.get('r1').duplicate_of, 'r2');
  assert.equal(byId.get('r2').duplicate_text, true);
  assert.equal(byId.has('same-version'), false, 'the declared candidate source version is excluded, not compared');
  assert.equal(byId.get('copy').identity.status, 'unknown', 'identical bytes without a declaration are not self-comparison');
  assert.equal(byId.get('copy').duplicate_text, true, 'a reference repeating the candidate text is named as such');
  assert.deepEqual(result.exclusions.map((e) => `${e.id}:${e.reason}`), ['same-version:same_source_version']);
  assert.ok(result.references.some((reference) => reference.id === 'r1' && reference.provenance === 'survey'));
  assert.equal(result.references.find((reference) => reference.id === 'copy').excluded_reason, null);
});

test('TOP counts a known exact run of 8 tokens', () => {
  const tokens = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'];
  const refs = [{ id: 'ref', tokens: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] }];
  const result = computeTop(unitsOf('u1', tokens), refs);
  assert.equal(result.status, 'computed');
  assert.equal(result.matched_positions, 8);
  assert.equal(result.eligible_tokens, 10);
  assert.ok(Math.abs(result.value - 80) < 1e-9);
});

test('TOP covers a match that starts inside another run: the reproduced 100% case', () => {
  const candidate = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  const reference = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'X', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  const result = computeTop(unitsOf('u1', candidate), [{ id: 'r1', tokens: reference }]);
  assert.equal(result.status, 'computed');
  assert.equal(result.eligible_tokens, 12);
  assert.equal(result.matched_positions, 12);
  assert.equal(result.value, 100);
  const expected = expectedMatchedPositions(candidate, [reference]);
  assert.equal(result.matched_positions, expected.size);
});

test('overlapping matches within one reference, across references, nested and repeated tokens', () => {
  const candidate = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  const cases = [
    { name: 'within one reference', refs: [['X', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'X', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']] },
    { name: 'across two references', refs: [candidate.slice(0, 8), candidate.slice(4)] },
    { name: 'nested in a longer run', refs: [['X', ...candidate, ...candidate, 'Y']] },
    { name: 'repeated tokens', refs: [['a', 'a', 'a', ...candidate, 'a']] },
  ];
  for (const { name, refs } of cases) {
    const result = computeTop(
      unitsOf('u1', candidate),
      refs.map((tokens, index) => ({ id: `r${index}`, tokens })),
    );
    const expected = expectedMatchedPositions(candidate, refs);
    assert.equal(result.status, 'computed', name);
    assert.equal(result.matched_positions, expected.size, `${name}: matched positions`);
    assert.equal(result.eligible_tokens, candidate.length, `${name}: denominator`);
    assert.ok(Math.abs(result.value - (100 * expected.size) / candidate.length) < 1e-9, `${name}: value`);
  }
});

test('TOP counts each eligible candidate token exactly once across matches and references', () => {
  const candidate = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const result = computeTop(unitsOf('u1', candidate), [
    { id: 'r1', tokens: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
    { id: 'r2', tokens: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
    { id: 'r3', tokens: ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
  ]);
  assert.equal(result.matched_positions, 10);
  assert.equal(result.value, 100);
  const positions = new Set();
  for (const span of result.spans) {
    for (let token = span.token_start; token < span.token_end; token++) positions.add(token);
  }
  assert.equal(positions.size, 10);
});

test('TOP keeps the token-to-byte mapping on both sides of a match', () => {
  const tokens = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const candidate = unitsOf('u1', tokens, 3);
  const referenceTokens = ['z', ...tokens];
  const result = computeTop(candidate, [
    { id: 'r1', tokens: referenceTokens, spans: spansFor(referenceTokens.length, 5) },
  ]);
  assert.equal(result.status, 'computed');
  const span = result.spans[0];
  assert.equal(span.file, 'u1.md');
  assert.equal(span.chapter, 1);
  assert.equal(span.token_start, 0);
  assert.equal(span.token_end, 10);
  assert.equal(span.byte_start, 0);
  assert.equal(span.byte_end, 30);
  assert.equal(span.reference_token_start, 1);
  assert.equal(span.reference_token_end, 11);
  assert.equal(span.reference_byte_start, 5);
  assert.equal(span.reference_byte_end, 55);
});

test('TOP on empty and too-short candidate text is not_assessable, never zero', () => {
  const reference = { id: 'r', tokens: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] };
  const empty = computeTop([{ file: 'x', tokens: [], spans: [] }], [reference]);
  assert.equal(empty.status, 'not_assessable');
  assert.equal(empty.value, null);
  assert.ok(empty.missing_reason.includes('empty'));
  const short = computeTop([{ file: 'x', tokens: ['a', 'b', 'c'], spans: spansFor(3) }], [reference]);
  assert.equal(short.status, 'not_assessable');
  assert.equal(short.value, null);
  assert.ok(short.missing_reason.includes(String(MIN_RUN)));
  const noReference = computeTop(unitsOf('u', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']), []);
  assert.equal(noReference.status, 'not_assessable');
  assert.ok(noReference.missing_reason.includes('no eligible reference'));
});

test('candidateShingles unions the shingles of contiguous runs only', () => {
  const units = unitsOf('u', ['a', 'b', 'c', 'd', 'e']);
  const set = candidateShingles(units);
  assert.equal(set.size, 1);
  assert.ok(set.has(['a', 'b', 'c', 'd', 'e'].join('\u0001')));
});

/* ------------------------------ tokenizer (C23) ------------------------------ */

test('the tokenizer is versioned and declares its method', () => {
  assert.equal(TOKENIZER_VERSION, 2);
  const result = tokenize(Buffer.from('un text simplu', 'utf8'), 'fixture', { language: 'ro' });
  assert.equal(result.tokenizer_version, TOKENIZER_VERSION);
  assert.equal(result.supported, true);
  assert.deepEqual(result.tokens, ['un', 'text', 'simplu']);
});

test('numbers, apostrophes, hyphens and Markdown markers are separators', () => {
  const withTwo = tokenize(Buffer.from('chapter 2: don\'t stop — the well-known # Heading', 'utf8'), 'fixture');
  const withThree = tokenize(Buffer.from('chapter 3: don\'t stop — the well-known # Heading', 'utf8'), 'fixture');
  assert.deepEqual(withTwo.tokens, withThree.tokens, 'a numeric difference is invisible to the token sequence');
  assert.deepEqual(withTwo.tokens, ['chapter', 'don', 't', 'stop', 'the', 'well', 'known', 'heading']);
  assert.equal(withTwo.tokenizer_version, TOKENIZER_VERSION);
});

test('precomposed and decomposed diacritics stay different tokens and both map to bytes', () => {
  const precomposed = Buffer.from('țărmul', 'utf8');
  const decomposed = Buffer.from('t\u0323a\u0302rmul', 'utf8');
  const a = tokenize(precomposed, 'precomposed');
  const b = tokenize(decomposed, 'decomposed');
  assert.notDeepEqual(a.tokens, b.tokens);
  assert.equal(a.tokens.length, 1);
  assert.equal(b.tokens.length, 1);
  assert.equal(a.spans[0].start, 0);
  assert.equal(a.spans[0].end, precomposed.length);
  assert.equal(b.spans[0].start, 0);
  assert.equal(b.spans[0].end, decomposed.length);
  assert.equal(
    decomposed.subarray(b.spans[0].start, b.spans[0].end).toString('utf8'),
    't\u0323a\u0302rmul',
  );
});

test('quoted text and headings are eligible tokens, and the byte mapping is exact', () => {
  const text = '# Title\n\n> quoted words here\n\nplain words too\n';
  const bytes = Buffer.from(text, 'utf8');
  const result = tokenize(bytes, 'fixture');
  assert.ok(result.tokens.includes('quoted'));
  assert.ok(result.tokens.includes('title'));
  const index = result.tokens.indexOf('quoted');
  assert.equal(Buffer.from(text, 'utf8').subarray(result.spans[index].start, result.spans[index].end).toString('utf8'), 'quoted');
  assert.equal(result.spans.at(-1).end, bytes.length - 1);
});

test('a script this method cannot segment yields an unavailable result, never a zero', () => {
  const support = segmentationSupport('zh-Hans');
  assert.equal(support.supported, false);
  assert.ok(support.reason.includes('separator'));
  const result = tokenize(Buffer.from('这是一个测试句子', 'utf8'), 'fixture', { language: 'zh' });
  assert.equal(result.supported, false);
  assert.deepEqual(result.tokens, []);
  assert.ok(result.missing_reason.includes('unsupported'));
  assert.equal(segmentationSupport('ro-RO').supported, true);
});

test('invalid UTF-8 is refused instead of being tokenized lossily', () => {
  assert.throws(() => tokenize(Buffer.from([0xff, 0xfe, 0x41]), 'fixture'), (error) => error.code === 'INVALID_UTF8');
});

/* ------------------------------ registry ------------------------------ */

test('registry integrity: twelve unique metric ids, no reserved values', () => {
  assert.equal(METRIC_IDS.length, 12);
  assert.equal(new Set(METRIC_IDS).size, 12);
  assert.deepEqual(Object.keys(METRICS).sort(), [...METRIC_IDS].sort());
  for (const id of RESERVED_METRIC_IDS) {
    assert.ok(!(id in METRICS), `reserved metric ${id} must be absent from values`);
  }
  assert.deepEqual(RESERVED_METRIC_IDS, ['VAD', 'BCI']);
});

test('registry integrity: eight unique indicator ids', () => {
  assert.equal(INDICATOR_IDS.length, 8);
  assert.equal(new Set(INDICATOR_IDS).size, 8);
});

test('every metric declares a value kind, and its range matches that kind', () => {
  for (const id of METRIC_IDS) {
    const metric = METRICS[id];
    assert.equal(metric.id, id);
    assert.ok(VALUE_KINDS.includes(metric.value_kind), `${id} value_kind`);
    if (metric.value_kind === 'trajectory') {
      assert.equal(metric.range, null, `${id} must not pretend to a scalar range`);
      assert.ok(metric.axes, `${id} declares its axes`);
    } else if (metric.value_kind === 'components') {
      if (metric.range === null) {
        assert.ok(metric.component_scale, `${id} declares its component anchors`);
      } else {
        assert.deepEqual(metric.range, [0, 100], `${id} derives a 0-100 scalar from its components`);
      }
    } else {
      assert.ok(Array.isArray(metric.range) && metric.range.length === 2, `${id} range`);
      assert.ok(metric.range[0] <= metric.range[1], `${id} range order`);
    }
  }
  assert.deepEqual(METRICS.EAP.axes, { valence: [-2, 2], tension: [0, 4] });
  assert.deepEqual(METRICS.AEG.range, [-100, 100], 'a negative efficiency gain is a real result');
});
