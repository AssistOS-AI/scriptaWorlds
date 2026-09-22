// Load and verify an assessment-input.v2 packet (no external dependencies).
//
// The packet is both the input and the proof that the input did not change: the
// manifest declares the content identity of one accepted version (contracts
// §8.2), every listed file is re-read and hashed, every path is checked against
// traversal, absolute paths and symlink escape, and the declared scope is
// enforced rather than assumed. Nothing is ever written.
//
// Every refusal carries one of the shared rejection codes of contracts §8.3, so
// a host can act on a refused packet without knowing which skill produced the
// answer: `MISSING_CONTEXT`, `MISSING_MANIFEST`, `BAD_JSON`, `INVALID_MANIFEST`,
// `SCHEMA_VERSION`, `PATH_ESCAPE`, `DUPLICATE_PATH`, `DUPLICATE_ARTIFACT_ID`,
// `DUPLICATE_CHAPTER`, `MISSING_FILE`, `BYTE_MISMATCH`, `HASH_MISMATCH`,
// `VERSION_MISMATCH`, `ROLE_UNDECLARED`, `INVALID_ENCODING`, `SCOPE_INCOMPLETE`
// and `SCOPE_INCONSISTENT`. The code comes first, the human message follows it.

import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { enforceScope, validateDeclaredScope } from './scope.mjs';
import { isPlainObject } from './json-spans.mjs';

// The obligations a declared scope carries live in scope.mjs, which this loader
// enforces against the entries the packet actually carries.

const SCHEMA_VERSION = 'assessment-input.v2';

// Superseded manifests. They carry no accepted version identity (§8.2), so they
// cannot be cross-checked and are named as the reason for the refusal.
const LEGACY_SCHEMA_VERSIONS = new Set(['assessment-input.v1']);

// Every role an entry may declare (contracts §8.3).
const ROLES = new Set([
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

// The roles whose bytes form the accepted version identity (contracts §8.2).
export const VERSION_ROLES = new Set(['chapter', 'offer', 'canon', 'threads', 'atlas']);

const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CHAPTER_ARTIFACT_RE = /^chapter-\d{4,}$/;
const OFFER_ARTIFACT_RE = /^offer-\d{4,}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^sha256:[0-9a-f]{64}$/;
const CHAPTER_PATH_RE = /^chapters\/(\d{4,})-/;

const decoder = new TextDecoder('utf-8', { fatal: true });

// `CODE: message`, the refusal format every consumer of §8.3 shares.
export function structuredError(code, message) {
  return `${code}: ${message}`;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// Thrown on any invalid packet; carries the full list of coded refusals.
export class PacketError extends Error {
  constructor(errors) {
    const list = Array.isArray(errors) ? errors : [errors];
    super(list.join('; '));
    this.name = 'PacketError';
    this.errors = list;
  }
}

// A relative forward-slash path inside the packet: no absolute path, no drive
// letter, no `.`/`..` segment, no backslash and no null byte.
function isValidRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.startsWith('/')) return false;
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

function isInsidePath(childAbs, parentAbs) {
  if (childAbs === parentAbs) return true;
  return childAbs.startsWith(parentAbs + sep);
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

// True when the bytes decode as strict UTF-8, so a replacement character in the
// reviewed prose is always a genuine U+FFFD of the book and never a decoding
// artifact of the packet.
function isValidUtf8(data) {
  try {
    decoder.decode(data);
    return true;
  } catch {
    return false;
  }
}

export function chapterNumberFromPath(path) {
  const match = path.match(CHAPTER_PATH_RE);
  return match ? Number.parseInt(match[1], 10) : null;
}

function padChapter(number) {
  return String(number).padStart(4, '0');
}

// The accepted version identity of §8.2: one `path\tsha256\tbytes\n` line for
// every chapter, offer, canon, threads and atlas entry, sorted by path in byte
// order, hashed and prefixed with `sha256:`.
export function computeVersionIdentity(entries) {
  const lines = entries
    .filter((entry) => VERSION_ROLES.has(entry.role))
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return `sha256:${sha256Hex(Buffer.from(lines.join(''), 'utf8'))}`;
}

// Validate every entry of `manifest.files`: paths, identifiers, roles, declared
// byte counts and hashes. Collects every refusal instead of stopping at the
// first one, because a host repairing a packet wants the whole list.
function validateEntries(errors, files, fail) {
  const seenPaths = new Set();
  const seenArtifacts = new Set();
  const seenChapters = new Set();

  for (let index = 0; index < files.length; index += 1) {
    const entry = files[index];
    const at = `manifest.files[${index}]`;
    if (!isPlainObject(entry)) {
      fail('INVALID_MANIFEST', `${at} must be an object`);
      continue;
    }
    const { path } = entry;
    if (!isValidRelativePath(path)) {
      fail(
        'PATH_ESCAPE',
        `${at}.path ${JSON.stringify(path)} must be a relative forward-slash path inside the packet, ` +
          'without ".."',
      );
      continue;
    }
    if (seenPaths.has(path)) {
      fail('DUPLICATE_PATH', `this manifest declares the path ${JSON.stringify(path)} twice`);
      continue;
    }
    seenPaths.add(path);

    if (!isNonEmptyString(entry.artifact_id) || !ARTIFACT_ID_RE.test(entry.artifact_id)) {
      fail(
        'INVALID_MANIFEST',
        `${at}.artifact_id must be a non-empty [a-z0-9-] identifier, got ${JSON.stringify(entry.artifact_id)}`,
      );
    } else if (seenArtifacts.has(entry.artifact_id)) {
      fail(
        'DUPLICATE_ARTIFACT_ID',
        `this manifest declares the artifact_id ${JSON.stringify(entry.artifact_id)} twice`,
      );
    } else {
      seenArtifacts.add(entry.artifact_id);
    }

    if (!ROLES.has(entry.role)) {
      fail(
        'ROLE_UNDECLARED',
        `${at}.role ${JSON.stringify(entry.role)} is not one of the documented roles of §8.3 ` +
          `(${[...ROLES].join(', ')})`,
      );
      continue;
    }

    if (entry.role === 'chapter') {
      if (!Number.isInteger(entry.chapter) || entry.chapter < 1) {
        fail('INVALID_MANIFEST', `${at}.chapter must be the positive chapter number of a "chapter" entry`);
      } else if (seenChapters.has(entry.chapter)) {
        fail('DUPLICATE_CHAPTER', `this manifest declares chapter ${entry.chapter} twice`);
      } else {
        seenChapters.add(entry.chapter);
      }
      if (isNonEmptyString(entry.artifact_id) && !CHAPTER_ARTIFACT_RE.test(entry.artifact_id)) {
        fail(
          'INVALID_MANIFEST',
          `${at}.artifact_id ${JSON.stringify(entry.artifact_id)} must name the chapter as "chapter-NNNN"`,
        );
      }
    }
    if (entry.role === 'offer' && isNonEmptyString(entry.artifact_id) && !OFFER_ARTIFACT_RE.test(entry.artifact_id)) {
      fail(
        'INVALID_MANIFEST',
        `${at}.artifact_id ${JSON.stringify(entry.artifact_id)} must name the offer as "offer-NNNN"`,
      );
    }

    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) {
      fail('INVALID_MANIFEST', `${at}.sha256 must be 64 lowercase hex characters`);
    }
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) {
      fail('INVALID_MANIFEST', `${at}.bytes must be a non-negative integer`);
    }
  }

  return { seenChapters };
}

// Re-read, hash and encode-check the declared files. Runs only after every entry
// is structurally valid, so a filesystem walk never follows a path the manifest
// did not shape correctly.
async function readEntries(packetDir, packetDirReal, files, fail) {
  const loaded = new Map();
  for (const entry of files) {
    const { path, sha256: declaredSha, bytes } = entry;
    if (!isValidRelativePath(path)) continue;

    const absolute = resolve(packetDir, path);
    if (!isInsidePath(absolute, packetDir)) {
      fail('PATH_ESCAPE', `manifest file path escapes the packet directory: ${path}`);
      continue;
    }

    let realAbsolute;
    try {
      realAbsolute = await realpath(absolute);
    } catch {
      fail('MISSING_FILE', `the manifest declares ${path}, which does not exist in the packet`);
      continue;
    }
    if (!isInsidePath(realAbsolute, packetDirReal)) {
      fail(
        'PATH_ESCAPE',
        `manifest file path resolves outside the packet directory (symlink escape): ${path}`,
      );
      continue;
    }

    let data;
    try {
      data = await readFile(realAbsolute);
    } catch {
      fail('MISSING_FILE', `the manifest declares ${path}, which is not readable`);
      continue;
    }

    if (!isValidUtf8(data)) {
      fail('INVALID_ENCODING', `manifest file ${path} is not valid UTF-8`);
      continue;
    }
    if (data.length !== bytes) {
      fail('BYTE_MISMATCH', `manifest file ${path} declares ${bytes} bytes but has ${data.length}`);
      continue;
    }
    const computed = sha256Hex(data);
    if (computed !== declaredSha) {
      fail(
        'HASH_MISMATCH',
        `manifest file ${path} sha256 mismatch: declared ${declaredSha}, computed ${computed}`,
      );
      continue;
    }

    loaded.set(path, {
      path,
      role: entry.role,
      artifactId: entry.artifact_id,
      chapter: entry.role === 'chapter' ? entry.chapter : null,
      sha256: computed,
      bytes: data.length,
      data,
      text: data.toString('utf8'),
    });
  }
  return loaded;
}

// Load, verify and describe one packet. Throws PacketError with the coded
// refusals; returns the packet on success.
export async function loadPacket(inputArg) {
  const errors = [];
  const fail = (code, message) => errors.push(structuredError(code, message));

  let inputInfo = null;
  try {
    inputInfo = await stat(resolve(inputArg));
  } catch {
    fail('MISSING_CONTEXT', `input packet does not exist: ${resolve(inputArg)}`);
    throw new PacketError(errors);
  }
  if (!inputInfo.isDirectory()) {
    fail('MISSING_CONTEXT', `--input must be the packet directory, but ${resolve(inputArg)} is not a directory`);
    throw new PacketError(errors);
  }
  const packetDir = resolve(inputArg);

  const manifestPath = join(packetDir, 'manifest.json');
  let manifestData;
  try {
    manifestData = await readFile(manifestPath);
  } catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'EISDIR') {
      fail('MISSING_MANIFEST', `the packet has no manifest.json: ${manifestPath}`);
    } else {
      fail('MISSING_MANIFEST', `the packet manifest is not readable: ${manifestPath} (${cause.message})`);
    }
    throw new PacketError(errors);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestData.toString('utf8'));
  } catch (cause) {
    fail('BAD_JSON', `manifest.json is not valid JSON: ${cause.message}`);
    throw new PacketError(errors);
  }

  if (!isPlainObject(manifest)) {
    fail('INVALID_MANIFEST', 'manifest.json must be a JSON object');
    throw new PacketError(errors);
  }

  if (manifest.schema_version !== SCHEMA_VERSION) {
    const declared = JSON.stringify(manifest.schema_version);
    if (LEGACY_SCHEMA_VERSIONS.has(manifest.schema_version)) {
      fail(
        'SCHEMA_VERSION',
        `manifest schema_version ${declared} is superseded by "${SCHEMA_VERSION}": a superseded manifest ` +
          'carries no accepted version identity (§8.2) and cannot be cross-checked; capture a new packet',
      );
    } else {
      fail('SCHEMA_VERSION', `manifest schema_version must be "${SCHEMA_VERSION}", got ${declared}`);
    }
    throw new PacketError(errors);
  }

  if (!isNonEmptyString(manifest.universe_id)) {
    fail('INVALID_MANIFEST', 'manifest.universe_id must be a non-empty string');
  }
  if (!isNonEmptyString(manifest.version) || !VERSION_RE.test(manifest.version)) {
    fail(
      'INVALID_MANIFEST',
      'manifest.version must be the accepted content identity of §8.2: "sha256:" plus 64 lowercase hex characters',
    );
  }
  if (!isNonEmptyString(manifest.captured_at)) {
    fail('INVALID_MANIFEST', 'manifest.captured_at must be a non-empty ISO 8601 string');
  }

  const book = isPlainObject(manifest.book) ? manifest.book : null;
  if (book === null) {
    fail('INVALID_MANIFEST', 'manifest.book must be an object');
  } else {
    for (const key of ['title', 'language']) {
      if (!isNonEmptyString(book[key])) {
        fail('INVALID_MANIFEST', `manifest.book.${key} must be a non-empty string`);
      }
    }
    if (!Number.isInteger(book.last_accepted_chapter) || book.last_accepted_chapter < 0) {
      fail('INVALID_MANIFEST', 'manifest.book.last_accepted_chapter must be a non-negative integer');
    }
  }

  const scope = validateDeclaredScope(errors, manifest.scope, fail);

  if (!Array.isArray(manifest.files)) {
    fail('INVALID_MANIFEST', 'manifest.files must be an array');
  }

  if (errors.length > 0) throw new PacketError(errors);

  let packetDirReal;
  try {
    packetDirReal = await realpath(packetDir);
  } catch {
    fail('MISSING_CONTEXT', `the packet directory is not readable: ${packetDir}`);
    throw new PacketError(errors);
  }

  validateEntries(errors, manifest.files, fail);
  if (errors.length > 0) throw new PacketError(errors);

  const files = await readEntries(packetDir, packetDirReal, manifest.files, fail);
  if (errors.length > 0) throw new PacketError(errors);

  const entries = [...files.values()];
  const declaredVersion = computeVersionIdentity(entries);
  if (declaredVersion !== manifest.version) {
    fail(
      'VERSION_MISMATCH',
      `manifest.version ${manifest.version} does not match the recomputed accepted-version identity ` +
        `${declaredVersion} of universe ${JSON.stringify(manifest.universe_id)} (§8.2); the packet was ` +
        'altered or its identity was written by another rule',
    );
  }

  enforceScope(scope, book.last_accepted_chapter, entries, fail);
  if (errors.length > 0) throw new PacketError(errors);

  const chapterNumbers = entries
    .filter((entry) => entry.role === 'chapter')
    .map((entry) => entry.chapter)
    .sort((a, b) => a - b);

  return {
    packetDir,
    packetDirReal,
    manifestPath,
    manifest,
    scope,
    version: declaredVersion,
    universeId: manifest.universe_id,
    lastAcceptedChapter: book.last_accepted_chapter,
    chapterNumbers,
    omitted: [...(scope.omitted ?? [])].sort((a, b) => a - b),
    files,
    entries,
    manifestSha256: sha256Hex(manifestData),
    manifestData,
  };
}
