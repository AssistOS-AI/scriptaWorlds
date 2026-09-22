/**
 * The `--context` contract of the prose-craft validator: `assessment-input.v2` loading, the
 * recomputed accepted-version identity, the recorded scope, the located support of the
 * expressive components, real-path output separation and portability outside the
 * repository. Structural profile rules are covered by `profile.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MINIMAL_PROFILE,
  OBSERVED_COMPONENT,
  inventory,
  parseEnvelope,
  runValidator,
  withTempDir,
  writeJson,
  writePacket,
} from './helpers/fixtures.mjs';

test('cross-checks based_on_version against the accepted version of a matching packet', async () => {
  await withTempDir(async (dir) => {
    const packet = await writePacket(join(dir, 'packet'));
    const inputPath = await writeJson(dir, 'profile.json', { ...MINIMAL_PROFILE, based_on_version: packet.version });
    const manifestPath = join(packet.dir, 'manifest.json');
    const inputBefore = await readFile(inputPath);
    const contextBefore = await readFile(manifestPath);
    const res = runValidator(inputPath, packet.dir);
    assert.deepEqual(await readFile(inputPath), inputBefore);
    assert.deepEqual(await readFile(manifestPath), contextBefore);
    assert.equal(res.status, 0, res.stderr);
    const out = parseEnvelope(res);
    assert.equal(out.ok, true);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.warnings, []);
  });
});

test('rejects a profile written for version A as stale against version B of the same book, and accepts it for B', async () => {
  await withTempDir(async (dir) => {
    const versionA = await writePacket(join(dir, 'version-a'));
    const versionB = await writePacket(join(dir, 'version-b'), {
      chapters: ['# One\n\nFirst accepted chapter, revised.\n', '# Two\n\nSecond accepted chapter.\n'],
    });
    assert.notEqual(versionA.version, versionB.version);
    assert.equal(versionA.manifest.universe_id, versionB.manifest.universe_id);

    const forA = await writeJson(dir, 'profile-a.json', { ...MINIMAL_PROFILE, based_on_version: versionA.version });
    const againstA = runValidator(forA, versionA.dir);
    assert.equal(againstA.status, 0, againstA.stderr);
    assert.equal(parseEnvelope(againstA).ok, true);

    const againstB = runValidator(forA, versionB.dir);
    assert.equal(againstB.status, 2);
    const stale = parseEnvelope(againstB);
    assert.equal(stale.ok, false);
    const staleError = stale.errors.find((error) => error.startsWith('STALE_BASED_ON_VERSION'));
    assert.ok(staleError, stale.errors.join('; '));
    assert.ok(staleError.includes(versionA.version));
    assert.ok(staleError.includes(versionB.version));
    assert.equal(stale.context.version, versionB.version, 'the result states which version was checked');

    const forB = await writeJson(dir, 'profile-b.json', { ...MINIMAL_PROFILE, based_on_version: versionB.version });
    const acceptedForB = runValidator(forB, versionB.dir);
    assert.equal(acceptedForB.status, 0, acceptedForB.stderr);
    assert.equal(parseEnvelope(acceptedForB).ok, true);
  });
});

test('records the packet version and the scope the result covered', async () => {
  await withTempDir(async (dir) => {
    const complete = await writePacket(join(dir, 'complete'));
    const completeProfile = await writeJson(dir, 'complete.json', {
      ...MINIMAL_PROFILE,
      based_on_version: complete.version,
    });
    const completeRun = runValidator(completeProfile, complete.dir);
    assert.equal(completeRun.status, 0, completeRun.stderr);
    const completeEnv = parseEnvelope(completeRun);
    assert.deepEqual(completeEnv.context, {
      universe_id: 'uni-1',
      version: complete.version,
      scope: { kind: 'complete', chapters: [1, 2], omitted: [], note: 'test fixture' },
    });

    const partial = await writePacket(join(dir, 'partial'), {
      chapters: ['# Two\n\nSecond accepted chapter.\n'],
      chapterNumbers: [2],
      lastAcceptedChapter: 2,
      kind: 'partial',
      omitted: [1],
    });
    const partialProfile = await writeJson(dir, 'partial.json', {
      ...MINIMAL_PROFILE,
      based_on_version: partial.version,
    });
    const partialRun = runValidator(partialProfile, partial.dir);
    assert.equal(partialRun.status, 0, partialRun.stderr);
    const partialEnv = parseEnvelope(partialRun);
    assert.equal(partialEnv.context.scope.kind, 'partial');
    assert.deepEqual(partialEnv.context.scope.chapters, [2]);
    assert.deepEqual(partialEnv.context.scope.omitted, [1]);
    assert.notEqual(partialEnv.context.version, completeEnv.context.version);

    const noContext = runValidator(completeProfile);
    assert.equal(noContext.status, 0, noContext.stderr);
    assert.equal(parseEnvelope(noContext).context, null, 'no packet is reported as no context, not as a match');
  });
});

test('rejects a superseded or unknown manifest and an identity that names no version', async () => {
  await withTempDir(async (dir) => {
    const packet = await writePacket(join(dir, 'packet'));
    const forA = await writeJson(dir, 'profile.json', { ...MINIMAL_PROFILE, based_on_version: packet.version });

    const legacyDir = join(dir, 'legacy');
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, 'manifest.json'),
      JSON.stringify({ schema_version: 'assessment-input.v1', book: { universe_id: 'uni-1' }, files: [] }),
    );
    const legacyBefore = await inventory(legacyDir);
    const superseded = runValidator(forA, legacyDir);
    assert.equal(superseded.status, 2);
    const supersededEnv = parseEnvelope(superseded);
    const refusal = supersededEnv.errors.find((error) => error.startsWith('SCHEMA_VERSION'));
    assert.ok(refusal, supersededEnv.errors.join('; '));
    assert.ok(refusal.includes('assessment-input.v2'));
    assert.equal(supersededEnv.context, null, 'a refused manifest leaves no context behind');
    assert.deepEqual(await inventory(legacyDir), legacyBefore, 'a refused packet is never written to');

    const absent = runValidator(forA, join(dir, 'not-there'));
    assert.equal(absent.status, 2);
    assert.ok(parseEnvelope(absent).errors.some((error) => error.startsWith('MISSING_CONTEXT')));

    const universeId = await writeJson(dir, 'universe-id.json', {
      ...MINIMAL_PROFILE,
      based_on_version: 'uni-1',
    });
    const asVersion = runValidator(universeId, packet.dir);
    assert.equal(asVersion.status, 2);
    const asVersionEnv = parseEnvelope(asVersion);
    const identityError = asVersionEnv.errors.find((error) => error.startsWith('INVALID_BASED_ON_VERSION'));
    assert.ok(identityError, asVersionEnv.errors.join('; '));
    assert.ok(/universe id/.test(identityError));

    const withoutContext = runValidator(universeId);
    assert.equal(withoutContext.status, 2, 'a universe id is refused with or without a packet');
    assert.ok(
      parseEnvelope(withoutContext).errors.some((error) => error.startsWith('INVALID_BASED_ON_VERSION')),
    );
  });
});

test('rejects tampered packet bytes, a detached manifest and a symlink escape', async () => {
  await withTempDir(async (dir) => {
    const tampered = await writePacket(join(dir, 'tampered'));
    await writeFile(join(tampered.dir, 'chapters', '0001-chapter.md'), '# One\n\nOther accepted chapter.\n');
    const profilePath = await writeJson(dir, 'profile.json', {
      ...MINIMAL_PROFILE,
      based_on_version: tampered.version,
    });
    const tamperedRun = runValidator(profilePath, tampered.dir);
    assert.equal(tamperedRun.status, 2);
    const tamperedEnv = parseEnvelope(tamperedRun);
    assert.ok(
      tamperedEnv.errors.some((error) => error.startsWith('HASH_MISMATCH') && error.includes('0001-chapter.md')),
      tamperedEnv.errors.join('; '),
    );

    const empty = join(dir, 'no-manifest');
    await mkdir(empty, { recursive: true });
    const noManifest = runValidator(profilePath, empty);
    assert.equal(noManifest.status, 2);
    assert.ok(parseEnvelope(noManifest).errors.some((error) => error.startsWith('MISSING_MANIFEST')));

    const source = await writePacket(join(dir, 'detached-source'));
    const detached = join(dir, 'detached');
    await mkdir(detached, { recursive: true });
    const detachedManifest = join(detached, 'manifest.json');
    await writeFile(detachedManifest, JSON.stringify(source.manifest, null, 2));
    const mismatched = runValidator(profilePath, detachedManifest);
    assert.equal(mismatched.status, 2);
    const mismatchedEnv = parseEnvelope(mismatched);
    assert.equal(mismatchedEnv.errors.length, source.manifest.files.length);
    assert.ok(mismatchedEnv.errors.every((error) => error.startsWith('MISSING_FILE')));

    const outside = join(dir, 'outside-timing.md');
    await writeFile(outside, '# Canon\n');
    const linked = await writePacket(join(dir, 'symlinked'), {
      extraFiles: [{ path: 'linked-canon.md', text: '# Canon\n', role: 'timing', artifact_id: 'timing-run' }],
    });
    const linkPath = join(linked.dir, 'linked-canon.md');
    await rm(linkPath);
    await symlink(outside, linkPath);
    const linkedProfile = await writeJson(dir, 'profile-symlink.json', {
      ...MINIMAL_PROFILE,
      based_on_version: linked.version,
    });
    const escaped = runValidator(linkedProfile, linked.dir);
    assert.equal(escaped.status, 2);
    const escapedEnv = parseEnvelope(escaped);
    const escapeError = escapedEnv.errors.find((error) => error.startsWith('PATH_ESCAPE'));
    assert.ok(escapeError, escapedEnv.errors.join('; '));
    assert.ok(escapeError.includes('symlink') && escapeError.includes('linked-canon.md'));
  });
});

test('requires an anchor, a status, an evaluator, a rationale and quoted evidence for an observed component', async () => {
  await withTempDir(async (dir) => {
    const accepted = await writeJson(dir, 'accepted.json', {
      ...MINIMAL_PROFILE,
      expressive_components: [
        OBSERVED_COMPONENT,
        {
          component_id: 'ec-0002',
          component: 'description',
          anchor: 'chapters/0002-chapter.md, the whole scene',
          status: 'not_applicable',
          evaluator: 'human:reviewer-a',
          rationale: 'The scene has no descriptive passage to judge.',
        },
      ],
    });
    const acceptedRun = runValidator(accepted);
    assert.equal(acceptedRun.status, 0, acceptedRun.stderr);
    const acceptedEnv = parseEnvelope(acceptedRun);
    assert.deepEqual(acceptedEnv.errors, []);
    assert.ok(
      acceptedEnv.warnings.some((warning) => /unverified/.test(warning)),
      acceptedEnv.warnings.join('; '),
    );

    const cases = [
      {
        name: 'a component without evidence',
        profile: { expressive_components: [{ ...OBSERVED_COMPONENT, evidence: undefined }] },
        expect: /evidence is required/,
      },
      {
        name: 'an unknown component category',
        profile: { expressive_components: [{ ...OBSERVED_COMPONENT, component: 'banana' }] },
        expect: /banana/,
      },
      {
        name: 'a component without an anchor',
        profile: { expressive_components: [{ ...OBSERVED_COMPONENT, anchor: undefined }] },
        expect: /anchor/,
      },
      {
        name: 'a component without an evaluator',
        profile: { expressive_components: [{ ...OBSERVED_COMPONENT, evaluator: '' }] },
        expect: /evaluator/,
      },
      {
        name: 'an uncertain reading that states no limitation',
        profile: {
          expressive_components: [{ ...OBSERVED_COMPONENT, status: 'uncertain', uncertainty: undefined }],
        },
        expect: /uncertainty/,
      },
      {
        name: 'an evidence entry without a quote',
        profile: { expressive_components: [{ ...OBSERVED_COMPONENT, evidence: [{ source: 'canon.md' }] }] },
        expect: /quote/,
      },
      {
        name: 'a duplicate component_id',
        profile: { expressive_components: [OBSERVED_COMPONENT, { ...OBSERVED_COMPONENT }] },
        expect: /DUPLICATE_ID/,
      },
      {
        name: 'a non-object component entry',
        profile: { expressive_components: ['a dialogue note'] },
        expect: /expressive_components\[0\] must be an object/,
      },
    ];

    for (const item of cases) {
      const inputPath = await writeJson(dir, `case-${item.name.replace(/\W+/g, '-')}.json`, {
        ...MINIMAL_PROFILE,
        ...item.profile,
      });
      const res = runValidator(inputPath);
      assert.equal(res.status, 2, `${item.name}: ${res.stderr}`);
      const out = parseEnvelope(res);
      assert.equal(out.ok, false);
      assert.ok(
        out.errors.some((error) => item.expect.test(error)),
        `${item.name}: ${out.errors.join('; ')}`,
      );
    }
  });
});

test('locates the declared support of a component in the packet and refuses a fabricated quote', async () => {
  await withTempDir(async (dir) => {
    const packet = await writePacket(join(dir, 'packet'));
    const base = { ...MINIMAL_PROFILE, based_on_version: packet.version };

    const supported = await writeJson(dir, 'supported.json', {
      ...base,
      expressive_components: [
        OBSERVED_COMPONENT,
        {
          component_id: 'ec-0002',
          component: 'rhythm',
          anchor: 'chapters/0002-chapter.md',
          status: 'unresolved',
          evaluator: 'human:reviewer-b',
          rationale: 'The boundary between the pause and the acceleration is not settled.',
          uncertainty: 'The scene break could be read as an acceleration.',
          alternatives: ['The paragraph break is typographic, not rhythmic.'],
          evidence: [{ source: 'chapters/0002-chapter.md', quote: 'Second accepted chapter.' }],
        },
      ],
    });
    const supportedRun = runValidator(supported, packet.dir);
    assert.equal(supportedRun.status, 0, supportedRun.stderr);
    const supportedEnv = parseEnvelope(supportedRun);
    assert.deepEqual(supportedEnv.errors, []);
    assert.deepEqual(supportedEnv.warnings, []);
    assert.equal(supportedEnv.context.version, packet.version);

    const fabricated = await writeJson(dir, 'fabricated.json', {
      ...base,
      expressive_components: [
        {
          ...OBSERVED_COMPONENT,
          evidence: [{ source: 'chapters/0001-chapter.md', quote: 'The council dissolved at dawn.' }],
        },
      ],
    });
    const fabricatedRun = runValidator(fabricated, packet.dir);
    assert.equal(fabricatedRun.status, 2);
    const fabricatedEnv = parseEnvelope(fabricatedRun);
    const notFound = fabricatedEnv.errors.find((error) => error.startsWith('EVIDENCE_NOT_FOUND'));
    assert.ok(notFound, fabricatedEnv.errors.join('; '));
    assert.ok(notFound.includes('chapters/0001-chapter.md'));

    const undeclared = await writeJson(dir, 'undeclared.json', {
      ...base,
      expressive_components: [
        {
          ...OBSERVED_COMPONENT,
          evidence: [{ source: 'chapters/0009-chapter.md', quote: 'First accepted chapter.' }],
        },
      ],
    });
    const undeclaredRun = runValidator(undeclared, packet.dir);
    assert.equal(undeclaredRun.status, 2);
    const undeclaredEnv = parseEnvelope(undeclaredRun);
    const unverified = undeclaredEnv.errors.find((error) => error.startsWith('UNVERIFIED_EVIDENCE'));
    assert.ok(unverified, undeclaredEnv.errors.join('; '));
    assert.ok(unverified.includes('0009-chapter.md'));
  });
});

test('records calibration readiness and refuses a production use of an uncalibrated profile', async () => {
  await withTempDir(async (dir) => {
    const production = await writeJson(dir, 'production.json', {
      ...MINIMAL_PROFILE,
      intended_use: 'production',
    });
    const productionRun = runValidator(production);
    assert.equal(productionRun.status, 2);
    const productionEnv = parseEnvelope(productionRun);
    const gate = productionEnv.errors.find((error) => error.startsWith('UNCALIBRATED_PROFILE'));
    assert.ok(gate, productionEnv.errors.join('; '));
    assert.ok(/C34/.test(gate));

    const claimedCalibration = await writeJson(dir, 'claimed.json', {
      ...MINIMAL_PROFILE,
      intended_use: 'production',
      calibration: { status: 'calibrated' },
    });
    const claimedRun = runValidator(claimedCalibration);
    assert.equal(claimedRun.status, 2);
    const claimedEnv = parseEnvelope(claimedRun);
    assert.ok(
      claimedEnv.errors.some((error) => error.startsWith('CALIBRATION_INCOMPLETE') && /protocol_version/.test(error)),
      claimedEnv.errors.join('; '),
    );
    assert.ok(
      claimedEnv.errors.some((error) => error.startsWith('CALIBRATION_INCOMPLETE') && /evidence/.test(error)),
      claimedEnv.errors.join('; '),
    );
    assert.ok(
      claimedEnv.errors.some((error) => error.startsWith('UNCALIBRATED_PROFILE')),
      'a declared calibration without evidence cannot license production use',
    );

    const experimental = await writeJson(dir, 'experimental.json', {
      ...MINIMAL_PROFILE,
      intended_use: 'review',
      calibration: { status: 'experimental', protocol_version: 'calibration-draft' },
    });
    const experimentalRun = runValidator(experimental);
    assert.equal(experimentalRun.status, 0, experimentalRun.stderr);
    assert.deepEqual(parseEnvelope(experimentalRun).errors, []);

    const calibrated = await writeJson(dir, 'calibrated.json', {
      ...MINIMAL_PROFILE,
      intended_use: 'production',
      calibration: {
        status: 'calibrated',
        protocol_version: 'calibration-v1',
        evidence: [{ source: 'calibration/held-out-v1.json', note: 'two independent readers, held-out sample' }],
      },
    });
    const calibratedRun = runValidator(calibrated);
    assert.equal(calibratedRun.status, 0, calibratedRun.stderr);
    assert.deepEqual(parseEnvelope(calibratedRun).errors, []);

    const unknownUse = await writeJson(dir, 'unknown-use.json', {
      ...MINIMAL_PROFILE,
      intended_use: 'published',
    });
    const unknownUseRun = runValidator(unknownUse);
    assert.equal(unknownUseRun.status, 2);
    assert.ok(
      parseEnvelope(unknownUseRun).errors.some((error) => /intended_use/.test(error)),
      parseEnvelope(unknownUseRun).errors.join('; '),
    );
  });
});
