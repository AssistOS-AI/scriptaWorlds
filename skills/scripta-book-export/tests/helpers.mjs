// Shared fixtures for the scripta-book-export suites: temporary universes, the real renderer, the
// §8.2 identity recomputed from the contract, stored ZIP containers for DOCX fixtures and TrueType
// subsets of a real system font. Built-in modules only; no external tool and no npm package.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { crc32 } from '../scripts/lib/errors.mjs';
import { TrueTypeFont } from '../scripts/lib/truetype.mjs';

const execFileAsync = promisify(execFile);

export const BUILD_BOOK = fileURLToPath(new URL('../scripts/build-book.mjs', import.meta.url));
export const VERIFY_EDITION = fileURLToPath(new URL('../scripts/verify-edition.mjs', import.meta.url));

export function makeTempDir(prefix) {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export function removeDir(dir) {
  return rm(dir, { recursive: true, force: true });
}

/**
 * Writes the universe layout of docs/contracts.md §2.1 (metadata, canon, chapters, optionally the
 * editorial metadata, the offers and the three state documents) through plain file writes and
 * returns the universe folder.
 */
export async function writeUniverse(root, options = {}) {
  const {
    id = 'test-universe',
    title = 'The Test Book',
    language = 'en',
    canon = '# Canon\n\n## World\n- A stable fact.\n',
    chapters = {},
    offers = {},
    threads = null,
    atlas = null,
    edition = null,
  } = options;
  const universe = join(root, 'universe');
  await mkdir(join(universe, 'chapters'), { recursive: true });
  await writeFile(join(universe, 'universe.json'), `${JSON.stringify({ id, title, language, status: 'open' })}\n`, 'utf8');
  await writeFile(join(universe, 'canon.md'), canon, 'utf8');
  if (threads) await writeFile(join(universe, 'threads.json'), `${JSON.stringify(threads)}\n`, 'utf8');
  if (atlas) await writeFile(join(universe, 'atlas.json'), `${JSON.stringify(atlas)}\n`, 'utf8');
  for (const [name, markdown] of Object.entries(chapters)) {
    await writeFile(join(universe, 'chapters', name), markdown, 'utf8');
  }
  for (const [name, offer] of Object.entries(offers)) {
    await writeFile(join(universe, 'chapters', name), `${JSON.stringify(offer)}\n`, 'utf8');
  }
  if (edition) {
    await mkdir(join(universe, 'exports'), { recursive: true });
    await writeFile(join(universe, 'exports', 'edition.json'), `${JSON.stringify(edition)}\n`, 'utf8');
  }
  return universe;
}

function parseEnvelope(stdout) {
  const line = String(stdout).trim().split('\n').filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Runs a skill CLI (`process.execPath`) and returns its exit code, streams and JSON line. */
export async function runCli(script, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      cwd: cwd ?? tmpdir(),
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, json: parseEnvelope(stdout) };
  } catch (error) {
    const stdout = error.stdout ?? '';
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout,
      stderr: error.stderr ?? '',
      json: parseEnvelope(stdout),
    };
  }
}

/** Runs the real renderer and returns its exit code, streams and JSON line. */
export async function runRenderer(args, cwd) {
  return runCli(BUILD_BOOK, args, cwd);
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The content identity of docs/contracts.md §8.2 over `entries`, recomputed here from the contract
 * text so the renderer is compared with an independent implementation:
 * `sha256:` + hex of `` `${path}\t${sha256}\t${bytes}\n` `` sorted by path in byte order.
 */
export function identityOf(entries) {
  const lines = [...entries]
    .sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')))
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`)
    .join('');
  return `sha256:${createHash('sha256').update(lines, 'utf8').digest('hex')}`;
}

/** Runs the real verifier (`process.execPath`) and returns its exit code, streams and JSON line. */
export async function runVerifier(args, cwd) {
  return runCli(VERIFY_EDITION, args, cwd);
}

/** The accepted version of a universe, recomputed from the role files the contract names. */
export async function acceptedVersionOf(universe) {
  const roles = [
    ['canon.md', 'canon'],
    ['threads.json', 'threads'],
    ['atlas.json', 'atlas'],
  ];
  const entries = [];
  for (const [relative, role] of roles) {
    const file = join(universe, relative);
    if (!existsSync(file)) continue;
    const bytes = await readFile(file);
    entries.push({ path: relative, role, sha256: sha256(bytes), bytes: bytes.length });
  }
  for (const name of (await readdir(join(universe, 'chapters'))).sort()) {
    const role = /^\d{4}-offer\.json$/.test(name) ? 'offer' : /^\d{4}-[a-z0-9-]+\.md$/.test(name) ? 'chapter' : null;
    if (!role) continue;
    const bytes = await readFile(join(universe, 'chapters', name));
    entries.push({ path: `chapters/${name}`, role, sha256: sha256(bytes), bytes: bytes.length });
  }
  return identityOf(entries);
}

/** The edition manifest the renderer wrote, as a value. */
export async function manifestOf(universe) {
  return JSON.parse(await readFile(join(universe, 'exports', 'edition-manifest.json'), 'utf8'));
}

/** Names, sizes and the manifest bytes of an `exports/` folder: proof that nothing changed. */
export async function exportsSnapshot(universe) {
  const dir = join(universe, 'exports');
  const names = existsSync(dir) ? (await readdir(dir)).sort() : [];
  const sizes = [];
  for (const name of names) sizes.push([name, (await stat(join(dir, name))).size]);
  return JSON.stringify(sizes);
}

/**
 * A ZIP container with stored (uncompressed) members, for DOCX fixtures the writer would never
 * produce: a container without `word/document.xml`, a container whose local headers disagree with
 * its central directory, and so on.
 */
export function storedZip(entries, options = {}) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const checksum = options.crcOverride ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localChunks.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

/** A TrueType face with exactly the requested characters, subsetted from a real system font. */
export function subsetFace(source, codes) {
  return Buffer.from(source.subset(new Set(codes)).data);
}

export function openFont(file) {
  const font = TrueTypeFont.open(file);
  if (!font) throw new Error(`the fixture font ${file} could not be reopened`);
  return font;
}

/** Writes `.ttf` files that classify as the faces of one family (see `classifyFontFile`). */
export async function writeFontFamily(dir, faces) {
  await mkdir(dir, { recursive: true });
  const written = [];
  for (const [suffix, data] of Object.entries(faces)) {
    if (!data) continue;
    const file = join(dir, `TestSerif-${suffix}.ttf`);
    await writeFile(file, data);
    written.push(file);
  }
  return written;
}

export function codesOf(text) {
  const codes = new Set();
  for (const ch of String(text)) codes.add(ch.codePointAt(0));
  return codes;
}
