/**
 * The production NQS policy: a calibration claim must be verified against local
 * study artifacts, and a fixture must never pass as a human study.
 *
 * The unit cases use a study written by the test itself, so each refusal is
 * isolated (one absent file, one wrong hash, one contradicted binding). The
 * end-to-end case uses the checked-in synthetic fixture under
 * `fixtures/calibration/`, which is what the skill ships to demonstrate the
 * valid path — and which stays refused without the documented opt-in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildNqs, parseAggregation } from '../scripts/lib/aggregate.mjs';
import { baseMetric } from '../scripts/lib/metrics.mjs';
import {
  STUDY_BINDING_FIELDS,
  STUDY_SCHEMA_VERSION,
  TEST_ONLY_OPT_IN_FLAG,
  verifyCalibrationSupport,
} from '../scripts/lib/study.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runCli, sha256, tempDir, writeFile, writeJson } from './helpers.mjs';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'calibration');
const SYNTHETIC_PROFILE = join(FIXTURES, 'synthetic-profile.json');

const scope = { kind: 'chapter', chapters: [1], segments: ['seg1'] };
const values = { CS: 75, OI: 50, EMOTIONAL_FIT: 55 };
const weights = { cs: 0.4, oi: 0.35, emotional_fit: 0.25 };
/** The weighted arithmetic of the fixture components: 30 + 17.5 + 13.75. */
const EXPECTED_NQS = 0.4 * values.CS + 0.35 * values.OI + 0.25 * values.EMOTIONAL_FIT;

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

function productionProfile(overrides = {}) {
  return {
    enabled: true,
    policy: 'production',
    profile_version: 'nqs-profile.v1',
    weights,
    emotional_fit: { procedure: 'separate-judgement', intent: 'a quiet elegiac aftermath' },
    scope: 'chapter 1',
    corpus_version: 'corpus.v1',
    rubric_version: 'rubric-anchors.v1',
    calibration: { study: 'study.json' },
    ...overrides,
  };
}

function nqs(overrides = {}, extra = {}) {
  return buildNqs({
    aggregation: parseAggregation(productionProfile(overrides)),
    values,
    scope,
    baseMetricFor: baseMetric,
    language: 'ro',
    ...extra,
  });
}

/**
 * Write a study and its artifacts into `root/studies`, hashing the bytes that
 * were really written, so a test mutates exactly one declaration.
 */
function materializeStudy(root, mutate = null) {
  const dir = join(root, 'studies');
  const artifacts = [
    { id: 'held-out-labels', path: 'labels.json', bytes: Buffer.from('{"synthetic":true,"labels":[]}\n', 'utf8') },
    { id: 'preference-summary', path: 'summary.json', bytes: Buffer.from('{"synthetic":true,"counts":{}}\n', 'utf8') },
  ];
  for (const artifact of artifacts) writeFile(dir, artifact.path, artifact.bytes);
  const study = {
    schema_version: STUDY_SCHEMA_VERSION,
    study_id: 'written-by-the-test',
    test_only: true,
    held_out: true,
    bindings: { rubric_version: 'rubric-anchors.v1', profile_version: 'nqs-profile.v1', language: 'ro', scope: 'chapter 1' },
    evidence: artifacts.map((artifact) => ({ id: artifact.id, path: artifact.path, sha256: sha256(artifact.bytes) })),
  };
  if (mutate) mutate(study);
  writeJson(dir, 'study.json', study);
  return { dir, study };
}

/**
 * One refusal case: build the study, run the claim, and return the metric. The
 * opt-in is on by default so an artifact or binding defect is what the case
 * proves; a case that tests the test-only gate turns it off explicitly.
 */
function claim(root, mutate, overrides = {}, buildOptions = {}) {
  const { dir } = materializeStudy(root, mutate);
  return nqs(overrides, { studyRoot: dir, allowTestOnlyStudies: true, ...buildOptions });
}

/* ------------------------------ the valid path ------------------------------ */

test('a production claim is computed when a local study verifies its bindings, held-out flag and hashed artifacts', () => {
  const root = tempDir('calibration-');
  try {
    const { dir } = materializeStudy(root);
    const metric = nqs({}, { studyRoot: dir, allowTestOnlyStudies: true });
    assert.equal(metric.status, 'computed');
    assert.ok(Math.abs(metric.value - EXPECTED_NQS) < 1e-9, String(metric.value));
    assert.deepEqual(metric.detail.weights, weights, 'the declared weights are the ones applied');
    const verification = metric.detail.calibration_verification;
    assert.equal(verification.status, 'verified');
    assert.equal(verification.study_id, 'written-by-the-test');
    assert.equal(verification.test_only, true);
    assert.deepEqual(verification.bindings, {
      rubric_version: 'rubric-anchors.v1',
      profile_version: 'nqs-profile.v1',
      language: 'ro',
      scope: 'chapter 1',
    });
    assert.deepEqual(
      verification.evidence.map((item) => [item.id, item.path, item.sha256.length]),
      [['held-out-labels', 'labels.json', 64], ['preference-summary', 'summary.json', 64]],
      'every evidence item is named with its recomputed hash',
    );

    // The same study, verified directly: the hashes are recomputed from the bytes on disk.
    const direct = verifyCalibrationSupport({
      calibration: { study: 'study.json', study_id: null },
      profileVersion: 'nqs-profile.v1',
      rubricVersion: 'rubric-anchors.v1',
      language: 'ro',
      scope: 'chapter 1',
      studyRoot: dir,
      allowTestOnlyStudies: true,
    });
    assert.equal(direct.ok, true);
    assert.deepEqual(direct.evidence, verification.evidence);
  } finally {
    cleanup([root]);
  }
});

test('a real (not test-only) study needs no opt-in and is not labelled as a fixture', () => {
  const root = tempDir('calibration-');
  try {
    const metric = claim(root, (study) => { study.test_only = false; });
    assert.equal(metric.status, 'computed');
    assert.equal(metric.qualified, false, 'a verified human study is not an experimental finding');
    assert.ok(metric.detail.note.includes('recorded calibration evidence'), metric.detail.note);
    assert.ok(metric.detail.note.includes('2 verified artifacts'), metric.detail.note);
    assert.equal(metric.detail.calibration_verification.test_only, false);
  } finally {
    cleanup([root]);
  }
});

test('a test-only study is refused without the opt-in and accepted with it, and never loses the label', () => {
  const root = tempDir('calibration-');
  try {
    const refused = claim(root, null, {}, { allowTestOnlyStudies: false });
    assert.equal(refused.status, 'not_assessable');
    assert.equal(refused.value, null, 'an unverified claim is unavailable, never zero');
    assert.ok(refused.missing_reason.includes('test_only'), refused.missing_reason);
    assert.ok(refused.missing_reason.includes(TEST_ONLY_OPT_IN_FLAG), refused.missing_reason);
    assert.equal(refused.detail.calibration_verification.status, 'unverified');
    assert.equal(refused.detail.calibration_verification.study_id, undefined, 'an unverified study contributes no identity');

    const accepted = claim(root, null);
    assert.equal(accepted.status, 'computed');
    assert.equal(accepted.qualified, true, 'a test-only study is a limited finding');
    assert.ok(accepted.detail.note.includes('test-only study'), accepted.detail.note);
    assert.ok(accepted.detail.note.includes('written-by-the-test'), accepted.detail.note);
    assert.ok(accepted.detail.note.includes(TEST_ONLY_OPT_IN_FLAG), 'the opt-in that was used is stated');
  } finally {
    cleanup([root]);
  }
});

/* ------------------------------ refusals ------------------------------ */

test('held_out and an evidence list written into the profile are a self-declaration, not evidence', () => {
  for (const calibration of [
    { held_out: true, evidence: ['ev1'] },
    { study_id: 'c34-pilot', held_out: true, evidence: ['ev1'] },
    { study: 'study.json', held_out: true },
    { study: 'study.json', evidence: ['ev1'] },
    {},
    { study: '' },
  ]) {
    assertCode(() => parseAggregation(productionProfile({ calibration })), 'INVALID_PROFILE');
  }
  // The store behind the claim is only ever the artifact named by `study`.
  const parsed = parseAggregation(productionProfile({ calibration: { study: 'study.json', study_id: 'written-by-the-test' } }));
  assert.deepEqual(parsed.calibration, { study: 'study.json', study_id: 'written-by-the-test' });

  // Without a study root, a named study cannot be located at all.
  const noRoot = nqs({}, { allowTestOnlyStudies: true });
  assert.equal(noRoot.status, 'not_assessable');
  assert.ok(noRoot.missing_reason.includes('no study root'), noRoot.missing_reason);
  assert.equal(noRoot.value, null);
});

test('an absent study, an absent evidence artifact and a hash mismatch all leave the claim unverified', () => {
  const root = tempDir('calibration-');
  try {
    // The profile names a study that is not there.
    materializeStudy(root);
    const absent = nqs({ calibration: { study: 'invented-study.json' } }, { studyRoot: join(root, 'studies'), allowTestOnlyStudies: true });
    assert.equal(absent.status, 'not_assessable');
    assert.ok(absent.missing_reason.includes('invented-study.json'), absent.missing_reason);
    assert.ok(absent.missing_reason.includes('does not resolve to a local file'), absent.missing_reason);

    // The study is there, one artifact of it is not.
    const missingArtifact = claim(root, (study) => { study.evidence[0].path = 'not-shipped.json'; });
    assert.equal(missingArtifact.status, 'not_assessable');
    assert.ok(missingArtifact.missing_reason.includes('held-out-labels'), missingArtifact.missing_reason);
    assert.ok(missingArtifact.missing_reason.includes('does not resolve to a local file'), missingArtifact.missing_reason);

    // The bytes changed after the study declared their hash.
    const mismatch = claim(root, (study) => { study.evidence[1].sha256 = 'a'.repeat(64); });
    assert.equal(mismatch.status, 'not_assessable');
    assert.ok(mismatch.missing_reason.includes('preference-summary'), mismatch.missing_reason);
    assert.ok(mismatch.missing_reason.includes('sha256 mismatch'), mismatch.missing_reason);

    // An artifact path may not escape the study's own directory.
    const escape = claim(root, (study) => { study.evidence[0].path = '../outside.json'; });
    assert.equal(escape.status, 'not_assessable');
    assert.ok(escape.missing_reason.includes('relative path'), escape.missing_reason);

    // A study that cannot be read as a study document is a problem too.
    writeFile(join(root, 'studies'), 'broken.json', '{not json\n');
    const broken = nqs({ calibration: { study: 'broken.json' } }, { studyRoot: join(root, 'studies'), allowTestOnlyStudies: true });
    assert.equal(broken.status, 'not_assessable');
    assert.ok(broken.missing_reason.includes('not valid JSON'), broken.missing_reason);
  } finally {
    cleanup([root]);
  }
});

test('a study bound to another rubric version, profile version, language or scope cannot support the claim', () => {
  const root = tempDir('calibration-');
  try {
    const cases = [
      { field: 'rubric_version', mutate: (study) => { study.bindings.rubric_version = 'rubric-anchors.v2'; } },
      { field: 'profile_version', mutate: (study) => { study.bindings.profile_version = 'nqs-profile.v2'; } },
      { field: 'language', mutate: (study) => { study.bindings.language = 'en'; } },
      { field: 'scope', mutate: (study) => { study.bindings.scope = 'chapters 1-9'; } },
      // The other direction: the profile moved and the study did not.
      { field: 'rubric_version', mutate: null, overrides: { rubric_version: 'rubric-anchors.v0' } },
      { field: 'scope', mutate: null, overrides: { scope: 'chapter 2' } },
      { field: 'language', mutate: null, extra: { language: 'en' } },
    ];
    for (const item of cases) {
      const metric = claim(root, item.mutate, item.overrides ?? {}, item.extra ?? {});
      const label = `${item.field} ${JSON.stringify({ ...(item.overrides ?? {}), ...(item.extra ?? {}) })}`;
      assert.equal(metric.status, 'not_assessable', label);
      assert.equal(metric.value, null, label);
      assert.ok(metric.missing_reason.includes(item.field), `${label}: ${metric.missing_reason}`);
      assert.equal(metric.detail.calibration_verification.status, 'unverified', label);
    }
  } finally {
    cleanup([root]);
  }
});

test('a binding missing on either side leaves the claim unverified instead of guessed', () => {
  const root = tempDir('calibration-');
  try {
    for (const field of STUDY_BINDING_FIELDS) {
      const metric = claim(root, (study) => { delete study.bindings[field]; });
      assert.equal(metric.status, 'not_assessable', field);
      assert.ok(metric.missing_reason.includes(`bindings.${field}`), metric.missing_reason);
    }
    // Bindings the profile never declared cannot be verified either.
    const noRubric = claim(root, null, { rubric_version: undefined });
    assert.equal(noRubric.status, 'not_assessable');
    assert.ok(noRubric.missing_reason.includes('no rubric_version'), noRubric.missing_reason);
    const noScope = claim(root, null, { scope: undefined });
    assert.equal(noScope.status, 'not_assessable');
    assert.ok(noScope.missing_reason.includes('no scope'), noScope.missing_reason);

    // A study that says nothing about being a fixture, or about held-out evaluation, is refused.
    for (const [mutate, needle] of [
      [(study) => { delete study.test_only; }, 'test_only'],
      [(study) => { delete study.held_out; }, 'no held-out evaluation'],
      [(study) => { study.held_out = false; }, 'no held-out evaluation'],
      [(study) => { study.evidence = []; }, 'records no evidence'],
      [(study) => { study.evidence[0].sha256 = 'not-a-hash'; }, 'no valid sha256'],
      [(study) => { study.schema_version = 'calibration-study.v2'; }, 'schema_version'],
    ]) {
      const metric = claim(root, mutate);
      assert.equal(metric.status, 'not_assessable', needle);
      assert.ok(metric.missing_reason.includes(needle), metric.missing_reason);
    }
  } finally {
    cleanup([root]);
  }
});

test('the profile cannot name a study other than the one that declares itself', () => {
  const root = tempDir('calibration-');
  try {
    const metric = claim(root, null, { calibration: { study: 'study.json', study_id: 'another-study' } }, { allowTestOnlyStudies: true });
    assert.equal(metric.status, 'not_assessable');
    assert.ok(metric.missing_reason.includes('another-study'), metric.missing_reason);
    assert.ok(metric.missing_reason.includes('written-by-the-test'), metric.missing_reason);
  } finally {
    cleanup([root]);
  }
});

/* ------------------------------ end to end on the fixture ------------------------------ */

test('the shipped synthetic fixture verifies end to end and stays labelled test-only in the report', () => {
  const root = tempDir('calibration-cli-');
  try {
    const profile = readJson(SYNTHETIC_PROFILE);
    const fx = buildReportFixture(root, { profile });
    const withOptIn = join(root, 'with-opt-in');
    const env = runCli([
      '--input', fx.packetDir,
      '--out', withOptIn,
      '--profile', fx.profilePath,
      '--annotations', fx.annotationsPath,
      '--study-root', FIXTURES,
      '--allow-test-only-studies',
    ]);
    assert.equal(env.status, 0, env.stderr);
    const bundle = readJson(join(withOptIn, 'assessment.json'));
    assert.equal(bundle.metrics.NQS.status, 'computed');
    assert.ok(Math.abs(bundle.metrics.NQS.value - EXPECTED_NQS) < 1e-9, String(bundle.metrics.NQS.value));
    assert.equal(bundle.metrics.NQS.detail.calibration_verification.study_id, 'synthetic-test-only-nqs-pilot');
    assert.equal(bundle.metrics.NQS.qualified, true);
    assert.ok(bundle.metrics.NQS.detail.note.includes('test-only study'), bundle.metrics.NQS.detail.note);
    const justification = readFileSync(join(withOptIn, '04-score-justification.md'), 'utf8');
    assert.ok(justification.includes('synthetic-test-only-nqs-pilot'), 'the report names the study it rests on');
    assert.ok(justification.includes('test-only study'), 'the report states what the support is');
    assert.ok(
      justification.includes('SYNTHETIC TEST FIXTURE'),
      'the fixture\'s own synthetic provenance reaches the report, so the label cannot be laundered',
    );

    // The same fixture, same profile, no opt-in: refused, and the rest of the report is unaffected.
    const withoutOptIn = join(root, 'without-opt-in');
    const plain = runCli([
      '--input', fx.packetDir,
      '--out', withoutOptIn,
      '--profile', fx.profilePath,
      '--annotations', fx.annotationsPath,
      '--study-root', FIXTURES,
    ]);
    assert.equal(plain.status, 0, plain.stderr);
    const refused = readJson(join(withoutOptIn, 'assessment.json'));
    assert.equal(refused.metrics.NQS.status, 'not_assessable');
    assert.equal(refused.metrics.NQS.value, null);
    assert.ok(refused.metrics.NQS.missing_reason.includes('test_only'), refused.metrics.NQS.missing_reason);
    assert.equal(refused.metrics.CS.status, 'judged');
    assert.equal(refused.metrics.CCI.status, 'computed');
    assert.equal(refused.metrics.CAR.status, 'computed');

    // A book in another language than the study measured cannot use it either.
    const other = buildReportFixture(join(root, 'en'), { profile, language: 'en' });
    const wrongLanguage = join(root, 'wrong-language');
    const mismatched = runCli([
      '--input', other.packetDir,
      '--out', wrongLanguage,
      '--profile', other.profilePath,
      '--annotations', other.annotationsPath,
      '--study-root', FIXTURES,
      '--allow-test-only-studies',
    ]);
    assert.equal(mismatched.status, 0, mismatched.stderr);
    const inEnglish = readJson(join(wrongLanguage, 'assessment.json'));
    assert.equal(inEnglish.metrics.NQS.status, 'not_assessable');
    assert.ok(inEnglish.metrics.NQS.missing_reason.includes('language'), inEnglish.metrics.NQS.missing_reason);
    assert.equal(inEnglish.metrics.CS.status, 'judged');
  } finally {
    cleanup([root]);
  }
});
