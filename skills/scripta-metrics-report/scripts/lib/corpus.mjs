/**
 * Corpus manifest loading (corpus.v1).
 *
 * The corpus is optional and MUST NOT be downloaded: references are read only
 * from an explicit `--corpus` manifest. Every record keeps its provenance, its
 * permitted use, its language, its hash and any exclusion it declares, so the
 * report can state what was compared and what was left out. Paths resolve
 * relative to the manifest file and are validated against traversal and symlink
 * escape; every hash is recomputed.
 *
 * A reference may declare the corpus source it was copied from
 * (`source: { id, version }`). The declaration is what a self-comparison is
 * decided on later (see overlap.mjs `classifyReferences`); identical bytes
 * alone are duplicate text in an independent reference, which is the case
 * overlap measurement exists to find.
 */

import { dirname } from 'node:path';

import {
  fail,
  isPlainObject,
  isSha256Hex,
  readBytesChecked,
  readJsonChecked,
  resolveInside,
  sha256Hex,
  validateRelativePath,
} from './errors.mjs';

export const CORPUS_SCHEMA_VERSION = 'corpus.v1';
export const DEFAULT_PERMITTED_USE = 'comparison';

/**
 * A reference's declared origin. `{ id, version }` names the corpus source the
 * reference was copied from; both fields are required together, because half of
 * an identity cannot be checked and must not be guessed from a hash.
 */
function readSourceIdentity(ref) {
  if (ref.source === undefined || ref.source === null) return null;
  if (!isPlainObject(ref.source)) {
    fail(`corpus reference ${JSON.stringify(ref.id)} source must be an object with id and version`, 'INVALID_CORPUS');
  }
  for (const key of Object.keys(ref.source)) {
    if (key !== 'id' && key !== 'version') {
      fail(
        `corpus reference ${JSON.stringify(ref.id)} source has unknown field ${JSON.stringify(key)}; ` +
          'a declared identity is exactly { id, version }',
        'INVALID_CORPUS',
      );
    }
  }
  for (const key of ['id', 'version']) {
    if (typeof ref.source[key] !== 'string' || ref.source[key].length === 0) {
      fail(
        `corpus reference ${JSON.stringify(ref.id)} source.${key} must be a non-empty string: a declared identity ` +
          'needs both the source and its version before it can be verified',
        'INVALID_CORPUS',
      );
    }
  }
  return { id: ref.source.id, version: ref.source.version };
}

/**
 * Accept either a bare array of `{ id, path, sha256, language }` or a
 * corpus.v1 object `{ schema_version, references: [...] }`. Returns
 * `{ schema_version, references: [{ id, path, sha256, language, provenance,
 * permitted_use, declared_exclusions, source, bytes }] }`.
 */
export function loadCorpusManifest(manifestPath) {
  const raw = readJsonChecked(manifestPath, 'corpus manifest');
  let references;
  let schemaVersion = CORPUS_SCHEMA_VERSION;
  if (Array.isArray(raw)) {
    references = raw;
  } else if (isPlainObject(raw)) {
    if (raw.schema_version !== undefined && raw.schema_version !== CORPUS_SCHEMA_VERSION) {
      fail(
        `unsupported corpus manifest schema_version ${JSON.stringify(raw.schema_version)}; ` +
          `expected ${JSON.stringify(CORPUS_SCHEMA_VERSION)}`,
        'SCHEMA_VERSION',
      );
    }
    schemaVersion = raw.schema_version ?? CORPUS_SCHEMA_VERSION;
    references = raw.references;
  } else {
    fail('corpus manifest must be a JSON array or object', 'INVALID_CORPUS');
  }
  if (!Array.isArray(references)) fail('corpus manifest must declare a references array', 'INVALID_CORPUS');

  const baseDir = dirname(manifestPath);
  const seen = new Set();
  const loaded = [];
  for (const ref of references) {
    if (!isPlainObject(ref)) fail('corpus reference must be an object', 'INVALID_CORPUS');
    if (typeof ref.id !== 'string' || ref.id.length === 0) {
      fail('corpus reference must have a non-empty string id', 'INVALID_CORPUS');
    }
    if (seen.has(ref.id)) fail(`duplicate corpus reference id ${JSON.stringify(ref.id)}`, 'DUPLICATE_ID');
    seen.add(ref.id);
    if (typeof ref.path !== 'string') {
      fail(`corpus reference ${JSON.stringify(ref.id)} must declare a path`, 'INVALID_CORPUS');
    }
    validateRelativePath(ref.path);
    if (!isSha256Hex(ref.sha256)) {
      fail(`corpus reference ${JSON.stringify(ref.id)} has an invalid sha256`, 'INVALID_CORPUS');
    }
    if (typeof ref.language !== 'string' || ref.language.length === 0) {
      fail(`corpus reference ${JSON.stringify(ref.id)} must declare a language`, 'INVALID_CORPUS');
    }
    for (const field of ['provenance', 'permitted_use']) {
      if (ref[field] !== undefined && ref[field] !== null && typeof ref[field] !== 'string') {
        fail(`corpus reference ${JSON.stringify(ref.id)} ${field} must be a string when present`, 'INVALID_CORPUS');
      }
    }
    if (
      ref.exclusions !== undefined &&
      ref.exclusions !== null &&
      (!Array.isArray(ref.exclusions) || ref.exclusions.some((e) => typeof e !== 'string'))
    ) {
      fail(
        `corpus reference ${JSON.stringify(ref.id)} exclusions must be an array of strings when present`,
        'INVALID_CORPUS',
      );
    }
    const full = resolveInside(baseDir, ref.path);
    const buffer = readBytesChecked(full, `corpus file ${JSON.stringify(ref.path)}`);
    const actualHash = sha256Hex(buffer);
    if (actualHash !== ref.sha256) {
      fail(
        `corpus reference ${JSON.stringify(ref.id)} sha256 mismatch: expected ${ref.sha256}, computed ${actualHash}`,
        'HASH_MISMATCH',
      );
    }
    loaded.push({
      id: ref.id,
      path: ref.path,
      sha256: ref.sha256,
      language: ref.language,
      provenance: typeof ref.provenance === 'string' ? ref.provenance : null,
      permitted_use: typeof ref.permitted_use === 'string' ? ref.permitted_use : DEFAULT_PERMITTED_USE,
      declared_exclusions: Array.isArray(ref.exclusions) ? [...ref.exclusions] : [],
      source: readSourceIdentity(ref),
      bytes: buffer,
    });
  }
  return { schema_version: schemaVersion, references: loaded };
}
