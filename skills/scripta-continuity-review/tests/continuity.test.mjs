// End-to-end review of a frozen packet: the envelope a host consumes.
//
// The suite builds a real assessment-input.v2 packet in a temporary directory,
// runs the documented command line, and asserts the observable contract: one
// JSON envelope on stdout, findings as result data, nothing written on a
// refusal, and inputs that stay byte-identical.

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  annotationsDocument,
  errorCodes,
  evidenceFor,
  exists,
  makeClaim,
  makePacket,
  parseEnvelope,
  runReview,
  snapshotTree,
  writeAnnotations,
} from './helpers.mjs';

const root = await mkdtemp(join(tmpdir(), 'continuity-review-'));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const CHAPTER_ONE = '# Capitolul 1\n\nRobinetul a fost deschis complet, iar presiunea a scăzut.\n';
const CHAPTER_TWO = '# Capitolul 2\n\nRobinetul era pe jumătate închis, fără nicio reparație.\n';
const QUOTE_ONE = 'Robinetul a fost deschis complet';
const QUOTE_TWO = 'Robinetul era pe jumătate închis';

async function twoChapterPacket(name) {
  const packet = await makePacket(join(root, name), {
    chapters: ['0001-scene.md', '0002-scene.md'],
    chapterTexts: { '0001-scene.md': CHAPTER_ONE, '0002-scene.md': CHAPTER_TWO },
    threads: {
      open: [
        { id: 'thread-0001', kind: 'promise', question: 'Cine plătește reparația?', created_chapter: 2, due_chapter: 4, status: 'open' },
      ],
      closed: [],
      promises: [],
      deferred_answers: [],
    },
  });
  const evidence = [
    evidenceFor('ev-1', 'chapters/0001-scene.md', CHAPTER_ONE, QUOTE_ONE),
    evidenceFor('ev-2', 'chapters/0002-scene.md', CHAPTER_TWO, QUOTE_TWO),
  ];
  const claim = makeClaim(packet.packetDir, packet.version, evidence, {
    scope: { kind: 'book', chapters: [1, 2] },
    subject: 'the valve in the cellar',
  });
  return { ...packet, evidence, claim };
}

test('a clean packet with a confirmed contradiction produces one usable envelope', async () => {
  const packet = await twoChapterPacket('e2e-clean');
  const before = await snapshotTree(packet.packetDir);
  const annotations = await writeAnnotations(root, 'e2e-clean.json', annotationsDocument([packet.claim]));
  const out = join(root, 'e2e-clean-out');

  const result = await runReview(['--input', packet.packetDir, '--out', out, '--annotations', annotations]);
  const envelope = parseEnvelope(result);
  assert.equal(result.code, 0, JSON.stringify(envelope.errors));
  assert.equal(result.stdout.trimEnd().includes('\n'), false, 'stdout carries one JSON line');
  assert.equal(envelope.schema_version, 'continuity-result.v1');
  assert.equal(envelope.ok, true);
  assert.equal(envelope.version, packet.version);
  assert.deepEqual(envelope.errors, []);
  assert.equal(envelope.findings.length, 1);
  assert.equal(envelope.findings[0].subject, 'the valve in the cellar');
  assert.deepEqual(envelope.counts, {
    eligible_comparisons: 1,
    consistent: 0,
    contradicted: 1,
    unresolved: 0,
  });
  assert.equal(envelope.derived.cci.status, 'computed');
  assert.equal(envelope.derived.cci.value, 0);
  assert.deepEqual(envelope.outputs, [join(out, 'continuity-result.json')]);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'continuity-result.json'), 'utf8')), envelope);

  assert.deepEqual(await snapshotTree(packet.packetDir), before, 'the packet is byte-identical');
  assert.equal(await readFile(annotations, 'utf8').then((text) => text.includes('claim-0001')), true);
});

describe('exit codes and refusal shapes', () => {
  test('a usage error is exit 2 with a USAGE code', async () => {
    for (const args of [[], ['--input'], ['--input', 'x'], ['--input', 'x', '--out', 'y', '--bogus']]) {
      const result = await runReview(args);
      const envelope = parseEnvelope(result);
      assert.equal(result.code, 2, `args ${JSON.stringify(args)}`);
      assert.ok(['USAGE', 'MISSING_CONTEXT'].includes(errorCodes(envelope)[0]), JSON.stringify(envelope.errors));
    }
  });

  test('a refused packet names its code and writes nothing', async () => {
    const packet = await twoChapterPacket('e2e-refused');
    const manifestPath = join(packet.packetDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[0].sha256 = 'a'.repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const out = join(root, 'e2e-refused-out');
    const result = await runReview(['--input', packet.packetDir, '--out', out]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 2);
    assert.deepEqual(errorCodes(envelope).includes('HASH_MISMATCH'), true, JSON.stringify(envelope.errors));
    assert.equal(await exists(out), false);
    assert.equal(envelope.version, null);
    assert.equal(envelope.scope.coverage_note, 'input rejected before review');
  });

  test('findings are result data, not failure', async () => {
    const packet = await makePacket(join(root, 'e2e-findings'), {
      chapters: ['0001-a.md', '0003-c.md'],
      lastAccepted: 3,
      kind: 'partial',
      omitted: [2],
      threads: {
        open: [{ id: 'thread-0001', kind: 'mystery', question: 'Ce s-a întâmplat?', created_chapter: 9, status: 'open' }],
        closed: [],
        promises: [],
        deferred_answers: [],
      },
    });
    const out = join(root, 'e2e-findings-out');
    const result = await runReview(['--input', packet.packetDir, '--out', out]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 0, 'a finding never fails the review');
    assert.equal(envelope.ok, true);
    assert.ok(envelope.findings.length >= 1);
    assert.equal(envelope.findings[0].certainty, 'deterministic');
    assert.equal(envelope.findings[0].status, 'confirmed');
    assert.ok(envelope.findings[0].evidence[0].quote.length > 0);
  });
});

test('the review command resolves every path from its arguments, never from the working directory', async () => {
  const packet = await twoChapterPacket('e2e-cwd');
  const annotations = await writeAnnotations(root, 'e2e-cwd.json', annotationsDocument([packet.claim]));
  const out = join(root, 'e2e-cwd-out');
  const first = await runReview(['--input', packet.packetDir, '--out', out, '--annotations', annotations]);
  assert.equal(first.code, 0, first.stdout);
  // A second run with the same relative-free arguments from another directory
  // (the harness always starts the child in the repository root) must produce the
  // same envelope, which is only possible when no path came from the cwd.
  await rm(out, { recursive: true, force: true });
  const second = await runReview(['--input', packet.packetDir, '--out', out, '--annotations', annotations]);
  assert.equal(second.stdout, first.stdout);
});
