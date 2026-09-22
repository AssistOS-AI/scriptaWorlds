import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyEvidenceItem } from '../scripts/lib/evidence.mjs';
import { sha256Hex } from '../scripts/lib/errors.mjs';

function itemFor(text, bytes, start, end, overrides = {}) {
  return {
    id: 'ev1',
    file: 'chapters/0001.md',
    sha256: sha256Hex(bytes),
    start,
    end,
    quote: text.slice(start, end),
    ...overrides,
  };
}

test('valid evidence item with multibyte Romanian text verifies', () => {
  const text = 'Mărțișor este o tradiție românească.';
  const bytes = Buffer.from(text, 'utf8');
  const needle = Buffer.from('românească');
  const start = bytes.indexOf(needle);
  const end = start + needle.length;
  const item = {
    id: 'ev1',
    file: 'chapters/0001.md',
    sha256: sha256Hex(bytes),
    start,
    end,
    quote: 'românească',
  };
  const result = verifyEvidenceItem(item, bytes);
  assert.equal(result.ok, true);
  assert.deepEqual(result.item, item);
});

test('a multibyte quote with correct byte offsets survives the exact-slice check', () => {
  const text = 'țărmul se vede';
  const bytes = Buffer.from(text, 'utf8');
  const quote = 'ță';
  const item = {
    id: 'ev2',
    file: 'x.md',
    sha256: sha256Hex(bytes),
    start: 0,
    end: Buffer.byteLength(quote),
    quote,
  };
  assert.equal(verifyEvidenceItem(item, bytes).ok, true);
});

test('sha256 mismatch is rejected', () => {
  const bytes = Buffer.from('hello world', 'utf8');
  const item = itemFor('hello world', bytes, 0, 5, { sha256: '0'.repeat(64) });
  const result = verifyEvidenceItem(item, bytes);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('sha256 mismatch')));
});

test('quote mismatch is rejected', () => {
  const bytes = Buffer.from('hello world', 'utf8');
  const item = itemFor('hello world', bytes, 0, 5, { quote: 'HELLO' });
  const result = verifyEvidenceItem(item, bytes);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('quote does not match')));
});

test('out-of-range end offset is rejected', () => {
  const bytes = Buffer.from('hello world', 'utf8');
  const item = itemFor('hello world', bytes, 0, bytes.length + 10);
  const result = verifyEvidenceItem(item, bytes);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('exceeds file length')));
});

test('inverted offsets are rejected', () => {
  const bytes = Buffer.from('hello world', 'utf8');
  const item = itemFor('hello world', bytes, 6, 2);
  const result = verifyEvidenceItem(item, bytes);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('offsets inverted')));
});

test('a start offset inside a multibyte character is rejected (non-UTF-8 boundary)', () => {
  const text = 'țărm';
  const bytes = Buffer.from(text, 'utf8');
  // 'ț' is two bytes; offset 1 lands on its continuation byte.
  const item = {
    id: 'ev3',
    file: 'x.md',
    sha256: sha256Hex(bytes),
    start: 1,
    end: bytes.length,
    quote: text.slice(1),
  };
  const result = verifyEvidenceItem(item, bytes);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not a UTF-8 code-point boundary')));
});

test('an end offset inside a multibyte character is rejected (non-UTF-8 boundary)', () => {
  const text = 'călător';
  const bytes = Buffer.from(text, 'utf8');
  // 'ă' is two bytes; split after its first byte.
  const end = bytes.indexOf(Buffer.from('ă')) + 1;
  const item = {
    id: 'ev4',
    file: 'x.md',
    sha256: sha256Hex(bytes),
    start: 0,
    end,
    quote: text.slice(0, 1),
  };
  const result = verifyEvidenceItem(item, bytes);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not a UTF-8 code-point boundary')));
});
