/**
 * Calibration support verification (calibration-study.v1).
 *
 * A `production` NQS policy claims calibration support, so that claim must rest
 * on artifacts that exist locally. The profile's calibration record names one
 * study document; the study declares what it measured — the rubric version, the
 * profile version, the language and the scope — whether its evaluation was held
 * out, whether it is a test-only fixture, and the evidence items it rests on.
 * Each evidence item must resolve, inside the study document's own directory,
 * to a file whose bytes hash to the declared sha256.
 *
 * Nothing here reaches the network and nothing is inferred: an absent study, an
 * absent evidence file, a hash mismatch, a missing binding or a binding that
 * contradicts the profile being computed all leave the claim unverified. A
 * test-only study is refused unless the caller passes the documented opt-in,
 * and even then the caller can see that the support is a test-only study.
 *
 * A study that cannot be verified is not an invalid profile: the caller gets a
 * problem string and reports NQS as unavailable with that reason, so the rest
 * of the assessment is still computed.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { isPlainObject, isSha256Hex, sha256Hex, validateRelativePath } from './errors.mjs';

/** The one study document format this verifier accepts. Published at schema/study.v1.json. */
export const STUDY_SCHEMA_VERSION = 'calibration-study.v1';
/** Fields the verifier demands of every study document. */
export const STUDY_REQUIRED_FIELDS = ['schema_version', 'study_id', 'test_only', 'held_out', 'bindings', 'evidence'];
/** Fields a study may carry besides the required ones. */
export const STUDY_OPTIONAL_FIELDS = ['provenance'];
/** Bindings that must match the profile and the accepted book being measured. */
export const STUDY_BINDING_FIELDS = ['rubric_version', 'profile_version', 'language', 'scope'];
/** Fields the verifier demands of every evidence item. */
export const STUDY_EVIDENCE_REQUIRED_FIELDS = ['id', 'path', 'sha256'];
/** The documented caller opt-in that lets a test-only study back a production claim. */
export const TEST_ONLY_OPT_IN_FLAG = '--allow-test-only-studies';

const problem = (text) => ({ ok: false, problem: text });

/**
 * Resolve `relPath` to a real file inside `baseDir`, refusing traversal and
 * symlink escape. Returns `{ ok: true, path }` or `{ ok: false, problem }`, so
 * a missing artifact stays a reportable problem instead of an exception.
 */
function locateArtifact(baseDir, relPath, what) {
  try {
    validateRelativePath(relPath);
  } catch (error) {
    return problem(`${what} is not a portable relative path (${error.message})`);
  }
  let baseReal;
  try {
    baseReal = realpathSync(baseDir);
  } catch {
    return problem(`${what} has no readable study directory to resolve against (${baseDir})`);
  }
  let real;
  try {
    real = realpathSync(resolve(baseDir, relPath));
  } catch (error) {
    return problem(`${what} does not resolve to a local file (${error.code ?? error.message})`);
  }
  const rel = relative(baseReal, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return problem(`${what} resolves outside the study directory (traversal or symlink escape)`);
  }
  return { ok: true, path: real };
}

function readArtifact(path, what) {
  try {
    return { ok: true, bytes: readFileSync(path) };
  } catch (error) {
    return problem(`${what} is not readable (${error.code ?? error.message})`);
  }
}

/** Parse and shape-check one study document. A malformed document is a problem, never a throw. */
function parseStudy(bytes, label) {
  let raw;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    return problem(`${label} is not valid JSON: ${error.message}`);
  }
  if (!isPlainObject(raw)) return problem(`${label} must be a JSON object`);
  if (raw.schema_version !== STUDY_SCHEMA_VERSION) {
    return problem(
      `${label} declares schema_version ${JSON.stringify(raw.schema_version)}; expected ${JSON.stringify(STUDY_SCHEMA_VERSION)}`,
    );
  }
  if (typeof raw.study_id !== 'string' || raw.study_id.length === 0) {
    return problem(`${label} declares no non-empty study_id`);
  }
  if (typeof raw.test_only !== 'boolean') {
    return problem(`${label} declares no boolean test_only flag; a study that does not say whether it is a fixture cannot back a production claim`);
  }
  if (raw.held_out !== true) {
    return problem(`study ${raw.study_id} records no held-out evaluation`);
  }
  if (!isPlainObject(raw.bindings)) return problem(`${label} declares no bindings object`);
  const bindings = {};
  for (const field of STUDY_BINDING_FIELDS) {
    const value = raw.bindings[field];
    if (typeof value !== 'string' || value.length === 0) {
      return problem(`study ${raw.study_id} declares no bindings.${field}`);
    }
    bindings[field] = value;
  }
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) {
    return problem(`study ${raw.study_id} records no evidence`);
  }
  const evidence = [];
  const seen = new Set();
  for (const [index, item] of raw.evidence.entries()) {
    if (!isPlainObject(item)) return problem(`study ${raw.study_id} evidence item ${index} is not an object`);
    for (const field of STUDY_EVIDENCE_REQUIRED_FIELDS) {
      if (typeof item[field] !== 'string' || item[field].length === 0) {
        return problem(`study ${raw.study_id} evidence item ${index} declares no ${field}`);
      }
    }
    if (!isSha256Hex(item.sha256)) {
      return problem(`study ${raw.study_id} evidence ${JSON.stringify(item.id)} declares no valid sha256`);
    }
    if (seen.has(item.id)) return problem(`study ${raw.study_id} repeats the evidence id ${JSON.stringify(item.id)}`);
    seen.add(item.id);
    evidence.push({ id: item.id, path: item.path, sha256: item.sha256 });
  }
  return {
    ok: true,
    study: {
      study_id: raw.study_id,
      test_only: raw.test_only,
      held_out: true,
      provenance: typeof raw.provenance === 'string' ? raw.provenance : null,
      bindings,
      evidence,
    },
  };
}

/**
 * Verify that a calibration record is backed by a local study artifact.
 *
 * `profileVersion`, `rubricVersion` and `scope` are the aggregation profile's
 * own declarations; `language` is the accepted book's language. Every one of
 * them must be declared and must equal the study's binding, because a study
 * that measured another rubric version, language or scope cannot support this
 * claim. Returns `{ ok: true, study_id, test_only, provenance, bindings,
 * evidence }` or `{ ok: false, problem }`.
 */
export function verifyCalibrationSupport({
  calibration,
  profileVersion,
  rubricVersion,
  language,
  scope,
  studyRoot,
  allowTestOnlyStudies = false,
}) {
  if (!isPlainObject(calibration) || typeof calibration.study !== 'string' || calibration.study.length === 0) {
    return problem('no calibration study is recorded');
  }
  if (typeof studyRoot !== 'string' || studyRoot.length === 0) {
    return problem(
      `the calibration record names study ${JSON.stringify(calibration.study)}, but this run declares no study root, ` +
        'so no local artifact can back the claim',
    );
  }

  const located = locateArtifact(studyRoot, calibration.study, `study ${JSON.stringify(calibration.study)}`);
  if (!located.ok) return located;
  const label = `study ${JSON.stringify(calibration.study)}`;
  const read = readArtifact(located.path, label);
  if (!read.ok) return read;
  const parsed = parseStudy(read.bytes, label);
  if (!parsed.ok) return parsed;
  const study = parsed.study;

  if (calibration.study_id !== null && calibration.study_id !== undefined && calibration.study_id !== study.study_id) {
    return problem(
      `the calibration record names study_id ${JSON.stringify(calibration.study_id)} but ${JSON.stringify(calibration.study)} ` +
        `declares ${JSON.stringify(study.study_id)}`,
    );
  }
  if (study.test_only && !allowTestOnlyStudies) {
    return problem(
      `study ${study.study_id} is marked test_only (a synthetic or test fixture) and cannot support a production claim ` +
        `without the explicit ${TEST_ONLY_OPT_IN_FLAG} opt-in`,
    );
  }

  const expected = {
    profile_version: profileVersion,
    rubric_version: rubricVersion,
    language,
    scope,
  };
  const missing = {
    profile_version: 'this profile declares no profile_version',
    rubric_version: 'the aggregation profile declares no rubric_version',
    language: 'this run records no book language',
    scope: 'the aggregation profile declares no scope',
  };
  for (const field of STUDY_BINDING_FIELDS) {
    const declared = expected[field];
    if (typeof declared !== 'string' || declared.length === 0) {
      return problem(`study ${study.study_id} binds ${field}, but ${missing[field]}, so the binding cannot be verified`);
    }
    if (study.bindings[field] !== declared) {
      return problem(
        `study ${study.study_id} measured ${field} ${JSON.stringify(study.bindings[field])}, but this assessment ` +
          `computes ${field} ${JSON.stringify(declared)}; a study bound to another ${field} cannot support this claim`,
      );
    }
  }

  const studyDir = dirname(located.path);
  const verified = [];
  for (const item of study.evidence) {
    const found = locateArtifact(studyDir, item.path, `study ${study.study_id} evidence ${JSON.stringify(item.id)}`);
    if (!found.ok) return found;
    const bytes = readArtifact(found.path, `study ${study.study_id} evidence ${JSON.stringify(item.id)}`);
    if (!bytes.ok) return bytes;
    const actual = sha256Hex(bytes.bytes);
    if (actual !== item.sha256) {
      return problem(
        `study ${study.study_id} evidence ${JSON.stringify(item.id)} sha256 mismatch: declared ${item.sha256}, ` +
          `computed ${actual}`,
      );
    }
    verified.push({ id: item.id, path: item.path, sha256: item.sha256 });
  }

  return {
    ok: true,
    study_id: study.study_id,
    test_only: study.test_only,
    provenance: study.provenance,
    bindings: study.bindings,
    evidence: verified,
  };
}
