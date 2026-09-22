/**
 * `assessment-input.v2` packet loading and validation (contracts §8.2, §8.3).
 *
 * A packet is a directory with `manifest.json` plus the referenced files laid
 * out at their relative paths. Every declared path is validated against
 * traversal, absolute paths and symlink escape with real paths, every file is
 * checked as UTF-8 and against its declared byte count and hash, the accepted
 * version identity of §8.2 is recomputed over the narrative-role entries and
 * compared with the declared one, and the declared scope is checked for the
 * honesty its `kind` promises.
 *
 * Every refusal is a structured CliError (exit 2) raised before any consumer
 * computes or writes anything, and carries the shared rejection code of §8.3 so
 * that all four packet consumers answer identically:
 * MISSING_CONTEXT, MISSING_MANIFEST, BAD_JSON, INVALID_MANIFEST, SCHEMA_VERSION,
 * PATH_ESCAPE, DUPLICATE_PATH, DUPLICATE_ARTIFACT_ID, DUPLICATE_CHAPTER,
 * MISSING_FILE, BYTE_MISMATCH, HASH_MISMATCH, VERSION_MISMATCH, ROLE_UNDECLARED,
 * INVALID_ENCODING, SCOPE_INCOMPLETE, SCOPE_INCONSISTENT.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  fail,
  isNonNegativeInteger,
  isPlainObject,
  isPositiveInteger,
  isSha256Hex,
  isValidUtf8,
  sha256Hex,
  validateRelativePath,
} from './errors.mjs';

export const PACKET_SCHEMA_VERSION = 'assessment-input.v2';

/** Manifests written before the accepted-version identity existed. */
export const LEGACY_PACKET_SCHEMAS = ['assessment-input.v1'];

export const FILE_ROLES = [
  'chapter',
  'offer',
  'canon',
  'threads',
  'atlas',
  'meta',
  'design',
  'profile',
  'annotations',
  'corpus',
  'rules',
  'timing',
];

/** Roles that take part in the accepted version identity (§8.2). */
export const VERSION_ROLES = ['chapter', 'offer', 'canon', 'threads', 'atlas'];

/** Containers a `complete` packet must declare (§8.3). */
export const REQUIRED_STATE_ROLES = ['canon', 'threads', 'atlas'];

/** Containers `textual_only` must not carry: it is prose alone. */
export const STATE_ROLES = ['canon', 'threads', 'atlas', 'meta'];

export const SCOPE_KINDS = ['complete', 'partial', 'textual_only'];

const VERSION_RE = /^sha256:[0-9a-f]{64}$/;
const CHAPTER_ARTIFACT = /^chapter-\d{4,}$/;
const OFFER_ARTIFACT = /^offer-\d{4,}$/;

/**
 * §8.2: `"sha256:" + sha256hex(entries)` over every chapter/offer/canon/threads/
 * atlas entry, each rendered `` `${path}\t${sha256}\t${bytes}\n` `` and sorted
 * by `path` in byte order.
 */
export function computeAcceptedVersion(entries) {
  const relevant = entries
    .filter((entry) => VERSION_ROLES.includes(entry.role))
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`);
  relevant.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return `sha256:${sha256Hex(Buffer.from(relevant.join(''), 'utf8'))}`;
}

function parseChapterNumbers(raw, label, { allowEmpty = true } = {}) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) fail(`${label} must be an array of chapter numbers`, 'INVALID_MANIFEST');
  if (!allowEmpty && raw.length === 0) fail(`${label} must not be empty`, 'INVALID_MANIFEST');
  const seen = new Set();
  for (const value of raw) {
    if (!isPositiveInteger(value)) {
      fail(`${label} must contain positive integers, got ${JSON.stringify(value)}`, 'INVALID_MANIFEST');
    }
    if (seen.has(value)) fail(`${label} contains duplicate chapter ${value}`, 'INVALID_MANIFEST');
    seen.add(value);
  }
  return [...raw].sort((a, b) => a - b);
}

function parseBook(raw) {
  if (!isPlainObject(raw)) fail('manifest.book must be an object', 'INVALID_MANIFEST');
  for (const key of ['title', 'language']) {
    if (typeof raw[key] !== 'string' || raw[key].length === 0) {
      fail(`manifest.book.${key} must be a non-empty string`, 'INVALID_MANIFEST');
    }
  }
  if (!isNonNegativeInteger(raw.last_accepted_chapter)) {
    fail('manifest.book.last_accepted_chapter must be a non-negative integer', 'INVALID_MANIFEST');
  }
  return {
    title: raw.title,
    language: raw.language,
    last_accepted_chapter: raw.last_accepted_chapter,
  };
}

function readDeclaredFile(packetDirReal, path) {
  validateRelativePath(path);
  const absolute = resolve(packetDirReal, path);
  const rel = relative(packetDirReal, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    fail(`manifest file path escapes the packet directory: ${JSON.stringify(path)}`, 'PATH_ESCAPE');
  }
  let real;
  try {
    real = realpathSync(absolute);
  } catch {
    fail(`manifest file does not exist: ${JSON.stringify(path)}`, 'MISSING_FILE');
  }
  const realRel = relative(packetDirReal, real);
  if (realRel.startsWith('..') || isAbsolute(realRel)) {
    fail(
      `manifest file path resolves outside the packet directory (symlink escape): ${JSON.stringify(path)}`,
      'PATH_ESCAPE',
    );
  }
  let buffer;
  try {
    buffer = readFileSync(real);
  } catch {
    fail(`manifest file is not readable: ${JSON.stringify(path)}`, 'MISSING_FILE');
  }
  if (!isValidUtf8(buffer)) {
    fail(`manifest file is not valid UTF-8: ${JSON.stringify(path)}`, 'INVALID_ENCODING');
  }
  return buffer;
}

function loadFileEntries(packetDirReal, rawFiles) {
  if (!Array.isArray(rawFiles)) fail('manifest.files must be an array', 'INVALID_MANIFEST');
  if (rawFiles.length === 0) fail('manifest.files must declare at least one file', 'INVALID_MANIFEST');

  const seenPaths = new Set();
  const seenArtifacts = new Set();
  const seenChapters = new Set();
  const entries = [];

  for (const raw of rawFiles) {
    if (!isPlainObject(raw)) fail('manifest.files contains a non-object entry', 'INVALID_MANIFEST');
    if (typeof raw.path !== 'string') fail('manifest.files entry must have a string path', 'INVALID_MANIFEST');
    validateRelativePath(raw.path);
    if (seenPaths.has(raw.path)) {
      fail(`duplicate file path in manifest: ${JSON.stringify(raw.path)}`, 'DUPLICATE_PATH');
    }
    seenPaths.add(raw.path);

    if (typeof raw.artifact_id !== 'string' || raw.artifact_id.length === 0) {
      fail(`file ${JSON.stringify(raw.path)} must declare a non-empty artifact_id`, 'INVALID_MANIFEST');
    }
    if (seenArtifacts.has(raw.artifact_id)) {
      fail(`duplicate artifact_id in manifest: ${JSON.stringify(raw.artifact_id)}`, 'DUPLICATE_ARTIFACT_ID');
    }
    seenArtifacts.add(raw.artifact_id);

    if (!isSha256Hex(raw.sha256)) fail(`file ${JSON.stringify(raw.path)} has an invalid sha256`, 'INVALID_MANIFEST');
    if (!isNonNegativeInteger(raw.bytes)) {
      fail(`file ${JSON.stringify(raw.path)} must declare a non-negative integer bytes count`, 'INVALID_MANIFEST');
    }
    if (!FILE_ROLES.includes(raw.role)) {
      fail(
        `file ${JSON.stringify(raw.path)} declares role ${JSON.stringify(raw.role)}, which is not one of the ` +
          `documented roles (${FILE_ROLES.join(', ')})`,
        'ROLE_UNDECLARED',
      );
    }

    let chapter = null;
    if (raw.role === 'chapter' || raw.role === 'offer') {
      if (!isPositiveInteger(raw.chapter)) {
        fail(`file ${JSON.stringify(raw.path)} (role ${raw.role}) must declare its chapter number`, 'INVALID_MANIFEST');
      }
      chapter = raw.chapter;
      const pattern = raw.role === 'chapter' ? CHAPTER_ARTIFACT : OFFER_ARTIFACT;
      if (!pattern.test(raw.artifact_id)) {
        fail(
          `file ${JSON.stringify(raw.path)} must use an artifact_id of the form ` +
            `${raw.role === 'chapter' ? '"chapter-NNNN"' : '"offer-NNNN"'}, got ${JSON.stringify(raw.artifact_id)}`,
          'INVALID_MANIFEST',
        );
      }
      if (raw.role === 'chapter') {
        if (seenChapters.has(chapter)) {
          fail(`duplicate chapter entry in manifest: chapter ${chapter}`, 'DUPLICATE_CHAPTER');
        }
        seenChapters.add(chapter);
      }
    } else if (raw.artifact_id !== raw.role) {
      fail(
        `file ${JSON.stringify(raw.path)} with role ${raw.role} must use artifact_id ${JSON.stringify(raw.role)}`,
        'INVALID_MANIFEST',
      );
    }

    const buffer = readDeclaredFile(packetDirReal, raw.path);
    if (buffer.length !== raw.bytes) {
      fail(
        `file ${JSON.stringify(raw.path)} declares ${raw.bytes} bytes but has ${buffer.length}`,
        'BYTE_MISMATCH',
      );
    }
    const actualHash = sha256Hex(buffer);
    if (actualHash !== raw.sha256) {
      fail(
        `file ${JSON.stringify(raw.path)} sha256 mismatch: expected ${raw.sha256}, computed ${actualHash}`,
        'HASH_MISMATCH',
      );
    }

    entries.push({
      path: raw.path,
      role: raw.role,
      artifact_id: raw.artifact_id,
      sha256: raw.sha256,
      bytes: raw.bytes,
      chapter,
      buffer,
    });
  }
  return entries;
}

function parseScope(raw, { entries, book }) {
  if (!isPlainObject(raw)) fail('manifest.scope must be an object', 'INVALID_MANIFEST');
  if (!SCOPE_KINDS.includes(raw.kind)) {
    fail(
      `manifest.scope.kind must be one of ${SCOPE_KINDS.join('|')}, got ${JSON.stringify(raw.kind)}`,
      'INVALID_MANIFEST',
    );
  }
  if (raw.note !== undefined && raw.note !== null && typeof raw.note !== 'string') {
    fail('manifest.scope.note must be a string when present', 'INVALID_MANIFEST');
  }
  if (raw.omitted !== undefined && !Array.isArray(raw.omitted)) {
    fail('manifest.scope.omitted must be an array when present', 'INVALID_MANIFEST');
  }

  const inventory = [...new Set(entries.filter((e) => e.role === 'chapter').map((e) => e.chapter))].sort(
    (a, b) => a - b,
  );
  const declaredChapters = parseChapterNumbers(raw.chapters, 'manifest.scope.chapters');
  const omitted = parseChapterNumbers(raw.omitted, 'manifest.scope.omitted') ?? [];
  const lastAccepted = book.last_accepted_chapter;
  const fullRange = Array.from({ length: lastAccepted }, (_, i) => i + 1);

  for (const number of [...inventory, ...omitted]) {
    if (number > lastAccepted) {
      fail(
        `chapter ${number} is beyond manifest.book.last_accepted_chapter (${lastAccepted})`,
        'INVALID_MANIFEST',
      );
    }
  }
  const both = fullRange.filter((number) => inventory.includes(number) && omitted.includes(number));
  if (both.length > 0) {
    fail(
      `chapter${both.length === 1 ? '' : 's'} ${both.join(', ')} declared both present and omitted in manifest.scope`,
      'SCOPE_INCONSISTENT',
    );
  }
  if (declaredChapters !== null) {
    const declaredPresent = declaredChapters.filter((number) => !omitted.includes(number));
    const same =
      declaredPresent.length === inventory.length && declaredPresent.every((n, i) => n === inventory[i]);
    if (!same) {
      fail(
        `manifest.scope.chapters (${declaredChapters.join(', ')}) does not match the chapter files the ` +
          `packet declares (${inventory.join(', ') || 'none'})`,
        'SCOPE_INCONSISTENT',
      );
    }
    for (const number of declaredChapters) {
      if (!inventory.includes(number) && !omitted.includes(number)) {
        fail(
          `manifest.scope.chapters declares chapter ${number}, which the packet does not contain`,
          'SCOPE_INCOMPLETE',
        );
      }
    }
  }

  const rolesPresent = new Set(entries.map((e) => e.role));
  const missing = fullRange.filter((number) => !inventory.includes(number));
  if (raw.kind === 'complete') {
    if (omitted.length > 0) {
      fail('manifest.scope.kind "complete" declares omissions in scope.omitted; use "partial"', 'SCOPE_INCONSISTENT');
    }
    if (missing.length > 0) {
      fail(
        `manifest.scope.kind "complete" omits the interior chapter${missing.length === 1 ? '' : 's'} ` +
          `${missing.join(', ')} of ${lastAccepted} accepted chapter${lastAccepted === 1 ? '' : 's'}`,
        'SCOPE_INCOMPLETE',
      );
    }
    const missingRoles = REQUIRED_STATE_ROLES.filter((role) => !rolesPresent.has(role));
    if (missingRoles.length > 0) {
      fail(
        `manifest.scope.kind "complete" omits the required state role${missingRoles.length === 1 ? '' : 's'} ` +
          `${missingRoles.join(', ')}`,
        'SCOPE_INCOMPLETE',
      );
    }
  } else if (raw.kind === 'partial') {
    if (raw.omitted === undefined) {
      fail('manifest.scope.kind "partial" must declare its omissions in scope.omitted', 'SCOPE_INCOMPLETE');
    }
    const undeclared = missing.filter((number) => !omitted.includes(number));
    if (undeclared.length > 0) {
      fail(
        `manifest.scope.kind "partial" omits chapter${undeclared.length === 1 ? '' : 's'} ` +
          `${undeclared.join(', ')} without declaring them in scope.omitted`,
        'SCOPE_INCONSISTENT',
      );
    }
  } else {
    const statePresent = STATE_ROLES.filter((role) => rolesPresent.has(role));
    if (statePresent.length > 0) {
      fail(
        `manifest.scope.kind "textual_only" carries prose alone but declares the state role` +
          `${statePresent.length === 1 ? '' : 's'} ${statePresent.join(', ')}`,
        'SCOPE_INCONSISTENT',
      );
    }
  }
  if (inventory.length === 0) {
    fail('the packet must contain at least one chapter file', 'SCOPE_INCOMPLETE');
  }

  return {
    kind: raw.kind,
    chapters: inventory,
    omitted,
    missing,
    note: typeof raw.note === 'string' ? raw.note : null,
  };
}

/**
 * Load and fully validate a packet. Returns the manifest, the loaded files,
 * the recomputed accepted version, the declared scope, the ordered chapter
 * inventory and convenience lookups.
 */
export function loadPacket(packetDir) {
  if (typeof packetDir !== 'string' || packetDir.length === 0) {
    fail('--input must name a packet directory', 'MISSING_CONTEXT');
  }
  if (!existsSync(packetDir)) fail(`packet directory does not exist: ${packetDir}`, 'MISSING_CONTEXT');
  if (!statSync(packetDir).isDirectory()) {
    fail(`--input must be the packet directory, not ${JSON.stringify(packetDir)}`, 'MISSING_CONTEXT');
  }
  let packetDirReal;
  try {
    packetDirReal = realpathSync(packetDir);
  } catch {
    fail(`packet directory is not readable: ${packetDir}`, 'MISSING_CONTEXT');
  }

  const manifestPath = resolve(packetDirReal, 'manifest.json');
  let raw;
  try {
    raw = readFileSync(manifestPath);
  } catch {
    fail(`packet manifest is missing: ${manifestPath}`, 'MISSING_MANIFEST');
  }
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    fail(`packet manifest is not valid JSON: ${error.message}`, 'BAD_JSON');
  }
  if (!isPlainObject(manifest)) fail('packet manifest must be a JSON object', 'INVALID_MANIFEST');
  if (manifest.schema_version !== PACKET_SCHEMA_VERSION) {
    const declared = JSON.stringify(manifest.schema_version);
    if (LEGACY_PACKET_SCHEMAS.includes(manifest.schema_version)) {
      fail(
        `manifest schema_version ${declared} is superseded by ${JSON.stringify(PACKET_SCHEMA_VERSION)}: a ` +
          'superseded manifest carries no accepted version identity and cannot be cross-checked; capture a new packet',
        'SCHEMA_VERSION',
      );
    }
    fail(
      `unsupported manifest schema_version ${declared}; expected ${JSON.stringify(PACKET_SCHEMA_VERSION)}`,
      'SCHEMA_VERSION',
    );
  }
  if (typeof manifest.universe_id !== 'string' || manifest.universe_id.length === 0) {
    fail('manifest.universe_id must be a non-empty string', 'INVALID_MANIFEST');
  }
  if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) {
    fail('manifest.version must be a "sha256:" followed by 64 lowercase hex characters', 'INVALID_MANIFEST');
  }
  if (typeof manifest.captured_at !== 'string' || Number.isNaN(Date.parse(manifest.captured_at))) {
    fail('manifest.captured_at must be an ISO 8601 string', 'INVALID_MANIFEST');
  }
  const book = parseBook(manifest.book);
  const entries = loadFileEntries(packetDirReal, manifest.files);
  const scope = parseScope(manifest.scope, { entries, book });

  const version = computeAcceptedVersion(entries);
  if (version !== manifest.version) {
    fail(
      `manifest.version ${manifest.version} does not match the recomputed accepted version ${version}; ` +
        'the packet is not the version it declares',
      'VERSION_MISMATCH',
    );
  }

  const chapterByNumber = new Map();
  const fileByPath = new Map();
  const filesByRole = new Map();
  for (const entry of entries) {
    fileByPath.set(entry.path, entry);
    if (!filesByRole.has(entry.role)) filesByRole.set(entry.role, []);
    filesByRole.get(entry.role).push(entry);
    if (entry.role === 'chapter') chapterByNumber.set(entry.chapter, entry);
  }

  return {
    manifest,
    manifestPath,
    packetDir,
    packetDirReal,
    files: entries,
    universeId: manifest.universe_id,
    version,
    capturedAt: manifest.captured_at,
    book,
    scope,
    inventory: scope.chapters,
    chapterByNumber,
    fileByPath,
    filesByRole,
    hasRole: (role) => filesByRole.has(role),
  };
}
