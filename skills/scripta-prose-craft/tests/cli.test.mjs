/**
 * The read-only and portable behaviour of the prose-craft CLI: it publishes nothing, so it
 * refuses any output path wherever that path points, and it runs from any directory once the
 * skill folder is copied elsewhere. The `--context` packet contract is covered by
 * `context.test.mjs` and the profile structure by `profile.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MINIMAL_PROFILE,
  OBSERVED_COMPONENT,
  SKILL_ROOT,
  inventory,
  parseEnvelope,
  runRaw,
  runValidator,
  withTempDir,
  writeJson,
  writePacket,
} from './helpers/fixtures.mjs';

test('refuses every output argument before reading or writing, wherever it points', async () => {
  await withTempDir(async (dir) => {
    const packet = await writePacket(join(dir, 'packet'));
    const inputPath = await writeJson(dir, 'profile.json', {
      ...MINIMAL_PROFILE,
      based_on_version: packet.version,
      expressive_components: [OBSERVED_COMPONENT],
    });

    const aliasDir = join(dir, 'alias');
    await mkdir(aliasDir, { recursive: true });
    await symlink(packet.dir, join(aliasDir, 'into-packet'));

    const attempts = [
      ['--out', inputPath],
      ['--output', join(packet.dir, 'nested', 'result.json')],
      ['--out', join(aliasDir, 'into-packet', 'result.json')],
      ['--publish', join(dir, 'published')],
      ['--write'],
    ];

    const before = await inventory(dir);
    for (const attempt of attempts) {
      const res = runRaw(['--input', inputPath, ...attempt]);
      assert.equal(res.status, 2, `${attempt.join(' ')}: ${res.stderr}`);
      const out = parseEnvelope(res);
      assert.equal(out.ok, false);
      assert.ok(
        out.errors.some((error) => error.startsWith('OUTPUT_NOT_SUPPORTED')),
        `${attempt.join(' ')}: ${out.errors.join('; ')}`,
      );
    }
    assert.deepEqual(await inventory(dir), before, 'no output path is ever created or modified');

    const normal = runValidator(inputPath, packet.dir);
    assert.equal(normal.status, 0, normal.stderr);
    assert.deepEqual(await inventory(dir), before, 'a successful run writes nothing either');
  });
});

test('refuses a role outside the documented vocabulary and bytes that are not valid UTF-8', async () => {
  await withTempDir(async (dir) => {
    const undeclared = await writePacket(join(dir, 'undeclared-role'), {
      extraFiles: [{ path: 'notes.txt', text: '# Notes\n', role: 'notes', artifact_id: 'notes-run' }],
    });
    const undeclaredProfile = await writeJson(dir, 'undeclared-role.json', {
      ...MINIMAL_PROFILE,
      based_on_version: undeclared.version,
    });
    const undeclaredRun = runValidator(undeclaredProfile, undeclared.dir);
    assert.equal(undeclaredRun.status, 2);
    const undeclaredEnv = parseEnvelope(undeclaredRun);
    const roleError = undeclaredEnv.errors.find((error) => error.startsWith('ROLE_UNDECLARED'));
    assert.ok(roleError, undeclaredEnv.errors.join('; '));
    assert.ok(roleError.includes('"notes"') && roleError.includes('timing'), roleError);

    // A chapter whose declared byte count and hash are correct but whose bytes are not UTF-8:
    // the encoding is the only defect, so nothing but INVALID_ENCODING may be reported.
    const damaged = Buffer.concat([
      Buffer.from('# One\n\nFirst accepted chapter', 'utf8'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('\n', 'utf8'),
    ]);
    const invalid = await writePacket(join(dir, 'invalid-encoding'), {
      chapters: [damaged, '# Two\n\nSecond accepted chapter.\n'],
    });
    const invalidProfile = await writeJson(dir, 'invalid-encoding.json', {
      ...MINIMAL_PROFILE,
      based_on_version: invalid.version,
    });
    const invalidRun = runValidator(invalidProfile, invalid.dir);
    assert.equal(invalidRun.status, 2);
    const invalidEnv = parseEnvelope(invalidRun);
    const encodingError = invalidEnv.errors.find((error) => error.startsWith('INVALID_ENCODING'));
    assert.ok(encodingError, invalidEnv.errors.join('; '));
    assert.ok(encodingError.includes('0001-chapter.md'), encodingError);
    assert.deepEqual(
      invalidEnv.errors.filter((error) => /^BYTE_MISMATCH|^HASH_MISMATCH/.test(error)),
      [],
      'the declared bytes and hash are correct, so only the encoding is refused',
    );
  });
});

test('runs when the skill folder is copied outside the repository', async () => {
  await withTempDir(async (dir) => {
    const outside = join(dir, 'outside');
    const copied = join(outside, 'scripta-prose-craft');
    await mkdir(outside, { recursive: true });
    await cp(SKILL_ROOT, copied, { recursive: true });

    const packet = await writePacket(join(outside, 'packet'));
    const inputPath = await writeJson(outside, 'profile.json', {
      ...MINIMAL_PROFILE,
      based_on_version: packet.version,
      expressive_components: [OBSERVED_COMPONENT],
    });

    const scratch = join(outside, 'scratch');
    await mkdir(scratch, { recursive: true });
    const copiedScript = join(copied, 'scripts', 'validate-profile.mjs');
    const res = spawnSync(process.execPath, [copiedScript, '--input', inputPath, '--context', packet.dir], {
      encoding: 'utf8',
      cwd: scratch,
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.trim());
    assert.equal(out.ok, true, res.stderr);
    assert.equal(out.context.version, packet.version);
    assert.ok(copiedScript.startsWith(outside), 'the copied script, not the repository one, produced this result');
  });
});
