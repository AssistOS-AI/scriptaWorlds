// The frozen assessment packet: the accepted version of one book, copied into the external workspace
// with a manifest that names the version, the roles and the hashes (`docs/contracts.md` §8.1–§8.3).
// Nothing here writes inside `universes/`: a packet is a copy, and a phase reads only that copy.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { config } from './config.mjs';
import { nowIso, readJson } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { universeDir } from './paths.mjs';
import { acceptedChapters, scanTurns } from './universe-chapters.mjs';
import { snapshotStatus } from './universe-state.mjs';

const PACKET_SCHEMA = 'assessment-input.v2';
export const PHASES = ['continuity', 'metrics'];
const NARRATIVE_ROLES = ['chapter', 'offer', 'canon', 'threads', 'atlas'];
const STATE_FILES = [
  { path: 'canon.md', role: 'canon' },
  { path: 'threads.json', role: 'threads' },
  { path: 'atlas.json', role: 'atlas' }
];
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const versionSlug = (version) => String(version ?? '').replace(/^sha256:/, 'sha256-');

export const assessmentsRoot = () => config.assessmentWorkspace;
export const universeWorkspace = (universeId) => join(assessmentsRoot(), universeId);
export const runDir = (universeId, version, runId) => join(universeWorkspace(universeId), versionSlug(version), runId);
export const runFile = (universeId, version, runId) => join(runDir(universeId, version, runId), 'run.json');
/** `sha256:` + the content identity of a list of entries, as §8.2 defines it. */
export function acceptedVersion(entries) {
  const lines = [...entries]
    .filter((entry) => NARRATIVE_ROLES.includes(entry.role))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`)
    .join('');
  return `sha256:${sha256(lines)}`;
}

/**
 * The identity of what a run consumed: phase, accepted version, the resolved scope, and the hash of
 * every effective input — profile, annotations, the corpus manifest and each resource it references,
 * any supplied continuity result, and (once the host calls a model) the evaluator and prompt versions
 * and the mode. Two requests with the same fingerprint are the same assessment; a request that changes
 * any evidence is a different one. A record written before fingerprints existed carries none, so it can
 * never be proven identical to a new request.
 */
export function inputFingerprint({
  phase,
  version,
  scope = null,
  trigger = 'requested',
  arcId = null,
  profileSha256 = null,
  annotationsSha256 = null,
  corpusManifestSha256 = null,
  resources = [],
  continuitySha256 = null,
  evaluator = null,
  prompt = null,
  mode = null,
  request = null,
  brief = null,
  intention = null,
  rules = null
} = {}) {
  // Every input that changes what a review can conclude participates in its identity: the normalized
  // scope (chapters, segments, arcs and context), who produces the observations, the prompt and teaching
  // material the evaluator sees, and the words the review was asked about. The version prefix changes when
  // the field set changes, so a record written under an older identity never claims to be this review.
  const serializedScope = scope
    ? [
        scope.kind ?? 'none',
        (scope.chapters ?? []).join(','),
        (scope.segments ?? []).join(','),
        (scope.arcs ?? []).join(','),
        (scope.context_chapters ?? []).join(','),
        (scope.omitted ?? []).join(',')
      ].join(':')
    : 'none';
  const payload = [
    'assessment-input.v2',
    `phase:${phase ?? 'none'}`,
    `version:${version ?? 'none'}`,
    `scope:${serializedScope}`,
    `trigger:${trigger}${arcId ? `:${arcId}` : ''}`,
    `profile:${profileSha256 ?? 'none'}`,
    `annotations:${annotationsSha256 ?? 'none'}`,
    `corpus:${corpusManifestSha256 ?? 'none'}`,
    ...[...resources].sort((a, b) => String(a.path).localeCompare(String(b.path))).map((resource) => `resource:${resource.path}\t${resource.sha256}`),
    `continuity:${continuitySha256 ?? 'none'}`,
    `evaluator:${evaluator ?? 'none'}`,
    `prompt:${prompt ?? 'none'}`,
    `mode:${mode ?? 'deterministic'}`,
    `request:${request ?? 'none'}`,
    `brief:${brief ?? 'none'}`,
    `intention:${intention ?? 'none'}`,
    `rules:${rules ?? 'none'}`
  ].join('\n');
  return `sha256:${sha256(payload)}`;
}

const artifactId = (entry) => {
  if (entry.artifact_id) return entry.artifact_id;
  if (entry.role === 'chapter' || entry.role === 'offer') return `${entry.role}-${String(entry.chapter).padStart(4, '0')}`;
  return entry.role;
};

/**
 * The files a packet can contain, read either from the accepted book or from the immutable snapshot of
 * a finished turn. A chapter that a running turn is writing is never part of it (the accepted view).
 */
async function packetSources(universeId, { fromTurn = null } = {}) {
  if (fromTurn !== null) {
    const status = await snapshotStatus(universeId, fromTurn);
    if (status !== 'complete') {
      throw new UniverseError('NO_SNAPSHOT', `Turn ${fromTurn} has no usable snapshot to capture from (${status}).`, 409);
    }
    const root = join(universeDir(universeId), 'turns', `${String(fromTurn).padStart(4, '0')}.prev`);
    const sources = STATE_FILES.map((file) => ({ ...file, from: join(root, file.path) }));
    for (const name of await readdir(join(root, 'chapters')).catch(() => [])) {
      if (/^\d{4}-.+\.md$/.test(name)) {
        sources.push({ path: `chapters/${name}`, role: 'chapter', chapter: Number(name.slice(0, 4)), from: join(root, 'chapters', name) });
      } else if (/^\d{4}-offer\.json$/.test(name)) {
        sources.push({ path: `chapters/${name}`, role: 'offer', chapter: Number(name.slice(0, 4)), from: join(root, 'chapters', name) });
      }
    }
    return sources;
  }
  const dir = universeDir(universeId);
  const chapters = await acceptedChapters(universeId);
  const sources = STATE_FILES.map((file) => ({ ...file, from: join(dir, file.path) }));
  for (const chapter of chapters) {
    sources.push({ path: chapter.file, role: 'chapter', chapter: chapter.number, from: join(dir, chapter.file) });
    if (chapter.offer) {
      sources.push({
        path: `chapters/${String(chapter.number).padStart(4, '0')}-offer.json`,
        role: 'offer',
        chapter: chapter.number,
        from: join(dir, 'chapters', `${String(chapter.number).padStart(4, '0')}-offer.json`)
      });
    }
  }
  return sources;
}

/**
 * Freeze the accepted version of a universe into `<workspace>/<id>/<version>/<run>/input/`.
 * A version is stable only when no turn of that universe is queued or running, unless the caller
 * captures from the immutable snapshot of a finished turn instead.
 */
export async function capturePacket(universeId, { runId, fromTurn = null, extraFiles = [] } = {}) {
  if (fromTurn === null) {
    const busy = (await scanTurns(universeId)).find((turn) => turn.status === 'queued' || turn.status === 'running');
    if (busy) {
      throw new UniverseError(
        'UNSTABLE_VERSION',
        `Turn ${busy.number} of this book is ${busy.status}: a packet captured now would not be an accepted version. Wait for it, or capture from a finished turn's snapshot.`,
        409
      );
    }
  }
  const sources = await packetSources(universeId, { fromTurn });
  for (const file of extraFiles) {
    sources.push({
      path: file.path,
      role: file.role,
      inline: file.content,
      artifact_id: file.artifact_id,
      declared: file.declared !== false
    });
  }
  const entries = [];
  const resources = [];
  const staged = [];
  for (const source of sources) {
    let bytes;
    if (source.inline !== undefined) bytes = Buffer.from(source.inline, 'utf8');
    else bytes = await readFile(source.from).catch(() => null);
    if (!bytes) {
      if (source.role === 'offer') continue;
      throw new UniverseError('MISSING_FILE', `The packet cannot include ${source.path}: it does not exist.`, 409);
    }
    if (source.declared === false) {
      // A captured resource: it travels inside the packet but the packet's own inventory does not name
      // it, because the file that declares it (a corpus manifest) is the artifact of its role.
      resources.push({ path: source.path, sha256: sha256(bytes), bytes: bytes.length, role: source.role });
      staged.push({ entry: { path: source.path, role: source.role }, bytes });
      continue;
    }
    entries.push({
      path: source.path,
      sha256: sha256(bytes),
      bytes: bytes.length,
      role: source.role,
      ...(source.chapter ? { chapter: source.chapter } : {}),
      artifact_id: artifactId(source)
    });
    staged.push({ entry: entries.at(-1), bytes });
  }
  const version = acceptedVersion(entries);
  const directory = runDir(universeId, version, runId);
  const inputDir = join(directory, 'input');
  // A fresh staging directory, renamed into place: a packet is never half-written.
  const staging = `${inputDir}.staging-${randomBytes(4).toString('hex')}`;
  await mkdir(staging, { recursive: true });
  for (const { entry, bytes } of staged) {
    const target = join(staging, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const chapters = entries.filter((entry) => entry.role === 'chapter').map((entry) => entry.chapter).sort((a, b) => a - b);
  const lastChapter = chapters.reduce((max, number) => Math.max(max, number), 0);
  const missing = [];
  for (let number = 1; number <= lastChapter; number += 1) if (!chapters.includes(number)) missing.push(number);
  const meta = await readJson(join(universeDir(universeId), 'universe.json'), {});
  const manifest = {
    schema_version: PACKET_SCHEMA,
    universe_id: universeId,
    version,
    captured_at: nowIso(),
    book: {
      title: meta.title ?? universeId,
      language: meta.language ?? 'en',
      last_accepted_chapter: lastChapter
    },
    scope: {
      kind: missing.length === 0 ? 'complete' : 'partial',
      chapters,
      omitted: missing,
      ...(fromTurn !== null ? { note: `captured from the snapshot of turn ${fromTurn}` } : {})
    },
    files: entries
  };
  await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await mkdir(join(directory, 'result'), { recursive: true }).catch(() => {});
  await rm(inputDir, { recursive: true, force: true });
  await rename(staging, inputDir);
  return { dir: directory, inputDir, manifest, resources };
}

/**
 * The current accepted version of a universe, or `null` when the book is being written right now (a
 * packet captured then would not be an accepted version).
 */
export async function currentVersion(universeId) {
  const busy = (await scanTurns(universeId)).find((turn) => turn.status === 'queued' || turn.status === 'running');
  if (busy) return null;
  const sources = await packetSources(universeId);
  const entries = [];
  for (const source of sources) {
    const bytes = await readFile(source.from).catch(() => null);
    if (!bytes) continue;
    entries.push({ path: source.path, sha256: sha256(bytes), bytes: bytes.length, role: source.role });
  }
  return acceptedVersion(entries);
}

