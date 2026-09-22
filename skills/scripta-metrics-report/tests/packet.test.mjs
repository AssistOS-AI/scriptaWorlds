import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadPacket, computeAcceptedVersion } from '../scripts/lib/input.mjs';
import { CliError } from '../scripts/lib/errors.mjs';
import { buildPacket, cleanup, sha256, symlinkSync, tempDir, writeFile, writeJson } from './helpers.mjs';

/** Assert that `fn` refuses with the shared §8.3 rejection code. */
function assertCode(fn, code) {
  let error = null;
  try {
    fn();
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, `expected a refusal with code ${code}`);
  assert.ok(error instanceof CliError, `expected a CliError, got ${error && error.name}`);
  assert.equal(error.code, code, `${error.code}: ${error.message}`);
  assert.equal(error.exitCode, 2);
  return error;
}

function withPacket(options, body) {
  const root = tempDir('metrics-packet-');
  try {
    const packet = buildPacket(root, options);
    return body(root, packet);
  } finally {
    cleanup([root]);
  }
}

test('a valid complete packet loads with the independently recomputed version', () => {
  withPacket({}, (root, fixture) => {
    const packet = loadPacket(root);
    assert.equal(packet.version, fixture.version);
    assert.equal(packet.version, computeAcceptedVersion(packet.files));
    assert.equal(packet.universeId, 'test-universe');
    assert.deepEqual(packet.inventory, [1, 2]);
    assert.deepEqual(packet.scope.omitted, []);
    assert.deepEqual(packet.scope.missing, []);
    assert.equal(packet.scope.kind, 'complete');
    assert.equal(packet.chapterByNumber.get(2).path, 'chapters/0002.md');
    assert.ok(packet.hasRole('canon'));
    assert.equal(packet.manifestPath, join(root, 'manifest.json'));
  });
});

test('a declared partial packet distinguishes a declared omission from a missing interior chapter', () => {
  withPacket(
    { chapters: { 1: 'chapter one text', 3: 'chapter three text' }, lastAccepted: 3, scopeKind: 'partial', omitted: [2] },
    (root) => {
      const packet = loadPacket(root);
      assert.equal(packet.scope.kind, 'partial');
      assert.deepEqual(packet.scope.chapters, [1, 3]);
      assert.deepEqual(packet.scope.omitted, [2]);
      assert.deepEqual(packet.scope.missing, [2]);
    },
  );

  // The same packet declared complete is a malformed complete packet.
  withPacket(
    { chapters: { 1: 'chapter one text', 3: 'chapter three text' }, lastAccepted: 3, scopeKind: 'complete', omitted: [] },
    (root) => {
      const error = assertCode(() => loadPacket(root), 'SCOPE_INCOMPLETE');
      assert.ok(error.message.includes('interior chapter 2'), error.message);
    },
  );

  // A partial packet that omits a chapter without declaring it is inconsistent.
  withPacket(
    { chapters: { 1: 'chapter one text', 3: 'chapter three text' }, lastAccepted: 3, scopeKind: 'partial', omitted: [] },
    (root) => {
      const error = assertCode(() => loadPacket(root), 'SCOPE_INCONSISTENT');
      assert.ok(error.message.includes('without declaring'), error.message);
    },
  );
});

test('a complete packet missing a required state role is SCOPE_INCOMPLETE', () => {
  withPacket({ stateRoles: ['canon', 'threads'] }, (root) => {
    const error = assertCode(() => loadPacket(root), 'SCOPE_INCOMPLETE');
    assert.ok(error.message.includes('atlas'), error.message);
  });
});

test('a complete packet that declares omissions is SCOPE_INCONSISTENT', () => {
  withPacket({ omitted: [2], scopeKind: 'complete', stateRoles: ['canon', 'threads', 'atlas'] }, (root) => {
    assertCode(() => loadPacket(root), 'SCOPE_INCONSISTENT');
  });
});

test('a textual_only packet is prose alone and must not carry a state container', () => {
  withPacket({ stateRoles: [], scopeKind: 'textual_only' }, (root) => {
    const packet = loadPacket(root);
    assert.equal(packet.scope.kind, 'textual_only');
    assert.equal(packet.hasRole('canon'), false);
  });
  withPacket({ stateRoles: ['canon'], scopeKind: 'textual_only' }, (root) => {
    const error = assertCode(() => loadPacket(root), 'SCOPE_INCONSISTENT');
    assert.ok(error.message.includes('canon'), error.message);
  });
});

test('scope.chapters must match the chapter files the packet carries', () => {
  withPacket({ scopeChapters: [1] }, (root) => {
    assertCode(() => loadPacket(root), 'SCOPE_INCONSISTENT');
  });
  withPacket(
    { chapters: { 1: 'chapter one text', 3: 'chapter three text' }, lastAccepted: 3, scopeKind: 'partial', omitted: [2], scopeChapters: [1, 2, 3] },
    (root) => {
      const packet = loadPacket(root);
      assert.deepEqual(packet.scope.chapters, [1, 3]);
    },
  );
});

test('an undeclared role and duplicate entries are refused with their own codes', () => {
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files[0].role = 'banana';
    writeJson(root, 'manifest.json', manifest);
    assertCode(() => loadPacket(root), 'ROLE_UNDECLARED');
  });
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files.push({ ...manifest.files[0], artifact_id: 'chapter-0001-copy', path: 'chapters/0001.md' });
    writeJson(root, 'manifest.json', manifest);
    assertCode(() => loadPacket(root), 'DUPLICATE_PATH');
  });
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files[2].artifact_id = manifest.files[1].artifact_id;
    writeJson(root, 'manifest.json', manifest);
    assertCode(() => loadPacket(root), 'DUPLICATE_ARTIFACT_ID');
  });
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    const duplicate = { ...manifest.files[0], artifact_id: 'chapter-0012', path: 'chapters/0001-copy.md' };
    const body = Buffer.from('another body for chapter 1\n', 'utf8');
    writeFile(root, 'chapters/0001-copy.md', body);
    duplicate.sha256 = sha256(body);
    duplicate.bytes = body.length;
    manifest.files.push(duplicate);
    writeJson(root, 'manifest.json', manifest);
    const error = assertCode(() => loadPacket(root), 'DUPLICATE_CHAPTER');
    assert.ok(error.message.includes('chapter 1'), error.message);
  });
});

test('path escapes are refused: absolute, parent traversal and a symlink out of the packet', () => {
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files[0].path = '/etc/hostname';
    writeJson(root, 'manifest.json', manifest);
    assertCode(() => loadPacket(root), 'PATH_ESCAPE');
  });
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files[0].path = '../outside.md';
    writeJson(root, 'manifest.json', manifest);
    assertCode(() => loadPacket(root), 'PATH_ESCAPE');
  });
  const outside = tempDir('metrics-outside-');
  try {
    const body = Buffer.from('a chapter that lives outside the packet\n', 'utf8');
    const outsideFile = writeFile(outside, 'escaped.md', body);
    withPacket({}, (root, fixture) => {
      const manifest = JSON.parse(JSON.stringify(fixture.manifest));
      manifest.files[0].path = 'chapters/escaped.md';
      manifest.files[0].sha256 = sha256(body);
      manifest.files[0].bytes = body.length;
      manifest.files[0].artifact_id = 'chapter-0001';
      mkdirSync(join(root, 'chapters'), { recursive: true });
      symlinkSync(outsideFile, join(root, 'chapters', 'escaped.md'));
      writeJson(root, 'manifest.json', manifest);
      const error = assertCode(() => loadPacket(root), 'PATH_ESCAPE');
      assert.ok(error.message.includes('symlink escape'), error.message);
    });
  } finally {
    cleanup([outside]);
  }
});

test('a missing file, byte mismatch, hash mismatch and invalid encoding are refused', () => {
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files[0].path = 'chapters/0009.md';
    writeJson(root, 'manifest.json', manifest);
    assertCode(() => loadPacket(root), 'MISSING_FILE');
  });
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files[0].bytes += 1;
    writeJson(root, 'manifest.json', manifest);
    assertCode(() => loadPacket(root), 'BYTE_MISMATCH');
  });
  withPacket({}, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files[0].sha256 = '0'.repeat(64);
    writeJson(root, 'manifest.json', manifest);
    assertCode(() => loadPacket(root), 'HASH_MISMATCH');
  });
  withPacket({ chapterBytes: (number, buffer) => (number === 1 ? Buffer.concat([buffer, Buffer.from([0xff, 0xfe])]) : buffer) }, (root, fixture) => {
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    const buffer = Buffer.concat([Buffer.from('chapter one text', 'utf8'), Buffer.from([0xff, 0xfe])]);
    manifest.files[0].sha256 = sha256(buffer);
    manifest.files[0].bytes = buffer.length;
    writeJson(root, 'manifest.json', manifest);
    const error = assertCode(() => loadPacket(root), 'INVALID_ENCODING');
    assert.ok(error.message.includes('UTF-8'), error.message);
  });
});

test('a tampered chapter with a stale declared version is a VERSION_MISMATCH', () => {
  const root = tempDir('metrics-packet-');
  try {
    const fixture = buildPacket(root, {});
    const tampered = Buffer.from('a completely rewritten chapter body\n', 'utf8');
    writeFile(root, 'chapters/0001.md', tampered);
    // The declared bytes and hash are corrected, but the version identity is
    // not: the packet is no longer the version it declares.
    const manifest = JSON.parse(JSON.stringify(fixture.manifest));
    manifest.files[0].sha256 = sha256(tampered);
    manifest.files[0].bytes = tampered.length;
    writeJson(root, 'manifest.json', manifest);
    const error = assertCode(() => loadPacket(root), 'VERSION_MISMATCH');
    assert.ok(error.message.includes('recomputed'), error.message);
    assert.equal(fixture.version.startsWith('sha256:'), true);
  } finally {
    cleanup([root]);
  }
});

test('a missing manifest, a missing packet and invalid JSON have distinct codes', () => {
  const root = tempDir('metrics-packet-');
  try {
    assertCode(() => loadPacket(join(root, 'nowhere')), 'MISSING_CONTEXT');
    const noManifest = join(root, 'empty');
    mkdirSync(noManifest);
    assertCode(() => loadPacket(noManifest), 'MISSING_MANIFEST');
    const broken = join(root, 'broken');
    mkdirSync(broken);
    writeFileSync(join(broken, 'manifest.json'), '{ not json');
    assertCode(() => loadPacket(broken), 'BAD_JSON');
  } finally {
    cleanup([root]);
  }
});

test('a superseded v1 manifest is refused by naming the supported schema', () => {
  const root = tempDir('metrics-packet-');
  try {
    writeJson(root, 'manifest.json', { schema_version: 'assessment-input.v1', files: [] });
    const error = assertCode(() => loadPacket(root), 'SCHEMA_VERSION');
    assert.ok(error.message.includes('assessment-input.v2'), error.message);
    assert.ok(error.message.includes('superseded'), error.message);
  } finally {
    cleanup([root]);
  }
});
