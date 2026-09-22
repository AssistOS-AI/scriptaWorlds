// Shared fixtures for the continuity-review test suites (no external dependencies).
//
// The packet builder writes an assessment-input.v2 packet and computes the
// accepted-version identity itself, straight from the §8.2 rule, so a loader bug
// cannot hide behind a fixture that reused the loader's own arithmetic.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL('../scripts/review-continuity.mjs', import.meta.url));

export const VERSION_ROLES = new Set(['chapter', 'offer', 'canon', 'threads', 'atlas']);

export function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

// contracts §8.2: `path\tsha256\tbytes\n` per chapter/offer/canon/threads/atlas
// entry, sorted by path in byte order, joined and hashed with a sha256: prefix.
export function computeVersionIdentity(entries) {
  const lines = entries
    .filter((entry) => VERSION_ROLES.has(entry.role))
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return `sha256:${sha256(lines.join(''))}`;
}

const defaultThreads = { open: [], closed: [], promises: [], deferred_answers: [] };
const defaultAtlas = { version: 1, axes: [] };
const defaultUniverse = { value: { law: 'A test law.' } };

const defaultCanon = '# Canon — Test Book\n\n## World\n- A stable fact.\n';

function defaultChapterText(name) {
  return `# Chapter ${name}\n\nScene content for ${name}.\n`;
}

function slugFor(path) {
  return path
    .replace(/[^a-z0-9.]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

// The chapter numbers declared by a list of `chapters/NNNN-….md` paths.
function chapterFilePathNumbers(paths) {
  return paths
    .map((path) => {
      const match = path.match(/^chapters\/(\d{4})-/);
      return match ? Number.parseInt(match[1], 10) : null;
    })
    .filter((number) => number !== null)
    .sort((a, b) => a - b);
}

// Build an assessment-input.v2 packet.
//
//   chapters       file names under chapters/ (default two clean chapters)
//   chapterTexts   optional map file name -> text
//   lastAccepted   book.last_accepted_chapter (default: chapters.length)
//   kind           scope.kind (default "complete")
//   omitted        scope.omitted
//   canon/threads/atlas/universe  file text or JSON value; a falsy value omits
//   extraFiles     [{ path, text, role, artifact_id?, chapter? }]
//   tamperManifest (manifest) => manifest
export async function makePacket(dir, opts = {}) {
  const {
    chapters = ['0001-scene.md', '0002-scene.md'],
    chapterTexts = {},
    lastAccepted = chapters.length,
    kind = 'complete',
    omitted = [],
    canon = defaultCanon,
    threads = defaultThreads,
    atlas = defaultAtlas,
    universe = defaultUniverse,
    extraFiles = [],
    scopeNote = 'captured for review',
    tamperManifest = null,
  } = opts;

  const packetDir = join(dir, 'packet');
  await mkdir(join(packetDir, 'chapters'), { recursive: true });

  const contents = new Map();
  for (const name of chapters) {
    contents.set(`chapters/${name}`, chapterTexts[name] ?? defaultChapterText(name));
  }
  if (canon) contents.set('canon.md', canon);
  if (threads) contents.set('threads.json', typeof threads === 'string' ? threads : JSON.stringify(threads, null, 2));
  if (atlas) contents.set('atlas.json', typeof atlas === 'string' ? atlas : JSON.stringify(atlas, null, 2));
  if (universe) {
    contents.set('universe.json', typeof universe === 'string' ? universe : JSON.stringify(universe, null, 2));
  }

  const manifestFiles = [];
  const addEntry = (path, text, role, extra = {}) => {
    manifestFiles.push({
      path,
      sha256: sha256(text),
      bytes: byteLength(text),
      role,
      ...extra,
    });
  };

  for (const [path, text] of contents) {
    const abs = join(packetDir, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text, 'utf8');
    if (path.startsWith('chapters/') && path.endsWith('.md')) {
      const number = chapterFilePathNumbers([path])[0];
      addEntry(path, text, 'chapter', { artifact_id: `chapter-${String(number).padStart(4, '0')}`, chapter: number });
    } else if (path === 'canon.md') addEntry(path, text, 'canon', { artifact_id: 'canon' });
    else if (path === 'threads.json') addEntry(path, text, 'threads', { artifact_id: 'threads' });
    else if (path === 'atlas.json') addEntry(path, text, 'atlas', { artifact_id: 'atlas' });
    else if (path === 'universe.json') addEntry(path, text, 'meta', { artifact_id: 'meta' });
    else addEntry(path, text, 'design', { artifact_id: slugFor(path) });
  }

  for (const extra of extraFiles) {
    const abs = join(packetDir, extra.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, extra.text, 'utf8');
    const fallbackId = extra.role === 'chapter' ? `chapter-${String(extra.chapter).padStart(4, '0')}` : slugFor(extra.path);
    addEntry(extra.path, extra.text, extra.role, {
      artifact_id: extra.artifact_id ?? fallbackId,
      ...(extra.chapter === undefined ? {} : { chapter: extra.chapter }),
    });
  }

  const presentChapters = manifestFiles
    .filter((file) => file.role === 'chapter')
    .map((file) => file.chapter)
    .sort((a, b) => a - b);

  let manifest = {
    schema_version: 'assessment-input.v2',
    universe_id: 'test-universe',
    version: computeVersionIdentity(manifestFiles),
    captured_at: '2026-01-01T00:00:00.000Z',
    book: {
      title: 'Test Book',
      language: 'ro',
      last_accepted_chapter: lastAccepted,
    },
    scope: {
      kind,
      chapters: presentChapters,
      omitted,
      note: scopeNote,
    },
    files: manifestFiles,
  };
  if (tamperManifest) manifest = tamperManifest(manifest);

  await writeFile(join(packetDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { packetDir, contents, manifest, version: manifest.version };
}

export async function runReview(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SCRIPT, ...args], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (cause) {
    return { code: cause.code ?? 1, stdout: cause.stdout ?? '', stderr: cause.stderr ?? '' };
  }
}

// relative-path -> sha256 map of a directory tree, for byte-identity checks.
export async function snapshotTree(dir) {
  const map = new Map();
  for (const name of await readdir(dir)) {
    const abs = join(dir, name);
    const info = await stat(abs);
    if (info.isDirectory()) {
      for (const [key, value] of await snapshotTree(abs)) map.set(join(name, key), value);
    } else {
      map.set(name, sha256(await readFile(abs, 'utf8')));
    }
  }
  return map;
}

// A minimal, strict evidence check used to prove code-point boundaries without
// depending on another skill being present: recompute the hash, require the
// offsets to be code-point boundaries, and require the decoded slice to equal
// the quote.
export function checkEvidenceBoundary(item, text) {
  const bytes = Buffer.from(text, 'utf8');
  const boundary = (offset) => offset === 0 || offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
  const problems = [];
  if (!Number.isInteger(item.start) || !Number.isInteger(item.end)) problems.push('offsets must be integers');
  if (!boundary(item.start)) problems.push(`start ${item.start} is not a code-point boundary`);
  if (!boundary(item.end)) problems.push(`end ${item.end} is not a code-point boundary`);
  if (item.end > bytes.length) problems.push('end exceeds the file');
  if (sha256(text) !== item.sha256) problems.push('sha256 mismatch');
  if (problems.length === 0 && bytes.subarray(item.start, item.end).toString('utf8') !== item.quote) {
    problems.push('quote mismatch');
  }
  return problems;
}

export function parseEnvelope(result) {
  return JSON.parse(result.stdout);
}

export function errorCodes(envelope) {
  return envelope.errors.map((message) => String(message).split(':')[0]);
}

// Romanian prose padded so that byte 160 of the file falls *inside* a multi-byte
// character: the 160th byte belongs to 'ș'. A window that ends at 160 must
// therefore be snapped back to a code-point boundary before it can be quoted.
export function romanianBoundaryChapter(title = 'Capitolul 1') {
  const sentence = 'Robinetul din pivniță a fost deschis complet, iar presiunea a scăzut încet. ';
  const head = `# ${title}\n\n`;
  let body = '';
  while (byteLength(head + body + sentence) <= 158) body += sentence;
  body += ' '.repeat(159 - byteLength(head + body));
  return `${head}${body}șirul continuă aici, cu diacritice românești: țări, mâini, câmpii și hotărîri.\n`;
}

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// A semantic claim of a validated annotations.v1 file. The returned object is a
// plain claim whose evidence points at real bytes of the packet; callers mutate
// the copy they need.
export function makeClaim(packetDir, version, evidenceItems, over = {}) {
  return {
    id: 'claim-0001',
    source_version: version,
    scope: { kind: 'book', chapters: [1, 2] },
    evaluator: 'human:reviewer',
    method: 'close reading against the frozen packet',
    kind: 'contradiction',
    category: 'fact',
    severity: 'major',
    certainty: 'deterministic',
    status: 'confirmed',
    rationale: 'The valve was fully open in chapter 1 and half closed in chapter 2 with no repair.',
    evidence: evidenceItems,
    baseline: { chapter: 1, evidence: [evidenceItems[0]] },
    later: { chapter: 2, evidence: [evidenceItems[1]] },
    temporal_scope: { baseline_chapter: 1, later_chapter: 2 },
    alternative_explanation: 'An unshown repair between the two scenes could explain the change.',
    ...over,
  };
}

// An evidence.v1 item for a quote found in `text`, at its real byte offset.
export function evidenceFor(id, path, text, quote) {
  const bytes = Buffer.from(text, 'utf8');
  const start = bytes.indexOf(Buffer.from(quote, 'utf8'));
  if (start === -1) throw new Error(`fixture quote not found in ${path}: ${JSON.stringify(quote)}`);
  return {
    id,
    file: path,
    sha256: sha256(text),
    start,
    end: start + byteLength(quote),
    quote,
  };
}

export async function writeAnnotations(dir, name, document) {
  const file = join(dir, name);
  await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return file;
}

export function annotationsDocument(findings, extra = {}) {
  return { schema_version: 'annotations.v1', findings, ...extra };
}
