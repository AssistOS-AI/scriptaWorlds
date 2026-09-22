// C73: corpus source identity is a declaration that was checked, never a hash guess.
//
// A reference is the candidate's own source version only when it declares the same candidate
// source and version, and that declaration matches the packet the report read. Identical bytes
// from a reference that declares nothing are an independent reference carrying duplicate text:
// the case overlap measurement exists to find, and therefore never removed from the comparison.

import test from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { classifyReferences } from '../scripts/lib/overlap.mjs';
import { loadCorpusManifest } from '../scripts/lib/corpus.mjs';
import { CHAPTER_1 } from './report-fixture.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runReport, sha256, tempDir, writeFile, writeJson } from './helpers.mjs';

const VERSION = `sha256:${'a'.repeat(64)}`;
const OTHER_VERSION = `sha256:${'b'.repeat(64)}`;
const candidate = { id: 'test-universe', version: VERSION, hashes: new Set([`${'c'.repeat(64)}`]) };

function reference(overrides = {}) {
  return {
    id: 'ref',
    sha256: `${'c'.repeat(64)}`,
    permitted_use: 'comparison',
    ...overrides,
  };
}

test('identical bytes from a reference that declares no source identity stay eligible and say so', () => {
  const { eligible, exclusions } = classifyReferences([reference()], candidate);
  assert.deepEqual(exclusions, [], 'a hash is not a declaration of identity');
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].identity.status, 'unknown');
  assert.equal(eligible[0].identity.bytes_match_candidate, true);
  assert.ok(/declares no source identity/.test(eligible[0].identity.note), eligible[0].identity.note);
});

test('a reference is the same source version only when it declares the candidate source and version', () => {
  const declared = reference({ id: 'self', source: { id: 'test-universe', version: VERSION } });
  const { eligible, exclusions } = classifyReferences([declared], candidate);
  assert.deepEqual(eligible, []);
  assert.deepEqual(exclusions.map((entry) => `${entry.id}:${entry.reason}`), ['self:same_source_version']);
  assert.equal(exclusions[0].identity.verified, true);
  assert.equal(exclusions[0].identity.declared.id, 'test-universe');
});

test('a declaration is not trusted when it names another source or another version', () => {
  const otherSource = reference({ id: 'other-book', source: { id: 'another-universe', version: VERSION } });
  const otherVersion = reference({ id: 'older', source: { id: 'test-universe', version: OTHER_VERSION } });
  const { eligible, exclusions } = classifyReferences([otherSource, otherVersion], candidate);
  assert.deepEqual(exclusions, []);
  assert.deepEqual(
    eligible.map((entry) => `${entry.id}:${entry.identity.status}`),
    ['other-book:independent', 'older:same_source_other_version'],
  );
  // `verified` says the declaration was checked against the candidate's identity, not that it matched.
  assert.equal(eligible[0].identity.verified, true);
  assert.equal(eligible[1].identity.verified, true);
  // With no candidate identity to check against, the declaration is recorded as unverified.
  const unchecked = classifyReferences([otherSource], { id: null, version: null, hashes: new Set() });
  assert.equal(unchecked.eligible[0].identity.status, 'unverified_declaration');
  assert.equal(unchecked.eligible[0].identity.verified, false);
});

test('a partially declared identity is refused at the manifest boundary instead of being guessed at', () => {
  const root = tempDir('metrics-identity-');
  try {
    const text = Buffer.from('alpha bravo charlie delta echo foxtrot golf hotel', 'utf8');
    writeFile(root, 'reference.txt', text);
    const partial = { id: 'ref1', path: 'reference.txt', sha256: sha256(text), language: 'en' };
    for (const [label, source] of [['half', { id: 'test-universe' }], ['vague', { id: 'test-universe', version: VERSION, held_out: true }]]) {
      const manifestPath = writeJson(root, `${label}.json`, { schema_version: 'corpus.v1', references: [{ ...partial, source }] });
      assert.throws(
        () => loadCorpusManifest(manifestPath),
        (error) => error.code === 'INVALID_CORPUS',
        `${label} must be refused`,
      );
    }
    // A complete declaration loads, and a manifest that declares nothing loads with a null identity.
    const ok = writeJson(root, 'ok.json', {
      schema_version: 'corpus.v1',
      references: [{ ...partial, source: { id: 'test-universe', version: VERSION } }],
    });
    const loaded = loadCorpusManifest(ok);
    assert.deepEqual(loaded.references[0].source, { id: 'test-universe', version: VERSION });
    const silent = writeJson(root, 'silent.json', { schema_version: 'corpus.v1', references: [partial] });
    assert.equal(loadCorpusManifest(silent).references[0].source, null);
  } finally {
    cleanup([root]);
  }
});

test('an independent full copy of a selected chapter produces the full overlap', () => {
  const root = tempDir('metrics-copy-');
  try {
    const fx = buildReportFixture(root, { referenceText: CHAPTER_1 });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.deepEqual(bundle.provenance.corpus.exclusions, [], 'identical bytes are not a self-comparison');
    assert.equal(bundle.metrics.SI.status, 'computed');
    assert.equal(bundle.metrics.SI.value, 1);
    assert.equal(bundle.metrics.TOP.status, 'computed');
    assert.equal(bundle.metrics.TOP.value, 100);
    const [pair] = bundle.metrics.SI.detail.pairs;
    assert.equal(pair.reference, 'ref1');
    assert.equal(pair.duplicate_text, true, 'the copied text is named as duplicate text');
    assert.equal(pair.duplicate_of, 'candidate');
    assert.equal(pair.identity.status, 'unknown');
  } finally {
    cleanup([root]);
  }
});

test('a declared and verified self-comparison is the only reference excluded from the measurement', () => {
  const root = tempDir('metrics-self-');
  try {
    const fx = buildReportFixture(root, {
      referenceText: CHAPTER_1,
      // The declaration has to be written before the packet exists, so the fixture fills in the
      // version it computed; the report then checks it against the packet it read.
      reference: (packet) => ({ source: { id: 'test-universe', version: packet.version } }),
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.deepEqual(
      bundle.provenance.corpus.exclusions.map((entry) => `${entry.id}:${entry.reason}`),
      ['ref1:same_source_version'],
    );
    for (const id of ['SI', 'TOP']) {
      assert.equal(bundle.metrics[id].status, 'not_assessable', id);
      assert.ok(bundle.metrics[id].missing_reason.includes('excluded'), bundle.metrics[id].missing_reason);
    }
  } finally {
    cleanup([root]);
  }
});

test('a whitespace-only variant stays eligible and is named as duplicate text, not as self-comparison', () => {
  const root = tempDir('metrics-space-');
  try {
    const fx = buildReportFixture(root, { referenceText: `  ${CHAPTER_1.replace(/ /g, '  ')}\n` });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.deepEqual(bundle.provenance.corpus.exclusions, []);
    assert.equal(bundle.metrics.SI.value, 1);
    assert.equal(bundle.metrics.SI.detail.pairs[0].duplicate_text, true);
    assert.equal(bundle.metrics.SI.detail.pairs[0].identity.bytes_match_candidate, false);
  } finally {
    cleanup([root]);
  }
});

test('a copy of part of a selected chapter keeps the overlap below the whole', () => {
  const root = tempDir('metrics-partial-');
  try {
    const partial = CHAPTER_1.split(' ').slice(0, 10).join(' ');
    const fx = buildReportFixture(root, { referenceText: `${partial}.` });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.deepEqual(bundle.provenance.corpus.exclusions, []);
    assert.equal(bundle.metrics.SI.status, 'computed');
    assert.ok(bundle.metrics.SI.value > 0 && bundle.metrics.SI.value < 1, `SI ${bundle.metrics.SI.value}`);
    assert.ok(bundle.metrics.TOP.value > 0 && bundle.metrics.TOP.value < 100, `TOP ${bundle.metrics.TOP.value}`);
  } finally {
    cleanup([root]);
  }
});
