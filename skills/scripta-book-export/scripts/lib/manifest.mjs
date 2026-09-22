/**
 * `edition-manifest.json` — the record that binds a produced edition to the content it was rendered
 * from (schema `edition-manifest.v1`).
 *
 * The renderer writes one next to the files it produced; the verifier (`scripts/verify-edition.mjs`)
 * reads it back and compares it with the documents on disk, so a document is only accepted together
 * with the bytes, the hashes, the page counts and the accepted version (§8.2) it claims. Nothing
 * here reads a document; `verify.mjs` does that. Built-in modules only.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_SCHEMA = 'edition-manifest.v1';
export const MANIFEST_FILE = 'edition-manifest.json';
export const DOCUMENT_FORMATS = Object.freeze(['pdf', 'docx']);
export const REQUEST_FORMATS = Object.freeze(['both', 'pdf', 'docx']);

const SHA256_RE = /^[0-9a-f]{64}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(?:[-_][a-z0-9]+)*$/;

/** The manifest of the edition files in `dir` (the universe folder, or the `--out` folder). */
export function editionManifestFile(dir) {
  return join(dir, MANIFEST_FILE);
}

/** A document entry as the manifest records it: relative path, size, hash and page count. */
function documentEntry(document) {
  return {
    format: document.format,
    path: String(document.path).replace(/\\/g, '/'),
    bytes: document.bytes,
    sha256: document.sha256,
    pages: document.pages === undefined ? null : document.pages,
  };
}

/**
 * The manifest of one renderer run.
 * @param {{universeId: string, generatedAt: string, format: string, language: string,
 *          sourceVersion: string, documents: Array<object>}} run
 */
export function buildManifest(run) {
  return {
    schema_version: MANIFEST_SCHEMA,
    universe_id: run.universeId,
    generated_at: run.generatedAt,
    format: run.format,
    language: run.language,
    source_version: run.sourceVersion,
    documents: run.documents.map(documentEntry),
  };
}

/** The file text: pretty-printed JSON with a trailing newline, so the record reviews like the rest. */
function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Replaces the manifest in one step: a half-written record is never visible to a reader. */
export function writeManifest(dir, manifest) {
  const file = editionManifestFile(dir);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, serializeManifest(manifest));
  renameSync(temporary, file);
  return file;
}

/**
 * What is wrong with a manifest value, as a message fragment, or `null` when it is usable. The
 * checks are the ones a consumer needs: the schema it declares, the identity it binds to, and one
 * honest entry per document it produced.
 */
function manifestProblem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'is not a JSON object.';
  if (raw.schema_version !== MANIFEST_SCHEMA) {
    return `declares the schema ${JSON.stringify(raw.schema_version)}, not ${MANIFEST_SCHEMA}.`;
  }
  if (typeof raw.universe_id !== 'string' || !raw.universe_id) return 'carries no universe_id.';
  if (typeof raw.generated_at !== 'string' || Number.isNaN(Date.parse(raw.generated_at))) {
    return `carries no readable generated_at (${JSON.stringify(raw.generated_at)}).`;
  }
  if (!REQUEST_FORMATS.includes(raw.format)) {
    return `declares the requested format ${JSON.stringify(raw.format)}, not one of ${REQUEST_FORMATS.join(', ')}.`;
  }
  if (typeof raw.language !== 'string' || !LANGUAGE_RE.test(raw.language)) {
    return `carries no language code (${JSON.stringify(raw.language)}).`;
  }
  if (typeof raw.source_version !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw.source_version)) {
    return `carries no accepted-version identity (source_version is ${JSON.stringify(raw.source_version)}).`;
  }
  if (!Array.isArray(raw.documents) || raw.documents.length === 0) return 'records no document.';
  const formats = [];
  for (const entry of raw.documents) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return 'has a document entry that is not an object.';
    const { format, path, bytes, sha256, pages } = entry;
    if (!DOCUMENT_FORMATS.includes(format)) {
      return `has a document entry for the unknown format ${JSON.stringify(format)}.`;
    }
    if (formats.includes(format)) return `records ${format} twice.`;
    formats.push(format);
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')) {
      return `has a document path that is not a relative path inside the output folder (${JSON.stringify(path)}).`;
    }
    if (!Number.isInteger(bytes) || bytes <= 0) return `records ${bytes} bytes for ${path}.`;
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      return `records no sha256 for ${path} (${JSON.stringify(sha256)}).`;
    }
    if (format === 'pdf' && (!Number.isInteger(pages) || pages <= 0)) {
      return `records ${JSON.stringify(pages)} pages for the PDF ${path}.`;
    }
    if (format === 'docx' && pages !== null) {
      return `records ${JSON.stringify(pages)} pages for the DOCX ${path}, where no page count is read.`;
    }
  }
  const expected = raw.format === 'both' ? [...DOCUMENT_FORMATS] : [raw.format];
  if (expected.length !== formats.length || expected.some((format) => !formats.includes(format))) {
    return `declares the requested format ${raw.format} but records [${formats.join(', ')}].`;
  }
  return null;
}

/**
 * Reads the manifest of `dir` without throwing.
 * @returns {{ok: true, manifest: object, file: string}
 *          |{ok: false, missing: boolean, message: string, file: string}}
 */
export function readManifest(dir) {
  const file = editionManifestFile(dir);
  if (!existsSync(file)) return { ok: false, missing: true, message: `${file} does not exist`, file };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, missing: false, message: `${file} is not valid JSON (${error.message})`, file };
  }
  const problem = manifestProblem(raw);
  if (problem) return { ok: false, missing: false, message: `${file} ${problem}`, file };
  return { ok: true, manifest: raw, file };
}

/** The manifest entry for one format, or `null` when the manifest does not record it. */
export function manifestDocument(manifest, format) {
  return manifest.documents.find((entry) => entry.format === format) ?? null;
}
