/**
 * context.test.mjs — the `--context` packet: the accepted-version identity, staleness of a
 * brief against another version of the same book, tampering, path containment, the declared
 * scope and the role and encoding rules of §8.3. The design brief's own rules live in
 * design.test.mjs, and the command-line surface in cli.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { envelope, minimalBrief, run, sha256Hex, useWorkspace } from './helpers/fixtures.mjs';

const ws = useWorkspace('story-design-context-');

test('accepts a brief written against the packet version and refuses it as stale against another version of the same book', async () => {
  const versionA = await ws.packet('ctx-version-a');
  const versionB = await ws.packet('ctx-version-b', {
    chapters: ['# One\n\nFirst accepted chapter, revised.\n', '# Two\n\nSecond accepted chapter.\n'],
  });
  assert.notEqual(versionA.version, versionB.version, 'two versions of one book must differ');
  assert.equal(versionA.manifest.universe_id, versionB.manifest.universe_id);

  const manifestBytesBefore = await readFile(join(versionA.dir, 'manifest.json'));
  const chapterBytesBefore = await readFile(join(versionA.dir, 'chapters', '0001-chapter.md'));

  const forVersionA = await ws.design('ctx-version-a.json', minimalBrief({ based_on_version: versionA.version }));
  const againstA = run(['--input', forVersionA, '--context', versionA.dir]);
  assert.equal(againstA.status, 0, againstA.stderr);
  const acceptedEnv = envelope(againstA);
  assert.equal(acceptedEnv.ok, true);
  assert.deepEqual(acceptedEnv.errors, []);
  assert.deepEqual(acceptedEnv.warnings, []);

  const againstB = run(['--input', forVersionA, '--context', versionB.dir]);
  assert.equal(againstB.status, 2);
  const staleEnv = envelope(againstB);
  assert.equal(staleEnv.ok, false);
  const stale = staleEnv.errors.find((error) => error.startsWith('STALE_BASED_ON_VERSION'));
  assert.ok(stale, staleEnv.errors.join('; '));
  assert.ok(stale.includes(versionA.version), 'the version the brief names is reported');
  assert.ok(stale.includes(versionB.version), 'the accepted version is reported');

  const forVersionB = await ws.design('ctx-version-b.json', minimalBrief({ based_on_version: versionB.version }));
  const acceptedForB = run(['--input', forVersionB, '--context', versionB.dir]);
  assert.equal(acceptedForB.status, 0, acceptedForB.stderr);
  assert.equal(envelope(acceptedForB).ok, true);

  assert.deepEqual(await readFile(join(versionA.dir, 'manifest.json')), manifestBytesBefore);
  assert.deepEqual(await readFile(join(versionA.dir, 'chapters', '0001-chapter.md')), chapterBytesBefore);
});

test('rejects tampered packet bytes by hash and by byte count', async () => {
  const sameLength = await ws.packet('ctx-tampered-hash');
  await writeFile(join(sameLength.dir, 'chapters', '0001-chapter.md'), '# One\n\nOther accepted chapter.\n');
  const brief = await ws.design('ctx-tampered.json', minimalBrief({ based_on_version: sameLength.version }));
  const hashed = run(['--input', brief, '--context', sameLength.dir]);
  assert.equal(hashed.status, 2);
  const hashedEnv = envelope(hashed);
  const hashError = hashedEnv.errors.find((error) => error.startsWith('HASH_MISMATCH'));
  assert.ok(hashError, hashedEnv.errors.join('; '));
  assert.ok(hashError.includes('chapters/0001-chapter.md'));

  const resized = await ws.packet('ctx-tampered-bytes');
  await writeFile(join(resized.dir, 'canon.md'), '# Canon\n\nwith more text than declared\n');
  const sized = run(['--input', brief, '--context', resized.dir]);
  assert.equal(sized.status, 2);
  const sizedEnv = envelope(sized);
  const byteError = sizedEnv.errors.find((error) => error.startsWith('BYTE_MISMATCH'));
  assert.ok(byteError, sizedEnv.errors.join('; '));
  assert.ok(byteError.includes('canon.md'));
});

test('refuses a manifest that declares another accepted version', async () => {
  const packet = await ws.packet('ctx-wrong-version', {
    manifestOverride: { version: `sha256:${'b'.repeat(64)}` },
  });
  const brief = await ws.design('ctx-wrong-version.json', minimalBrief({ based_on_version: packet.version }));
  const result = run(['--input', brief, '--context', packet.dir]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  const mismatch = env.errors.find((error) => error.startsWith('VERSION_MISMATCH'));
  assert.ok(mismatch, env.errors.join('; '));
  assert.ok(mismatch.includes('b'.repeat(64)) && mismatch.includes(packet.version));
});

test('refuses a context directory without a manifest and a manifest detached from its files', async () => {
  const empty = ws.path('ctx-no-manifest');
  await mkdir(empty, { recursive: true });
  const brief = await ws.design('ctx-no-manifest.json', minimalBrief({ based_on_version: `sha256:${'c'.repeat(64)}` }));

  const missingManifest = run(['--input', brief, '--context', empty]);
  assert.equal(missingManifest.status, 2);
  assert.ok(envelope(missingManifest).errors.some((error) => error.startsWith('MISSING_MANIFEST')));

  const packet = await ws.packet('ctx-detached-source');
  const detached = ws.path('ctx-detached');
  await mkdir(detached, { recursive: true });
  const detachedManifest = join(detached, 'manifest.json');
  await writeFile(detachedManifest, JSON.stringify(packet.manifest, null, 2));

  const mismatched = run(['--input', brief, '--context', detachedManifest]);
  assert.equal(mismatched.status, 2);
  const env = envelope(mismatched);
  assert.equal(env.errors.length, packet.manifest.files.length);
  assert.ok(env.errors.every((error) => error.startsWith('MISSING_FILE')), env.errors.join('; '));
});

test('refuses a packet file that escapes through a symlink even when its hash matches', async () => {
  const outside = ws.path('outside-timing.md');
  await writeFile(outside, '# Canon\n');
  const packet = await ws.packet('ctx-symlink', {
    extraFiles: [{ path: 'linked-canon.md', text: '# Canon\n', role: 'timing', artifact_id: 'timing-run' }],
  });
  const link = join(packet.dir, 'linked-canon.md');
  await rm(link);
  await symlink(outside, link);

  const brief = await ws.design('ctx-symlink.json', minimalBrief({ based_on_version: packet.version }));
  const result = run(['--input', brief, '--context', packet.dir]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  const escape = env.errors.find((error) => error.startsWith('PATH_ESCAPE'));
  assert.ok(escape, env.errors.join('; '));
  assert.ok(escape.includes('symlink'));
  assert.ok(escape.includes('linked-canon.md'));
});

test('refuses an absolute path, a traversal path and a duplicate artifact_id', async () => {
  const traversal = await ws.packet('ctx-traversal', {
    manifestOverride: {
      files: [
        {
          path: '../outside-tamper.md',
          sha256: sha256Hex('x'),
          bytes: 1,
          role: 'timing',
          artifact_id: 'timing-run',
        },
      ],
    },
  });
  const brief = await ws.design('ctx-traversal.json', minimalBrief({ based_on_version: traversal.version }));
  const escaped = run(['--input', brief, '--context', traversal.dir]);
  assert.equal(escaped.status, 2);
  assert.ok(envelope(escaped).errors.some((error) => error.startsWith('PATH_ESCAPE')));

  const duplicate = await ws.packet('ctx-duplicate-artifact', {
    extraFiles: [{ path: 'copy-canon.md', text: '# Canon\n', role: 'timing', artifact_id: 'canon' }],
  });
  const duplicateRun = run(['--input', brief, '--context', duplicate.dir]);
  assert.equal(duplicateRun.status, 2);
  assert.ok(envelope(duplicateRun).errors.some((error) => error.startsWith('DUPLICATE_ARTIFACT_ID')));
});

test('enforces the declared scope: a complete packet must carry every chapter and the state roles', async () => {
  const gap = await ws.packet('ctx-complete-gap', {
    chapters: ['# One\n', '# Three\n'],
    chapterNumbers: [1, 3],
    kind: 'complete',
    omitted: [],
  });
  const brief = await ws.design('ctx-scope.json', minimalBrief({ based_on_version: gap.version }));
  const incomplete = run(['--input', brief, '--context', gap.dir]);
  assert.equal(incomplete.status, 2);
  const gapEnv = envelope(incomplete);
  assert.ok(gapEnv.errors.some((error) => error.startsWith('SCOPE_INCOMPLETE') && error.includes('chapter 2')), gapEnv.errors.join('; '));

  const partial = await ws.packet('ctx-partial', {
    chapters: ['# One\n', '# Three\n'],
    chapterNumbers: [1, 3],
    kind: 'partial',
    omitted: [2],
  });
  const partialBrief = await ws.design('ctx-partial.json', minimalBrief({ based_on_version: partial.version }));
  const declared = run(['--input', partialBrief, '--context', partial.dir]);
  assert.equal(declared.status, 0, declared.stderr);
  assert.equal(envelope(declared).ok, true);

  const undeclared = await ws.packet('ctx-partial-undeclared', {
    chapters: ['# One\n', '# Three\n'],
    chapterNumbers: [1, 3],
    kind: 'partial',
    omitted: [],
  });
  const silentBrief = await ws.design('ctx-partial-undeclared.json', minimalBrief({ based_on_version: undeclared.version }));
  const silent = run(['--input', silentBrief, '--context', undeclared.dir]);
  assert.equal(silent.status, 2);
  assert.ok(envelope(silent).errors.some((error) => error.startsWith('SCOPE_INCONSISTENT')));

  const noAtlas = await ws.packet('ctx-no-atlas', { stateRoles: ['canon', 'threads'] });
  const noAtlasBrief = await ws.design('ctx-no-atlas.json', minimalBrief({ based_on_version: noAtlas.version }));
  const withoutAtlas = run(['--input', noAtlasBrief, '--context', noAtlas.dir]);
  assert.equal(withoutAtlas.status, 2);
  const withoutAtlasEnv = envelope(withoutAtlas);
  assert.ok(withoutAtlasEnv.errors.some((error) => error.startsWith('SCOPE_INCOMPLETE') && error.includes('atlas')), withoutAtlasEnv.errors.join('; '));
});

test('refuses a superseded assessment-input.v1 manifest explicitly', async () => {
  const packet = await ws.packet('ctx-superseded');
  const brief = await ws.design('ctx-superseded.json', minimalBrief({ based_on_version: packet.version }));
  const result = run(['--input', brief, '--context', ws.path('ctx-superseded')]);
  assert.equal(result.status, 0, 'a v2 packet is accepted');

  const legacyDir = ws.path('ctx-legacy');
  await mkdir(legacyDir, { recursive: true });
  await writeFile(
    join(legacyDir, 'manifest.json'),
    JSON.stringify({ schema_version: 'assessment-input.v1', book: { universe_id: 'arhiva-cenusii' }, files: [] }),
  );
  const legacy = run(['--input', brief, '--context', legacyDir]);
  assert.equal(legacy.status, 2);
  const env = envelope(legacy);
  const refused = env.errors.find((error) => error.startsWith('SCHEMA_VERSION'));
  assert.ok(refused, env.errors.join('; '));
  assert.ok(refused.includes('assessment-input.v2'));
});

test('keeps assessment inputs out of the accepted version identity', async () => {
  const plain = await ws.packet('ctx-plain');
  const annotated = await ws.packet('ctx-annotated', {
    extraFiles: [
      {
        path: 'annotations/run.json',
        text: '{"schema_version":"annotations.v1","evidence":[]}\n',
        role: 'annotations',
        artifact_id: 'annotations-run',
      },
      { path: 'design/notes.md', text: '# Design notes\n', role: 'design', artifact_id: 'design-notes' },
      { path: 'timing/run.json', text: '{"schema_version":"timing.v1"}\n', role: 'timing', artifact_id: 'timing-run' },
    ],
  });
  assert.equal(
    annotated.version,
    plain.version,
    'the design, annotations and timing roles are inputs to an assessment, not accepted narrative content',
  );

  const brief = await ws.design('ctx-annotated.json', minimalBrief({ based_on_version: annotated.version }));
  const result = run(['--input', brief, '--context', annotated.dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(envelope(result).ok, true);
});

test('enforces the declared textual-only scope', async () => {
  const only = await ws.packet('ctx-textual', {
    stateRoles: [],
    kind: 'textual_only',
    scopeChapters: [1, 2],
  });
  const brief = await ws.design('ctx-textual.json', minimalBrief({ based_on_version: only.version }));
  const accepted = run(['--input', brief, '--context', only.dir]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(envelope(accepted).ok, true);

  const withState = await ws.packet('ctx-textual-state', {
    stateRoles: ['canon'],
    kind: 'textual_only',
    scopeChapters: [1, 2],
  });
  const stateBrief = await ws.design('ctx-textual-state.json', minimalBrief({ based_on_version: withState.version }));
  const refused = run(['--input', stateBrief, '--context', withState.dir]);
  assert.equal(refused.status, 2);
  const refusedEnv = envelope(refused);
  assert.ok(
    refusedEnv.errors.some((error) => error.startsWith('SCOPE_INCONSISTENT') && error.includes('canon')),
    refusedEnv.errors.join('; '),
  );
});

test('refuses an unknown schema version and a duplicate manifest path', async () => {
  const packet = await ws.packet('ctx-unknown-schema');
  const brief = await ws.design('ctx-unknown-schema.json', minimalBrief({ based_on_version: packet.version }));
  const manifestPath = join(packet.dir, 'manifest.json');

  const unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  unknown.schema_version = 'assessment-input.v9';
  await writeFile(manifestPath, JSON.stringify(unknown, null, 2));
  const refusedSchema = run(['--input', brief, '--context', packet.dir]);
  assert.equal(refusedSchema.status, 2);
  const schemaEnv = envelope(refusedSchema);
  assert.ok(
    schemaEnv.errors.some((error) => error.startsWith('SCHEMA_VERSION') && error.includes('assessment-input.v9')),
    schemaEnv.errors.join('; '),
  );

  const duplicated = JSON.parse(await readFile(manifestPath, 'utf8'));
  duplicated.schema_version = 'assessment-input.v2';
  duplicated.files = [...duplicated.files, { ...duplicated.files[0], artifact_id: 'chapter-0001-copy' }];
  await writeFile(manifestPath, JSON.stringify(duplicated, null, 2));
  const refusedPath = run(['--input', brief, '--context', packet.dir]);
  assert.equal(refusedPath.status, 2);
  const pathEnv = envelope(refusedPath);
  assert.ok(
    pathEnv.errors.some((error) => error.startsWith('DUPLICATE_PATH')),
    pathEnv.errors.join('; '),
  );
});

test('refuses an undeclared role and bytes that are not valid UTF-8', async () => {
  const packet = await ws.packet('ctx-role-and-encoding');
  const brief = await ws.design('ctx-role-and-encoding.json', minimalBrief({ based_on_version: packet.version }));
  const manifestPath = join(packet.dir, 'manifest.json');

  const foreignText = '# Canon\n';
  await writeFile(join(packet.dir, 'extra.md'), foreignText);
  const undeclared = JSON.parse(await readFile(manifestPath, 'utf8'));
  undeclared.files = [
    ...undeclared.files,
    {
      path: 'extra.md',
      sha256: sha256Hex(foreignText),
      bytes: Buffer.byteLength(foreignText, 'utf8'),
      role: 'banana',
      artifact_id: 'banana-run',
    },
  ];
  await writeFile(manifestPath, JSON.stringify(undeclared, null, 2));
  const refusedRole = run(['--input', brief, '--context', packet.dir]);
  assert.equal(refusedRole.status, 2);
  const roleEnv = envelope(refusedRole);
  const roleError = roleEnv.errors.find((error) => error.startsWith('ROLE_UNDECLARED'));
  assert.ok(roleError, roleEnv.errors.join('; '));
  assert.ok(roleError.includes('banana'), roleError);

  const badBytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
  await writeFile(join(packet.dir, 'timing.json'), badBytes);
  const mistyped = JSON.parse(await readFile(manifestPath, 'utf8'));
  mistyped.files = [
    ...mistyped.files.filter((entry) => entry.artifact_id !== 'banana-run'),
    {
      path: 'timing.json',
      sha256: createHash('sha256').update(badBytes).digest('hex'),
      bytes: badBytes.length,
      role: 'timing',
      artifact_id: 'timing-run',
    },
  ];
  await writeFile(manifestPath, JSON.stringify(mistyped, null, 2));
  const refusedEncoding = run(['--input', brief, '--context', packet.dir]);
  assert.equal(refusedEncoding.status, 2);
  const encodingEnv = envelope(refusedEncoding);
  const encodingError = encodingEnv.errors.find((error) => error.startsWith('INVALID_ENCODING'));
  assert.ok(encodingError, encodingEnv.errors.join('; '));
  assert.ok(encodingError.includes('timing.json'), encodingError);
});

test('warns instead of passing silently when based_on_version has no context', async () => {
  const brief = await ws.design('unchecked-version.json', minimalBrief({ based_on_version: `sha256:${'d'.repeat(64)}` }));
  const result = run(['--input', brief]);
  assert.equal(result.status, 0, result.stderr);
  const env = envelope(result);
  assert.equal(env.ok, true);
  assert.deepEqual(env.errors, []);
  assert.ok(
    env.warnings.some((warning) => warning.includes('based_on_version') && warning.includes('--context')),
    env.warnings.join('; '),
  );
});
