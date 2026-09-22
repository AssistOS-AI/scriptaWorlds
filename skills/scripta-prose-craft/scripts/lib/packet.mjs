/**
 * packet.mjs — loading and verification of an `assessment-input.v2` packet
 * (`docs/contracts.md` §8.2 and §8.3).
 *
 * A packet is a directory that holds `manifest.json` plus every referenced file at its
 * relative path. This module:
 *   - recomputes the accepted-version identity of §8.2 from the `chapter`, `offer`,
 *     `canon`, `threads` and `atlas` entries and refuses a manifest that declares a
 *     different one;
 *   - verifies every declared file's byte count and SHA-256;
 *   - rejects a missing manifest, an unknown `schema_version`, a duplicate `path`, a
 *     duplicate `artifact_id` and a duplicate `chapter`, an absolute or `..` path and a
 *     symlink escape, resolving real paths rather than comparing strings, a missing file,
 *     a `role` outside the documented vocabulary (`ROLE_UNDECLARED`), bytes that are not
 *     valid UTF-8 (`INVALID_ENCODING`), a byte count or hash that does not match, and a
 *     `version` that differs from the recomputed §8.2 identity;
 *   - enforces the declared `scope.kind` (`complete`, `partial`, `textual_only`).
 *
 * Every refusal is a structured list of `<CODE>: <message>` strings; the caller prints
 * them in one JSON envelope and exits 2. Nothing is ever written.
 *
 * The module is deliberately duplicated in each portable skill that reads a packet: a
 * skill folder must stand alone, so it may import neither `src/` nor another skill.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

export const PACKET_SCHEMA = 'assessment-input.v2';

/** Superseded manifests: they carry no accepted version identity and are named as such. */
export const LEGACY_PACKET_SCHEMAS = new Set(['assessment-input.v1']);

/** Every role an entry may declare (§8.3). */
export const FILE_ROLES = new Set([
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
]);

/** The roles that take part in the accepted version identity (§8.2). */
export const VERSION_ROLES = new Set(['chapter', 'offer', 'canon', 'threads', 'atlas']);

/** The state containers a `complete` packet must carry. */
export const STATE_ROLES = ['canon', 'threads', 'atlas'];

export const SCOPE_KINDS = new Set(['complete', 'partial', 'textual_only']);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_ID = /^sha256:[0-9a-f]{64}$/;
const CHAPTER_ARTIFACT = /^chapter-\d{4,}$/;
const OFFER_ARTIFACT = /^offer-\d{4,}$/;

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The one identity form of an identifier: surrounding whitespace trimmed and Unicode NFC
 * applied, so two identifiers that differ only by that are the same identifier and collide.
 * It lives here because every document kind this skill reads shares the rule.
 */
export function normalizeId(value) {
  return value.trim().normalize('NFC');
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** §8.3: every declared file is UTF-8; a file whose bytes are not is refused, not decoded loosely. */
export function isValidUtf8(bytes) {
  try {
    UTF8_DECODER.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function structuredError(code, message) {
  return `${code}: ${message}`;
}

function compareByteOrder(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The accepted-version identity of §8.2: `sha256:<hex>` over the entries whose role
 * takes part, each rendered as `path\tsha256\tbytes\n`, sorted by path in byte order.
 * `meta` and the assessment inputs are excluded, so a rewritten `universe.json` or a
 * design note never changes the identity of the accepted book.
 */
export function computeVersion(entries) {
  const lines = entries
    .filter((entry) => VERSION_ROLES.has(entry.role))
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`);
  lines.sort(compareByteOrder);
  return `sha256:${sha256Hex(lines.join(''))}`;
}

function validRelativePath(path) {
  if (!nonEmptyString(path) || path.includes('\\') || isAbsolute(path)) {
    return false;
  }
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isInside(child, parent) {
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}

function enforceScope(scope, lastAcceptedChapter, entries, fail) {
  const roles = new Set(entries.map((entry) => entry.role));
  const chapters = new Set(
    entries.filter((entry) => entry.role === 'chapter').map((entry) => entry.chapter),
  );
  const omitted = Array.isArray(scope.omitted) ? scope.omitted : [];
  const declared = Array.isArray(scope.chapters) ? scope.chapters : [];

  for (let i = 0; i < declared.length; i += 1) {
    const number = declared[i];
    if (!Number.isInteger(number) || number < 1) {
      fail('INVALID_MANIFEST', `context manifest.scope.chapters[${i}] must be a positive integer`);
      continue;
    }
    if (!chapters.has(number)) {
      fail(
        'SCOPE_INCOMPLETE',
        `context manifest.scope.chapters declares chapter ${number}, which the packet does not contain`,
      );
    }
  }
  for (let i = 0; i < omitted.length; i += 1) {
    const number = omitted[i];
    if (!Number.isInteger(number) || number < 1 || number > lastAcceptedChapter) {
      fail(
        'INVALID_MANIFEST',
        `context manifest.scope.omitted[${i}] must be a chapter number between 1 and ${lastAcceptedChapter}`,
      );
    }
  }

  const missing = [];
  for (let number = 1; number <= lastAcceptedChapter; number += 1) {
    if (!chapters.has(number)) {
      missing.push(number);
    }
  }

  if (scope.kind === 'complete') {
    for (const number of missing) {
      fail(
        'SCOPE_INCOMPLETE',
        `context manifest.scope.kind "complete" omits the interior chapter ${number} of ` +
          `${lastAcceptedChapter} accepted chapter(s)`,
      );
    }
    for (const role of STATE_ROLES) {
      if (!roles.has(role)) {
        fail(
          'SCOPE_INCOMPLETE',
          `context manifest.scope.kind "complete" omits the required "${role}" role`,
        );
      }
    }
    if (omitted.length > 0) {
      fail('SCOPE_INCONSISTENT', 'context manifest.scope.kind "complete" declares omissions in scope.omitted');
    }
  } else if (scope.kind === 'partial') {
    if (chapters.size === 0) {
      fail('SCOPE_INCOMPLETE', 'context manifest.scope.kind "partial" contains no chapter prose');
    }
    for (const number of missing) {
      if (!omitted.includes(number)) {
        fail(
          'SCOPE_INCONSISTENT',
          `context manifest.scope.kind "partial" omits chapter ${number} without declaring it in scope.omitted`,
        );
      }
    }
  } else if (scope.kind === 'textual_only') {
    if (chapters.size === 0) {
      fail('SCOPE_INCOMPLETE', 'context manifest.scope.kind "textual_only" contains no chapter prose');
    }
    for (const role of STATE_ROLES) {
      if (roles.has(role)) {
        fail(
          'SCOPE_INCONSISTENT',
          `context manifest.scope.kind "textual_only" carries prose alone but declares the "${role}" role`,
        );
      }
    }
  }
}

/**
 * Reads the UTF-8 text of one file a loaded packet declares, resolving the path inside the
 * verified packet directory so that a caller never reads through the working directory.
 * Returns null when the path is not declared by the packet or cannot be read, which lets a
 * caller report an unverified reference instead of following an arbitrary path.
 */
export async function readPacketText(packet, path) {
  if (!isPlainObject(packet) || !Array.isArray(packet.files)) {
    return null;
  }
  const entry = packet.files.find((file) => file.path === path);
  if (entry === undefined) {
    return null;
  }
  try {
    return await readFile(join(packet.packetDirReal, entry.path), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Loads and verifies the packet named on the command line — either the packet directory
 * or the `manifest.json` file itself. Returns `{ errors, packet }`; `packet` is null
 * whenever anything was refused. Only an unexpected failure (not a missing or invalid
 * input) is thrown.
 */
export async function loadPacket(contextPath) {
  const errors = [];
  const fail = (code, message) => errors.push(structuredError(code, message));

  let info;
  try {
    info = await stat(contextPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail('MISSING_CONTEXT', `context path does not exist: ${contextPath}`);
      return { errors, packet: null };
    }
    throw err;
  }

  const packetDir = info.isDirectory() ? contextPath : dirname(contextPath);
  const manifestPath = info.isDirectory() ? join(contextPath, 'manifest.json') : contextPath;

  let manifestText;
  try {
    manifestText = await readFile(manifestPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      fail('MISSING_MANIFEST', `context manifest is missing: ${manifestPath}`);
      return { errors, packet: null };
    }
    throw err;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    fail('BAD_JSON', `context manifest is not valid JSON: ${err.message}`);
    return { errors, packet: null };
  }

  if (!isPlainObject(manifest)) {
    fail('INVALID_MANIFEST', 'context manifest must be a JSON object');
    return { errors, packet: null };
  }

  if (manifest.schema_version !== PACKET_SCHEMA) {
    const declared = JSON.stringify(manifest.schema_version);
    if (LEGACY_PACKET_SCHEMAS.has(manifest.schema_version)) {
      fail(
        'SCHEMA_VERSION',
        `context manifest schema_version ${declared} is superseded by "${PACKET_SCHEMA}": a superseded ` +
          'manifest carries no accepted version identity (§8.2) and cannot be cross-checked; capture a new packet',
      );
    } else {
      fail('SCHEMA_VERSION', `context manifest schema_version must be "${PACKET_SCHEMA}", got ${declared}`);
    }
    return { errors, packet: null };
  }

  const universeId = nonEmptyString(manifest.universe_id) ? manifest.universe_id.trim() : null;
  if (universeId === null) {
    fail('INVALID_MANIFEST', 'context manifest.universe_id must be a non-empty string');
  }

  const version = nonEmptyString(manifest.version) ? manifest.version.trim() : null;
  if (version === null) {
    fail('INVALID_MANIFEST', 'context manifest.version (the accepted content identity, §8.2) is required');
  } else if (!VERSION_ID.test(version)) {
    fail('INVALID_MANIFEST', `context manifest.version must be a "sha256:<64 hex>" identity, got ${JSON.stringify(version)}`);
  }

  if (!nonEmptyString(manifest.captured_at)) {
    fail('INVALID_MANIFEST', 'context manifest.captured_at must be a non-empty ISO 8601 string');
  }

  const book = isPlainObject(manifest.book) ? manifest.book : null;
  if (book === null) {
    fail('INVALID_MANIFEST', 'context manifest.book must be an object');
  } else {
    for (const key of ['title', 'language']) {
      if (!nonEmptyString(book[key])) {
        fail('INVALID_MANIFEST', `context manifest.book.${key} must be a non-empty string`);
      }
    }
    if (!Number.isInteger(book.last_accepted_chapter) || book.last_accepted_chapter < 0) {
      fail('INVALID_MANIFEST', 'context manifest.book.last_accepted_chapter must be a non-negative integer');
    }
  }

  const scope = isPlainObject(manifest.scope) ? manifest.scope : null;
  if (scope === null) {
    fail('INVALID_MANIFEST', 'context manifest.scope must be an object');
  } else if (!SCOPE_KINDS.has(scope.kind)) {
    fail('INVALID_MANIFEST', `context manifest.scope.kind must be one of: ${[...SCOPE_KINDS].join(', ')}`);
  }

  if (!Array.isArray(manifest.files)) {
    fail('INVALID_MANIFEST', 'context manifest.files must be an array');
  }

  if (errors.length > 0) {
    return { errors, packet: null };
  }

  let packetDirReal;
  try {
    packetDirReal = await realpath(packetDir);
  } catch {
    fail('MISSING_CONTEXT', `context packet directory is not readable: ${packetDir}`);
    return { errors, packet: null };
  }

  const entries = [];
  const seenPaths = new Set();
  const seenArtifacts = new Set();
  const seenChapters = new Set();

  for (let i = 0; i < manifest.files.length; i += 1) {
    const entry = manifest.files[i];
    const at = `manifest.files[${i}]`;
    if (!isPlainObject(entry)) {
      fail('INVALID_MANIFEST', `${at} must be an object`);
      continue;
    }

    const path = entry.path;
    if (!validRelativePath(path)) {
      fail(
        'PATH_ESCAPE',
        `${at}.path ${JSON.stringify(path)} must be a relative forward-slash path inside the packet, without ".."`,
      );
      continue;
    }
    if (seenPaths.has(path)) {
      fail('DUPLICATE_PATH', `context manifest declares the path ${JSON.stringify(path)} twice`);
      continue;
    }
    seenPaths.add(path);

    const artifactId = nonEmptyString(entry.artifact_id) ? entry.artifact_id.trim() : null;
    if (artifactId === null) {
      fail('INVALID_MANIFEST', `${at}.artifact_id must be a non-empty string`);
    } else if (seenArtifacts.has(artifactId)) {
      fail('DUPLICATE_ARTIFACT_ID', `context manifest declares the artifact_id ${JSON.stringify(artifactId)} twice`);
    } else {
      seenArtifacts.add(artifactId);
    }

    if (!FILE_ROLES.has(entry.role)) {
      fail(
        'ROLE_UNDECLARED',
        `${at}.role ${JSON.stringify(entry.role)} is not one of the documented roles of §8.3 ` +
          `(${[...FILE_ROLES].join(', ')})`,
      );
      continue;
    }

    if (entry.role === 'chapter') {
      if (!Number.isInteger(entry.chapter) || entry.chapter < 1) {
        fail('INVALID_MANIFEST', `${at}.chapter must be the positive chapter number of a "chapter" entry`);
      } else if (seenChapters.has(entry.chapter)) {
        fail('DUPLICATE_CHAPTER', `context manifest declares chapter ${entry.chapter} twice`);
      } else {
        seenChapters.add(entry.chapter);
      }
      if (artifactId !== null && !CHAPTER_ARTIFACT.test(artifactId)) {
        fail('INVALID_MANIFEST', `${at}.artifact_id ${JSON.stringify(artifactId)} must name the chapter as "chapter-NNNN"`);
      }
    }
    if (entry.role === 'offer' && artifactId !== null && !OFFER_ARTIFACT.test(artifactId)) {
      fail('INVALID_MANIFEST', `${at}.artifact_id ${JSON.stringify(artifactId)} must name the offer as "offer-NNNN"`);
    }

    const declaredSha = typeof entry.sha256 === 'string' ? entry.sha256.trim().toLowerCase() : '';
    const shaOk = SHA256_HEX.test(declaredSha);
    if (!shaOk) {
      fail('INVALID_MANIFEST', `${at}.sha256 must be 64 hex characters`);
    }
    const bytesOk = Number.isInteger(entry.bytes) && entry.bytes >= 0;
    if (!bytesOk) {
      fail('INVALID_MANIFEST', `${at}.bytes must be a non-negative integer`);
    }
    if (artifactId === null || !shaOk || !bytesOk) {
      continue;
    }

    const absolute = resolve(packetDir, path);
    if (!isInside(absolute, packetDir)) {
      fail('PATH_ESCAPE', `context manifest file path escapes the packet directory: ${path}`);
      continue;
    }

    let realAbsolute;
    try {
      realAbsolute = await realpath(absolute);
    } catch {
      fail('MISSING_FILE', `context manifest file does not exist: ${path}`);
      continue;
    }
    if (!isInside(realAbsolute, packetDirReal)) {
      fail(
        'PATH_ESCAPE',
        `context manifest file path resolves outside the packet directory (symlink escape): ${path}`,
      );
      continue;
    }

    let data;
    try {
      data = await readFile(realAbsolute);
    } catch {
      fail('MISSING_FILE', `context manifest file is not readable: ${path}`);
      continue;
    }

    if (!isValidUtf8(data)) {
      fail('INVALID_ENCODING', `context manifest file ${path} is not valid UTF-8`);
      continue;
    }

    if (data.length !== entry.bytes) {
      fail('BYTE_MISMATCH', `context manifest file ${path} declares ${entry.bytes} bytes but has ${data.length}`);
      continue;
    }
    const computedSha = sha256Hex(data);
    if (computedSha !== declaredSha) {
      fail(
        'HASH_MISMATCH',
        `context manifest file ${path} sha256 mismatch: declared ${declaredSha}, computed ${computedSha}`,
      );
      continue;
    }

    entries.push({
      path,
      role: entry.role,
      sha256: computedSha,
      bytes: data.length,
      artifact_id: artifactId,
      chapter: entry.role === 'chapter' ? entry.chapter : null,
    });
  }

  if (errors.length > 0) {
    return { errors, packet: null };
  }

  const computedVersion = computeVersion(entries);
  if (computedVersion !== version) {
    fail(
      'VERSION_MISMATCH',
      `context manifest.version "${version}" does not match the recomputed accepted version ` +
        `"${computedVersion}" of universe "${universeId}" (§8.2); the packet was altered or its ` +
        'identity was written by another rule',
    );
  }

  enforceScope(scope, book.last_accepted_chapter, entries, fail);

  if (errors.length > 0) {
    return { errors, packet: null };
  }

  return {
    errors,
    packet: {
      manifestPath,
      packetDir,
      packetDirReal,
      manifest,
      universeId,
      version,
      computedVersion,
      book: {
        title: book.title,
        language: book.language,
        lastAcceptedChapter: book.last_accepted_chapter,
      },
      scope,
      files: entries,
      roles: new Set(entries.map((entry) => entry.role)),
      chapterNumbers: seenChapters,
    },
  };
}
