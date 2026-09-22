// C07 — one accepted-version and assessment-packet contract.
//
// Every rejection below is the shared §8.3 vocabulary, so a host can act on a
// refused packet without knowing which skill produced the answer. Each case also
// asserts the two properties that make a refusal safe: nothing is written to
// --out, and the packet stays byte-identical.

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeVersionIdentity,
  errorCodes,
  exists,
  makePacket,
  parseEnvelope,
  runReview,
  sha256,
  snapshotTree,
} from './helpers.mjs';

const root = await mkdtemp(join(tmpdir(), 'continuity-packet-'));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

let caseCounter = 0;

// Run the review over a fixture and assert the refusal shape of a rejected packet.
async function expectRefusal(name, packetDir, { codes, run = {} } = {}) {
  const before = (await exists(packetDir)) ? await snapshotTree(packetDir) : null;
  const out = join(root, `out-${name}`);
  const result = await runReview(['--input', packetDir, '--out', out]);
  const envelope = parseEnvelope(result);
  assert.equal(result.code, 2, `${name}: exit code; errors ${JSON.stringify(envelope.errors)}`);
  assert.equal(envelope.ok, false, `${name}: ok flag`);
  assert.deepEqual(envelope.findings, [], `${name}: a refused packet reviews nothing`);
  assert.deepEqual(envelope.counts, {
    eligible_comparisons: 0,
    consistent: 0,
    contradicted: 0,
    unresolved: 0,
  });
  assert.equal(await exists(out), false, `${name}: nothing may be written to --out`);
  for (const message of envelope.errors) {
    assert.match(message, /^[A-Z_]+: \S/, `${name}: every refusal names its code first`);
  }
  if (codes) {
    assert.deepEqual([...new Set(errorCodes(envelope))].sort(), [...codes].sort(), `${name}: refusal codes`);
  }
  if (before !== null) {
    const after = await snapshotTree(packetDir);
    assert.deepEqual(after, before, `${name}: the packet is byte-identical after a refusal`);
  }
  if (run.extra) run.extra(envelope);
  return envelope;
}

async function fixture(name, opts) {
  caseCounter += 1;
  return makePacket(join(root, `${name}-${caseCounter}`), opts);
}

async function tamperManifest(packetDir, mutate) {
  const path = join(packetDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const next = mutate(manifest) ?? manifest;
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

describe('accepted-version identity (contracts §8.2)', () => {
  test('two accepted versions of one universe have different content identities', async () => {
    const a = await fixture('version-a', { chapterTexts: { '0001-scene.md': '# One\n\nFirst text.\n' } });
    const b = await fixture('version-b', { chapterTexts: { '0001-scene.md': '# One\n\nOther text.\n' } });
    assert.notEqual(a.version, b.version);
    assert.match(a.version, /^sha256:[0-9a-f]{64}$/);
    // The fixture computes the identity straight from §8.2, so a loader that
    // reused its own arithmetic cannot hide behind the fixture.
    assert.equal(a.version, computeVersionIdentity(a.manifest.files));
  });

  test('the identity covers chapter, offer, canon, threads and atlas only', async () => {
    const base = await fixture('roles', {});
    const withOffer = {
      path: 'chapters/0001-offer.json',
      text: '{"teaser":"t","options":[]}\n',
      role: 'offer',
      artifact_id: 'offer-0001',
    };
    const withMeta = {
      path: 'meta/universe.json',
      text: '{"value":{"law":"Another law."}}\n',
      role: 'meta',
      artifact_id: 'meta-2',
    };
    const a = await fixture('roles-offer', { extraFiles: [withOffer] });
    const b = await fixture('roles-meta', { extraFiles: [withMeta] });
    assert.notEqual(a.version, base.version, 'an offer is part of the accepted narrative content');
    assert.equal(b.version, base.version, 'meta is excluded: the server rewrites it on every turn');

    const withDesign = {
      path: 'design/story-design.json',
      text: '{"arcs":[]}\n',
      role: 'design',
      artifact_id: 'story-design',
    };
    const c = await fixture('roles-design', { extraFiles: [withDesign] });
    assert.equal(c.version, base.version, 'a design is an assessment input, not accepted content');

    for (const [index, parsed] of [a, b, c].entries()) {
      const envelope = parseEnvelope(
        await runReview(['--input', parsed.packetDir, '--out', join(root, `roles-out-${index}`)]),
      );
      assert.equal(envelope.version, parsed.version, 'the result records the packet version it was bound to');
    }
  });
});

describe('a malformed packet is refused with one coded reason each', () => {
  test('a missing packet directory is MISSING_CONTEXT', async () => {
    await expectRefusal('missing-input', join(root, 'not-a-packet'), { codes: ['MISSING_CONTEXT'] });
  });

  test('a packet without a manifest is MISSING_MANIFEST', async () => {
    const { packetDir } = await fixture('no-manifest', {});
    await unlink(join(packetDir, 'manifest.json'));
    await expectRefusal('no-manifest', packetDir, { codes: ['MISSING_MANIFEST'] });
  });

  test('a manifest that is not JSON is BAD_JSON', async () => {
    const { packetDir } = await fixture('bad-json', {});
    await writeFile(join(packetDir, 'manifest.json'), '{ not json\n', 'utf8');
    await expectRefusal('bad-json', packetDir, { codes: ['BAD_JSON'] });
  });

  test('an unknown and a superseded schema_version are both SCHEMA_VERSION', async () => {
    const unknown = await fixture('schema-unknown', {});
    await tamperManifest(unknown.packetDir, (manifest) => ({ ...manifest, schema_version: 'assessment-input.v3' }));
    await expectRefusal('schema-unknown', unknown.packetDir, { codes: ['SCHEMA_VERSION'] });

    const legacy = await fixture('schema-legacy', {});
    await tamperManifest(legacy.packetDir, (manifest) => ({ ...manifest, schema_version: 'assessment-input.v1' }));
    const envelope = await expectRefusal('schema-legacy', legacy.packetDir, { codes: ['SCHEMA_VERSION'] });
    assert.match(envelope.errors[0], /superseded/);
  });

  test('a duplicate path is DUPLICATE_PATH', async () => {
    const { packetDir } = await fixture('dup-path', {});
    await tamperManifest(packetDir, (manifest) => {
      manifest.files.push({ ...manifest.files[0] });
      return manifest;
    });
    await expectRefusal('dup-path', packetDir, { codes: ['DUPLICATE_PATH'] });
  });

  test('a duplicate artifact_id and a duplicate chapter are both named', async () => {
    const { packetDir } = await fixture('dup-artifact', {
      chapters: ['0001-a.md', '0001-b.md'],
      tamperManifest: (manifest) => {
        // Two chapter entries for chapter 1: the manifest is inconsistent in the
        // artifact identifier and in the chapter number at once.
        manifest.files[1].artifact_id = manifest.files[0].artifact_id;
        manifest.files[1].chapter = 1;
        manifest.scope.chapters = [1];
        return manifest;
      },
    });
    await expectRefusal('dup-artifact', packetDir, {
      codes: ['DUPLICATE_ARTIFACT_ID', 'DUPLICATE_CHAPTER'],
    });
  });

  test('an absolute path and a traversal path are PATH_ESCAPE', async () => {
    const absolute = await fixture('abs-path', {});
    await tamperManifest(absolute.packetDir, (manifest) => {
      manifest.files[0].path = '/etc/passwd';
      return manifest;
    });
    await expectRefusal('abs-path', absolute.packetDir, { codes: ['PATH_ESCAPE'] });

    const traversal = await fixture('dotdot-path', {});
    await tamperManifest(traversal.packetDir, (manifest) => {
      manifest.files[0].path = '../outside.md';
      return manifest;
    });
    await expectRefusal('dotdot-path', traversal.packetDir, { codes: ['PATH_ESCAPE'] });
  });

  test('a symlink that leaves the packet is PATH_ESCAPE', async () => {
    const { packetDir } = await fixture('symlink', {});
    const outside = join(root, 'outside-chapter.md');
    const text = '# Outside\n\nNot part of the packet.\n';
    await writeFile(outside, text, 'utf8');
    await symlink(outside, join(packetDir, 'escaped.md'));
    await tamperManifest(packetDir, (manifest) => {
      manifest.files.push({
        path: 'escaped.md',
        sha256: sha256(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        role: 'design',
        artifact_id: 'escaped',
      });
      return manifest;
    });
    await expectRefusal('symlink', packetDir, { codes: ['PATH_ESCAPE'] });
  });

  test('a declared file that does not exist is MISSING_FILE', async () => {
    const { packetDir } = await fixture('missing-file', {});
    await unlink(join(packetDir, 'chapters/0001-scene.md'));
    await expectRefusal('missing-file', packetDir, { codes: ['MISSING_FILE'] });
  });

  test('a byte-count mismatch is BYTE_MISMATCH and a hash mismatch is HASH_MISMATCH', async () => {
    const bytes = await fixture('byte-mismatch', {});
    await tamperManifest(bytes.packetDir, (manifest) => {
      manifest.files[0].bytes += 1;
      return manifest;
    });
    await expectRefusal('byte-mismatch', bytes.packetDir, { codes: ['BYTE_MISMATCH'] });

    const hash = await fixture('hash-mismatch', {});
    await tamperManifest(hash.packetDir, (manifest) => {
      manifest.files[0].sha256 = 'f'.repeat(64);
      return manifest;
    });
    await expectRefusal('hash-mismatch', hash.packetDir, { codes: ['HASH_MISMATCH'] });
  });

  test('a declared version that is not the recomputed identity is VERSION_MISMATCH', async () => {
    const { packetDir } = await fixture('version-mismatch', {});
    await tamperManifest(packetDir, (manifest) => {
      manifest.version = `sha256:${'0'.repeat(64)}`;
      return manifest;
    });
    const envelope = await expectRefusal('version-mismatch', packetDir, { codes: ['VERSION_MISMATCH'] });
    assert.match(envelope.errors[0], /recomputed/);
  });

  test('an undeclared role is ROLE_UNDECLARED', async () => {
    const { packetDir } = await fixture('role', {});
    await tamperManifest(packetDir, (manifest) => {
      manifest.files[0].role = 'banana';
      return manifest;
    });
    await expectRefusal('role', packetDir, { codes: ['ROLE_UNDECLARED'] });
  });

  test('file bytes that are not valid UTF-8 are INVALID_ENCODING', async () => {
    const { packetDir } = await fixture('encoding', {});
    const bytes = Buffer.from([0x23, 0x20, 0x4f, 0x6e, 0x65, 0x0a, 0xff, 0xfe, 0x0a]);
    await writeFile(join(packetDir, 'chapters/0001-scene.md'), bytes);
    await tamperManifest(packetDir, (manifest) => {
      const entry = manifest.files.find((file) => file.path === 'chapters/0001-scene.md');
      entry.bytes = bytes.length;
      entry.sha256 = sha256(bytes);
      manifest.version = computeVersionIdentity(manifest.files);
      return manifest;
    });
    await expectRefusal('encoding', packetDir, { codes: ['INVALID_ENCODING'] });
  });

  test('a complete packet with an interior chapter missing is SCOPE_INCOMPLETE', async () => {
    const { packetDir } = await fixture('interior-gap', {
      chapters: ['0001-a.md', '0003-c.md'],
      lastAccepted: 3,
      kind: 'complete',
    });
    const envelope = await expectRefusal('interior-gap', packetDir, { codes: ['SCOPE_INCOMPLETE'] });
    assert.match(envelope.errors.join(' '), /interior chapter 2/);
  });

  test('a complete packet that omits a required state role is SCOPE_INCOMPLETE', async () => {
    const { packetDir } = await fixture('no-atlas', { atlas: null, kind: 'complete' });
    await expectRefusal('no-atlas', packetDir, { codes: ['SCOPE_INCOMPLETE'] });
  });

  test('a scope that declares a chapter the packet does not contain is SCOPE_INCOMPLETE', async () => {
    const { packetDir } = await fixture('declared-absent', {
      tamperManifest: (manifest) => {
        manifest.scope.chapters = [1, 2, 3];
        return manifest;
      },
    });
    await expectRefusal('declared-absent', packetDir, { codes: ['SCOPE_INCOMPLETE'] });
  });

  test('a scope that omits a chapter the packet contains is SCOPE_INCONSISTENT', async () => {
    const { packetDir } = await fixture('undeclared-prose', {
      tamperManifest: (manifest) => {
        manifest.scope.chapters = [1];
        return manifest;
      },
    });
    await expectRefusal('undeclared-prose', packetDir, { codes: ['SCOPE_INCONSISTENT'] });
  });

  test('a partial packet with an undeclared interior gap is SCOPE_INCONSISTENT', async () => {
    const { packetDir } = await fixture('partial-gap', {
      chapters: ['0001-a.md', '0003-c.md'],
      lastAccepted: 3,
      kind: 'partial',
      omitted: [],
    });
    await expectRefusal('partial-gap', packetDir, { codes: ['SCOPE_INCONSISTENT'] });
  });

  test('a complete packet that declares omissions is SCOPE_INCONSISTENT', async () => {
    const { packetDir } = await fixture('complete-omits', {
      kind: 'complete',
      tamperManifest: (manifest) => {
        manifest.scope.omitted = [1];
        return manifest;
      },
    });
    await expectRefusal('complete-omits', packetDir, { codes: ['SCOPE_INCONSISTENT'] });
  });

  test('a textual_only packet that carries a state container is SCOPE_INCONSISTENT', async () => {
    const { packetDir } = await fixture('textual-state', { kind: 'textual_only' });
    await expectRefusal('textual-state', packetDir, { codes: ['SCOPE_INCONSISTENT'] });
  });
});

describe('a declared scope is honoured rather than assumed', () => {
  test('a partial packet with a declared omission is reviewed, and says what it left out', async () => {
    const { packetDir } = await fixture('partial-declared', {
      chapters: ['0001-a.md', '0003-c.md'],
      lastAccepted: 3,
      kind: 'partial',
      omitted: [2],
    });
    const out = join(root, 'partial-declared-out');
    const result = await runReview(['--input', packetDir, '--out', out]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 0);
    assert.equal(envelope.scope.kind, 'partial');
    assert.deepEqual(envelope.scope.chapters, [1, 3]);
    assert.deepEqual(envelope.scope.omitted, [2]);
    assert.match(envelope.scope.coverage_note, /declared omitted: 2/);
    assert.ok(
      envelope.warnings.some((warning) => /partial/.test(warning)),
      'a partial packet must say that the omission has no continuity context',
    );
  });

  test('a textual_only packet states that no continuity context was available', async () => {
    const { packetDir } = await fixture('textual-only', {
      canon: null,
      threads: null,
      atlas: null,
      universe: null,
      kind: 'textual_only',
    });
    const envelope = parseEnvelope(await runReview(['--input', packetDir, '--out', join(root, 'textual-only-out')]));
    assert.equal(envelope.scope.kind, 'textual_only');
    assert.match(envelope.scope.coverage_note, /no canon, threads or atlas were available/);
    assert.match(envelope.scope.coverage_note, /nothing here implies a clean book/);
    assert.ok(envelope.warnings.some((warning) => /not part of this packet/.test(warning)));
  });

  test('a clean complete packet is accepted and reports the version it reviewed', async () => {
    const { packetDir, version } = await fixture('clean', {});
    const out = join(root, 'clean-out');
    const envelope = parseEnvelope(await runReview(['--input', packetDir, '--out', out]));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.version, version);
    assert.deepEqual(envelope.findings, []);
    assert.deepEqual(envelope.errors, []);
    assert.equal(envelope.scope.kind, 'complete');
    assert.deepEqual(envelope.scope.chapters_reviewed, [1, 2]);
    assert.deepEqual(envelope.counts, {
      eligible_comparisons: 0,
      consistent: 0,
      contradicted: 0,
      unresolved: 0,
    });
    assert.match(envelope.scope.coverage_note, /No annotations supplied/);
  });
});
