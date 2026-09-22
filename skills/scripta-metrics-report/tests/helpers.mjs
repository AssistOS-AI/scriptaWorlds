/**
 * Test fixtures for the metrics-report suites.
 *
 * The packet builder writes an `assessment-input.v2` packet and computes the
 * accepted-version identity itself, straight from the §8.2 rule, so a loader
 * bug cannot hide behind a fixture that reused the loader's own arithmetic.
 * Nothing here imports the loader's version helper.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const BUILD_REPORT = resolve(HERE, '..', 'scripts', 'build-report.mjs');

const VERSION_ROLES = ['chapter', 'offer', 'canon', 'threads', 'atlas'];

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Independent implementation of the §8.2 content identity. */
export function versionIdentity(files) {
  const lines = files
    .filter((file) => VERSION_ROLES.includes(file.role))
    .map((file) => `${file.path}\t${file.sha256}\t${file.bytes}\n`);
  lines.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return `sha256:${sha256(Buffer.from(lines.join(''), 'utf8'))}`;
}

export function tempDir(prefix = 'metrics-report-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFile(root, relPath, data) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  return full;
}

export function writeJson(root, relPath, value) {
  return writeFile(root, relPath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Chapter text with a controlled number of whitespace-separated words. */
export function words(count, prefix = 'w') {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ');
}

/**
 * Build a v2 packet.
 *
 *   chapters       { number: text } — the `chapter` role files
 *   offers         { number: object } — optional `offer` role files
 *   stateRoles     which of canon/threads/atlas to include (default all three)
 *   scopeKind      complete | partial | textual_only
 *   omitted        scope.omitted (default: derive the chapters not present)
 *   scopeChapters  scope.chapters override (default: the chapters present)
 *   mutateManifest (manifest) => manifest, applied before writing
 *   afterFiles     (packetDir) => void, applied after the files but before the manifest
 *   chapterBytes   (number, Buffer) => Buffer — replace the written chapter bytes
 */
export function buildPacket(root, options = {}) {
  const chapters = options.chapters ?? { 1: words(12, 'c1'), 2: words(12, 'c2') };
  const offers = options.offers ?? {};
  const stateRoles = options.stateRoles ?? ['canon', 'threads', 'atlas'];
  const scopeKind = options.scopeKind ?? 'complete';
  const files = [];

  for (const [number, text] of Object.entries(chapters)) {
    const path = `chapters/${String(number).padStart(4, '0')}.md`;
    const buffer = options.chapterBytes ? options.chapterBytes(Number(number), Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
    writeFile(root, path, buffer);
    files.push({
      path,
      role: 'chapter',
      artifact_id: `chapter-${String(number).padStart(4, '0')}`,
      chapter: Number(number),
      sha256: sha256(buffer),
      bytes: buffer.length,
    });
  }
  for (const [number, value] of Object.entries(offers)) {
    const path = `chapters/${String(number).padStart(4, '0')}-offer.json`;
    const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    writeFile(root, path, buffer);
    files.push({
      path,
      role: 'offer',
      artifact_id: `offer-${String(number).padStart(4, '0')}`,
      chapter: Number(number),
      sha256: sha256(buffer),
      bytes: buffer.length,
    });
  }
  const stateContent = {
    canon: '# Canon\n\nA canon of two scenes.\n',
    threads: '{"open":[],"closed":[],"promises":[],"deferred_answers":[]}\n',
    atlas: '{"version":1,"axes":[]}\n',
  };
  const statePaths = { canon: 'canon.md', threads: 'threads.json', atlas: 'atlas.json' };
  for (const role of stateRoles) {
    const buffer = Buffer.from(stateContent[role], 'utf8');
    writeFile(root, statePaths[role], buffer);
    files.push({ path: statePaths[role], role, artifact_id: role, sha256: sha256(buffer), bytes: buffer.length });
  }

  if (options.afterFiles) options.afterFiles(root);

  const present = Object.keys(chapters).map(Number).sort((a, b) => a - b);
  const lastAccepted = options.lastAccepted ?? Math.max(...present);
  const all = Array.from({ length: lastAccepted }, (_, index) => index + 1);
  const omitted = options.omitted === undefined ? all.filter((n) => !present.includes(n)) : options.omitted;
  let manifest = {
    schema_version: 'assessment-input.v2',
    universe_id: 'test-universe',
    version: versionIdentity(files),
    captured_at: '2026-09-22T16:40:00.000Z',
    book: { title: 'Test Book', language: options.language ?? 'ro', last_accepted_chapter: lastAccepted },
    scope: {
      kind: scopeKind,
      chapters: options.scopeChapters ?? present,
      omitted,
      note: options.note ?? null,
    },
    files: files.map(({ path, role, artifact_id, chapter, sha256: hash, bytes }) => ({
      path,
      role,
      artifact_id,
      ...(chapter === undefined ? {} : { chapter }),
      sha256: hash,
      bytes,
    })),
  };
  if (options.mutateManifest) manifest = options.mutateManifest(manifest, files) ?? manifest;
  writeJson(root, 'manifest.json', manifest);
  return { packetDir: root, manifest, files, version: manifest.version, byPath: new Map(files.map((f) => [f.path, f])) };
}

/** Run the CLI and return `{ status, envelope, stdout, stderr }` without throwing. */
export function runCli(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BUILD_REPORT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options.cwd,
    }).toString('utf8');
    return { status: 0, envelope: JSON.parse(stdout), stdout, stderr: '' };
  } catch (error) {
    const stdout = error.stdout ? error.stdout.toString('utf8') : '';
    let envelope = null;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      envelope = null;
    }
    return { status: error.status, envelope, stdout, stderr: error.stderr ? error.stderr.toString('utf8') : '' };
  }
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function cleanup(paths) {
  for (const path of paths) {
    if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

export { symlinkSync };
