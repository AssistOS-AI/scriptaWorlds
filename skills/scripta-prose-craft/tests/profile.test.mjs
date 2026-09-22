import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { MINIMAL_PROFILE, parseEnvelope, runRaw, runValidator, withTempDir, writeJson } from './helpers/fixtures.mjs';

test('accepts a minimal valid profile', async () => {
  await withTempDir(async (dir) => {
    const inputPath = await writeJson(dir, 'profile.json', MINIMAL_PROFILE);
    const before = await readFile(inputPath);
    const res = runValidator(inputPath);
    const after = await readFile(inputPath);
    assert.deepEqual(after, before, 'input must remain byte-identical');
    assert.equal(res.status, 0, res.stderr);
    const out = parseEnvelope(res);
    assert.equal(out.schema_version, 'profile.v1');
    assert.equal(out.ok, true);
    assert.deepEqual(out.errors, []);
  });
});

test('accepts voices, devices and a formal/periodic preference without style policing', async () => {
  await withTempDir(async (dir) => {
    const profile = {
      schema_version: 'profile.v1',
      profile_id: 'p-full',
      language: 'ro',
      reader_experience: 'A formal, periodic rhythm that slows the reader down.',
      narrator: 'First-person, unreliable.',
      focalization: {
        mode: 'limited',
        limits: 'Cannot know what others think.',
        focal_character: 'alice',
      },
      register: 'Formal. Long periodic sentences are welcome; no length ban.',
      character_voices: [
        { entity_id: 'alice', notes: 'Answers indirectly to protect status.', speech_habit: 'Avoids future tense when afraid.' },
        { entity_id: 'bob', notes: 'Notices machinery before faces.' },
      ],
      recurring_devices: [
        { device: 'water motif', purpose: 'Marks emotional distance.' },
      ],
      revision_priorities: ['Preserve subtext', 'Allow long periodic sentences'],
    };
    const inputPath = await writeJson(dir, 'profile.json', profile);
    const res = runValidator(inputPath);
    assert.equal(res.status, 0, res.stderr);
    const out = parseEnvelope(res);
    assert.equal(out.ok, true);
    assert.deepEqual(out.errors, []);
  });
});

test('rejects a duplicate profile_id', async () => {
  await withTempDir(async (dir) => {
    const profile = {
      ...MINIMAL_PROFILE,
      profile_id: 'alice',
      character_voices: [{ entity_id: 'alice', notes: 'n' }],
    };
    const inputPath = await writeJson(dir, 'profile.json', profile);
    const res = runValidator(inputPath);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /profile_id/.test(e) && /duplicate|collide/i.test(e)), out.errors.join('; '));
  });
});

test('rejects duplicate entity_id in character_voices', async () => {
  await withTempDir(async (dir) => {
    const profile = {
      ...MINIMAL_PROFILE,
      character_voices: [
        { entity_id: 'alice', notes: 'n' },
        { entity_id: 'alice', notes: 'm' },
      ],
    };
    const inputPath = await writeJson(dir, 'profile.json', profile);
    const res = runValidator(inputPath);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /duplicate entity_id/.test(e)), out.errors.join('; '));
  });
});

test('rejects a character_voices entry missing notes', async () => {
  await withTempDir(async (dir) => {
    const profile = {
      ...MINIMAL_PROFILE,
      character_voices: [{ entity_id: 'alice' }],
    };
    const inputPath = await writeJson(dir, 'profile.json', profile);
    const res = runValidator(inputPath);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /notes/.test(e)), out.errors.join('; '));
  });
});

test('returns a structured error for malformed JSON', async () => {
  await withTempDir(async (dir) => {
    const inputPath = await writeJson(dir, 'profile.json', '{ "schema_version": "profile.v1", not valid');
    const before = await readFile(inputPath);
    const res = runValidator(inputPath);
    const after = await readFile(inputPath);
    assert.deepEqual(after, before);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.length > 0);
    assert.ok(!/^\s+at\s/m.test(res.stderr), 'stderr must not contain a stack trace');
    assert.ok(!/TypeError|RangeError|ReferenceError/.test(res.stderr), 'no thrown error class');
  });
});

test('returns a structured error for a non-object recurring_devices entry', async () => {
  await withTempDir(async (dir) => {
    const profile = {
      ...MINIMAL_PROFILE,
      recurring_devices: ['just a string'],
    };
    const inputPath = await writeJson(dir, 'profile.json', profile);
    const res = runValidator(inputPath);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /recurring_devices\[0\] must be an object/.test(e)), out.errors.join('; '));
    assert.ok(!/^\s+at\s/m.test(res.stderr), 'no crash, no stack trace');
  });
});

test('rejects an unsupported language code', async () => {
  await withTempDir(async (dir) => {
    const profile = { ...MINIMAL_PROFILE, language: 'klingon' };
    const inputPath = await writeJson(dir, 'profile.json', profile);
    const res = runValidator(inputPath);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /language/i.test(e) && /klingon/.test(e)), out.errors.join('; '));
  });
});

test('rejects a profile referencing an undeclared entity', async () => {
  await withTempDir(async (dir) => {
    const profile = {
      ...MINIMAL_PROFILE,
      focalization: { mode: 'limited', focal_character: 'ghost' },
      character_voices: [{ entity_id: 'alice', notes: 'n' }],
    };
    const inputPath = await writeJson(dir, 'profile.json', profile);
    const res = runValidator(inputPath);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /undeclared entity/.test(e)), out.errors.join('; '));
  });
});

test('rejects an unsupported schema_version', async () => {
  await withTempDir(async (dir) => {
    const profile = { ...MINIMAL_PROFILE, schema_version: 'profile.v9' };
    const inputPath = await writeJson(dir, 'profile.json', profile);
    const res = runValidator(inputPath);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /schema_version/.test(e)), out.errors.join('; '));
  });
});

test('rejects a non-object root', async () => {
  await withTempDir(async (dir) => {
    const inputPath = await writeJson(dir, 'profile.json', '[1, 2, 3]');
    const res = runValidator(inputPath);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /must be a JSON object/.test(e)), out.errors.join('; '));
  });
});

test('rejects missing --input argument', async () => {
  const res = runRaw([]);
  assert.equal(res.status, 2);
  const out = parseEnvelope(res);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /--input/.test(e)), out.errors.join('; '));
});

test('rejects a directory as --input', async () => {
  await withTempDir(async (dir) => {
    const res = runValidator(dir);
    assert.equal(res.status, 2);
    const out = parseEnvelope(res);
    assert.equal(out.ok, false);
    assert.ok(out.errors.some((e) => /directory/.test(e)), out.errors.join('; '));
  });
});
test('rejects the evaluation configuration identifier and an evaluation document named profile.v1', async () => {
  await withTempDir(async (dir) => {
    const evaluationIdentifier = await writeJson(dir, 'evaluation.json', {
      schema_version: 'assessment-profile.v1',
      profile_id: 'eval-1',
      scope: { kind: 'book', chapters: [1, 2] },
      aggregation: { enabled: false },
    });
    const byIdentifier = runValidator(evaluationIdentifier);
    assert.equal(byIdentifier.status, 2);
    const identifierEnv = parseEnvelope(byIdentifier);
    const identifierError = identifierEnv.errors.find((error) => error.startsWith('SCHEMA_VERSION'));
    assert.ok(identifierError, identifierEnv.errors.join('; '));
    assert.ok(identifierError.includes('evaluation configuration'));

    const aliased = await writeJson(dir, 'aliased.json', {
      ...MINIMAL_PROFILE,
      scope: { kind: 'chapter', chapters: [1] },
      aggregation: { enabled: true },
    });
    const byAlias = runValidator(aliased);
    assert.equal(byAlias.status, 2);
    const aliasEnv = parseEnvelope(byAlias);
    const aliasError = aliasEnv.errors.find((error) => error.startsWith('SCHEMA_VERSION'));
    assert.ok(aliasError, aliasEnv.errors.join('; '));
    assert.ok(aliasError.includes('assessment-profile.v1'));
    assert.ok(!aliasEnv.errors.some((error) => /reader_experience|narrator/.test(error)), 'prose rules are not applied to it');
  });
});

test('rejects identifiers that collide after trimming or Unicode normalization', async () => {
  await withTempDir(async (dir) => {
    const spaced = await writeJson(dir, 'spaced.json', {
      ...MINIMAL_PROFILE,
      character_voices: [
        { entity_id: 'alice', notes: 'answers indirectly' },
        { entity_id: ' alice ', notes: 'notices machinery' },
      ],
    });
    const spacedRun = runValidator(spaced);
    assert.equal(spacedRun.status, 2);
    const spacedEnv = parseEnvelope(spacedRun);
    assert.ok(
      spacedEnv.errors.some((error) => error.startsWith('DUPLICATE_ID') && error.includes('alice')),
      spacedEnv.errors.join('; '),
    );

    const composed = 'Ren\u00e9e';
    const decomposed = 'Rene\u0301e';
    const normalized = await writeJson(dir, 'normalized.json', {
      ...MINIMAL_PROFILE,
      focalization: { mode: 'limited', focal_character: decomposed },
      character_voices: [
        { entity_id: composed, notes: 'answers indirectly' },
        { entity_id: decomposed, notes: 'notices machinery' },
      ],
    });
    const normalizedRun = runValidator(normalized);
    assert.equal(normalizedRun.status, 2);
    const normalizedEnv = parseEnvelope(normalizedRun);
    assert.ok(
      normalizedEnv.errors.some((error) => error.startsWith('DUPLICATE_ID')),
      normalizedEnv.errors.join('; '),
    );
    assert.ok(
      !normalizedEnv.errors.some((error) => /undeclared entity/.test(error)),
      'the focal character resolves to the declared entity',
    );

    const devices = await writeJson(dir, 'devices.json', {
      ...MINIMAL_PROFILE,
      recurring_devices: [
        { device: 'water motif', purpose: 'marks distance' },
        { device: '  water motif  ', purpose: 'marks return' },
      ],
    });
    const devicesRun = runValidator(devices);
    assert.equal(devicesRun.status, 2);
    assert.ok(parseEnvelope(devicesRun).errors.some((error) => error.startsWith('DUPLICATE_ID')));
  });
});

test('warns instead of passing silently when based_on_version has no context', async () => {
  await withTempDir(async (dir) => {
    const inputPath = await writeJson(dir, 'profile.json', {
      ...MINIMAL_PROFILE,
      based_on_version: `sha256:${'d'.repeat(64)}`,
    });
    const res = runValidator(inputPath);
    assert.equal(res.status, 0, res.stderr);
    const out = parseEnvelope(res);
    assert.equal(out.ok, true);
    assert.deepEqual(out.errors, []);
    assert.ok(
      out.warnings.some((warning) => warning.includes('based_on_version') && warning.includes('--context')),
      out.warnings.join('; '),
    );
  });
});
