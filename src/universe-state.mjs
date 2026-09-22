// The accepted book of a universe as it was before a turn, and the ancestry of a chapter.
//
// `turns/NNNN.prev/` holds a *complete* copy of the accepted book — canon, threads, atlas, every
// accepted chapter and its offer, and the episode plans — together with a manifest that lists the
// inventory and its hashes. The snapshot is published by writing a fresh staging directory, verifying
// it, and renaming it into place, so a snapshot is never a half-copied directory: it is either
// complete or absent. Recovery can therefore tell a missing snapshot from an incomplete one, and a
// restore puts both the bytes and the membership of the accepted book back.
//
// `chapters/.ancestry/NNNN.json` records the turn whose snapshot holds the state that preceded
// chapter N. It is written when the chapter is first written and is deliberately NOT replaced by a
// rewrite, so successive rewrites of the same chapter generate from the same ancestry while their
// rollback reference is the current accepted book.
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileExists, universeDir } from './paths.mjs';
import { nowIso, pad, readJson, writeJson } from './io.mjs';
import { listUniverses } from './universe.mjs';
import { scanTurns, writeTurnRecord } from './universe-chapters.mjs';
import { acceptedVersion, sha256Hex } from './version.mjs';

const SNAPSHOT_SCHEMA = 'state-snapshot.v1';
const STATE_FILES = ['canon.md', 'threads.json', 'atlas.json'];
// What a rollback owns. `exports/` holds produced editions rather than narrative state, and `turns/`
// and the version archives belong to the server, so neither takes part in a restore.
const OWNED_STATE = 'state';
const OWNED_CHAPTER = 'chapter';
const OWNED_OFFER = 'offer';
const OWNED_PLAN = 'plan';
const VERSION_ROLE = {
  [OWNED_STATE]: (path) => path === 'canon.md' ? 'canon' : path === 'threads.json' ? 'threads' : 'atlas',
  [OWNED_CHAPTER]: () => 'chapter',
  [OWNED_OFFER]: () => 'offer',
  [OWNED_PLAN]: () => 'plan'
};

export const snapshotDir = (id, turnNumber) => join(universeDir(id), 'turns', `${pad(turnNumber)}.prev`);
const ancestryDir = (id) => join(universeDir(id), 'chapters', '.ancestry');
export const ancestryFile = (id, chapterNumber) => join(ancestryDir(id), `${pad(chapterNumber)}.json`);

/** The accepted narrative files of a universe, with the role each one plays in a rollback. */
async function inventoryFiles(id) {
  const dir = universeDir(id);
  const files = [];
  for (const name of STATE_FILES) {
    if (await fileExists(join(dir, name))) files.push({ path: name, kind: OWNED_STATE });
  }
  for (const name of await readdir(join(dir, 'chapters')).catch(() => [])) {
    if (/^\d{4}-.+\.md$/.test(name)) files.push({ path: `chapters/${name}`, kind: OWNED_CHAPTER });
    else if (/^\d{4}-offer\.json$/.test(name)) files.push({ path: `chapters/${name}`, kind: OWNED_OFFER });
  }
  for (const name of await readdir(join(dir, 'drafts')).catch(() => [])) {
    if (/^\d{4}-plan\.md$/.test(name)) files.push({ path: `drafts/${name}`, kind: OWNED_PLAN });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The manifest of a snapshot, or `null` when the directory has none. */
export async function readSnapshotManifest(id, turnNumber) {
  const manifest = await readJson(join(snapshotDir(id, turnNumber), 'manifest.json'), null);
  if (!manifest || manifest.schema_version !== SNAPSHOT_SCHEMA || !Array.isArray(manifest.files)) return null;
  return manifest;
}

/**
 * `complete` when a verified snapshot exists, `missing` when there is none, `corrupt` when the
 * directory or its manifest is present but the inventory cannot be trusted. A half-written snapshot
 * is therefore never mistaken for a usable one.
 */
export async function snapshotStatus(id, turnNumber) {
  const dir = snapshotDir(id, turnNumber);
  if (!(await fileExists(dir))) return 'missing';
  const manifest = await readSnapshotManifest(id, turnNumber);
  if (!manifest) return 'corrupt';
  if (manifest.complete !== true) return 'corrupt';
  for (const entry of manifest.files) {
    if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string' || !Number.isInteger(entry.bytes)) return 'corrupt';
    const info = await stat(join(dir, entry.path)).catch(() => null);
    if (!info || info.size !== entry.bytes) return 'corrupt';
    const bytes = await readFile(join(dir, entry.path)).catch(() => null);
    if (!bytes || sha256Hex(bytes) !== entry.sha256) return 'corrupt';
  }
  if (acceptedVersion(manifest.files) !== manifest.accepted_version) return 'corrupt';
  return 'complete';
}

/**
 * Copy the whole accepted book into `turns/NNNN.prev/` and publish it atomically. The staging
 * directory is always fresh, is verified entry by entry, and only then replaces the target, so a
 * crash leaves either the previous complete snapshot or nothing — never a mix.
 */
export async function prepareSnapshot(id, turnNumber, kind = 'chapter') {
  const turnsDir = join(universeDir(id), 'turns');
  const staging = join(turnsDir, `${pad(turnNumber)}.prev.staging-${randomBytes(4).toString('hex')}`);
  await mkdir(staging, { recursive: true });
  const entries = [];
  for (const file of await inventoryFiles(id)) {
    const bytes = await readFile(join(universeDir(id), file.path));
    const target = join(staging, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    entries.push({
      path: file.path,
      kind: file.kind,
      role: VERSION_ROLE[file.kind](file.path),
      sha256: sha256Hex(bytes),
      bytes: bytes.length
    });
  }
  const manifest = {
    schema_version: SNAPSHOT_SCHEMA,
    turn: turnNumber,
    kind,
    created_at: nowIso(),
    accepted_version: acceptedVersion(entries),
    complete: true,
    files: entries
  };
  // Verify the staged copy before it can become the recovery point.
  for (const entry of entries) {
    const bytes = await readFile(join(staging, entry.path));
    if (bytes.length !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
      await rm(staging, { recursive: true, force: true });
      throw new Error(`the staged snapshot of turn ${turnNumber} does not match its inventory`);
    }
  }
  await writeJson(join(staging, 'manifest.json'), manifest);
  const target = snapshotDir(id, turnNumber);
  const superseded = `${target}.superseded-${randomBytes(3).toString('hex')}`;
  const hadTarget = await fileExists(target);
  if (hadTarget) await rename(target, superseded);
  try {
    await rename(staging, target);
  } catch (error) {
    if (hadTarget) await rename(superseded, target).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  if (hadTarget) await rm(superseded, { recursive: true, force: true }).catch(() => {});
  return manifest;
}

/** Remove staging and superseded directories left behind by an interrupted preparation. */
export async function cleanSnapshotDebris(id, turnNumber) {
  const turnsDir = join(universeDir(id), 'turns');
  for (const name of await readdir(turnsDir).catch(() => [])) {
    if (!name.startsWith(`${pad(turnNumber)}.prev.`)) continue;
    if (!/\.(staging|superseded)-[0-9a-f]+$/.test(name)) continue;
    // A superseded directory is removed only when the published snapshot is usable.
    if (name.includes('.superseded-') && await snapshotStatus(id, turnNumber) !== 'complete') continue;
    await rm(join(turnsDir, name), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Restore the accepted book captured in `turns/NNNN.prev/`: the bytes of every entry in the manifest,
 * and the membership of the book, meaning that candidate-owned files which are not part of the
 * accepted snapshot (a chapter the agent invented, a renamed target, an extra plan) are removed.
 * Server-owned records, the version archives and produced editions are never touched.
 */
export async function restoreState(id, turnNumber) {
  const status = await snapshotStatus(id, turnNumber);
  if (status !== 'complete') return { ok: false, reason: status };
  const dir = snapshotDir(id, turnNumber);
  const manifest = await readSnapshotManifest(id, turnNumber);
  const accepted = new Set(manifest.files.map((entry) => entry.path));
  for (const entry of manifest.files) {
    const target = join(universeDir(id), entry.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(dir, entry.path), target);
  }
  for (const file of await inventoryFiles(id)) {
    if (accepted.has(file.path)) continue;
    await rm(join(universeDir(id), file.path), { force: true });
  }
  return { ok: true, version: manifest.accepted_version, removed: manifest.files.length };
}

/**
 * Restore only the canon/threads/atlas trio of a snapshot, leaving accepted chapters as they are.
 * A rewrite uses this to return to the state that preceded the chapter it is rewriting, so the agent
 * generates from the correct base without overwriting chapters that were revised later.
 */
export async function restoreCanon(id, turnNumber) {
  const status = await snapshotStatus(id, turnNumber);
  if (status !== 'complete') return { ok: false, reason: status };
  const dir = snapshotDir(id, turnNumber);
  for (const name of STATE_FILES) {
    const source = join(dir, name);
    if (await fileExists(source)) await copyFile(source, join(universeDir(id), name));
  }
  return { ok: true };
}

/* ------------------------------------------------------------- chapter ancestry */

/** The turn whose snapshot holds the state that preceded chapter N, or `null`. */
export async function readAncestry(id, chapterNumber) {
  const record = await readJson(ancestryFile(id, chapterNumber), null);
  if (!record || !Number.isInteger(record.source_turn)) return null;
  return record;
}

/** Record the ancestry of a chapter that is being written for the first time. */
export async function writeAncestry(id, chapterNumber, sourceTurn, version) {
  await mkdir(ancestryDir(id), { recursive: true });
  const record = {
    schema_version: 'chapter-ancestry.v1',
    chapter: chapterNumber,
    source_turn: sourceTurn,
    source_version: version ?? null,
    created_at: nowIso()
  };
  await writeJson(ancestryFile(id, chapterNumber), record);
  return record;
}

/** Forget the ancestry of a chapter whose text no longer exists (a dropped chapter). */
export async function dropAncestry(id, chapterNumber) {
  await rm(ancestryFile(id, chapterNumber), { force: true });
}

/* ------------------------------------------------------------------- recovery */

/**
 * Repair every universe after a restart. A turn recorded as `running` is `interrupted` with the
 * accepted book restored from its snapshot; when that snapshot is missing or unusable the turn is
 * `recovery_required` instead and the universe refuses new work until a human resolves it, because
 * the honest state of the book is then unknown.
 */
export async function recoverUniverse(id) {
  const turns = await scanTurns(id);
  const interrupted = [];
  const queued = [];
  const blocked = [];
  for (const turn of turns) {
    if (turn.status === 'queued') {
      queued.push(turn);
      continue;
    }
    if (turn.status === 'running') {
      const restored = await restoreState(id, turn.number);
      if (!restored.ok) {
        await writeTurnRecord(id, {
          ...turn,
          status: 'recovery_required',
          finishedAt: nowIso(),
          error: `the snapshot taken before this turn is ${restored.reason === 'missing' ? 'missing' : 'unusable'} (${restored.reason}); the accepted state of this book must be established by hand before it is written again`
        });
        blocked.push(turn.number);
        continue;
      }
      await writeTurnRecord(id, {
        ...turn,
        status: 'interrupted',
        finishedAt: nowIso(),
        error: 'interrupted by a server restart'
      });
      interrupted.push(turn.number);
    }
    await cleanSnapshotDebris(id, turn.number);
  }
  return { interrupted, queued, blocked };
}

export async function recoverAllUniverses() {
  const recovered = [];
  for (const universe of await listUniverses()) {
    const result = await recoverUniverse(universe.id);
    for (const turnNumber of result.interrupted) {
      recovered.push({ universeId: universe.id, turnNumber, action: 'interrupted' });
    }
    for (const turnNumber of result.blocked) {
      recovered.push({ universeId: universe.id, turnNumber, action: 'recovery_required' });
    }
    for (const turn of result.queued) {
      recovered.push({ universeId: universe.id, turnNumber: turn.number, action: 'queued', turn });
    }
  }
  return recovered;
}
