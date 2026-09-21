// The canon state of a universe as it was before a chapter. `turns/NNNN.prev/` holds the copies;
// they are consumed only by an actual restore (a rewrite or the recovery after a crash).
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileExists, universeDir } from './paths.mjs';
import { nowIso, pad } from './io.mjs';
import { listUniverses } from './universe.mjs';
import { removeChapterFiles, scanChapterFiles, scanTurns, writeTurnRecord } from './universe-chapters.mjs';

const SNAPSHOT_FILES = ['canon.md', 'threads.json', 'atlas.json'];

export async function snapshotState(id, turnNumber) {
  const dir = join(universeDir(id), 'turns', `${pad(turnNumber)}.prev`);
  await mkdir(dir, { recursive: true });
  for (const name of SNAPSHOT_FILES) {
    const source = join(universeDir(id), name);
    if (await fileExists(source)) await copyFile(source, join(dir, name));
  }
}

export async function restoreState(id, turnNumber) {
  const dir = join(universeDir(id), 'turns', `${pad(turnNumber)}.prev`);
  if (!(await fileExists(dir))) return;
  for (const name of SNAPSHOT_FILES) {
    const source = join(dir, name);
    if (await fileExists(source)) await copyFile(source, join(universeDir(id), name));
  }
  await rm(dir, { recursive: true, force: true });
}

/**
 * The `turns/NNNN.prev/` snapshot is NOT deleted on success: it holds the canon state from before that
 * chapter and enables rewriting it (`POST /chapters/:n/rewrite`). It is consumed only when a restore
 * actually happens (rewrite or crash recovery).
 */
export async function commitState(id, turnNumber) {
  // Intentionally a no-op: the snapshot stays on disk so later chapters can be rewritten.
  void id;
  void turnNumber;
}

export async function recoverUniverse(id) {
  const turns = await scanTurns(id);
  const interrupted = [];
  const queued = [];
  for (const turn of turns) {
    if (turn.status === 'queued') {
      queued.push(turn);
      continue;
    }
    if (turn.status !== 'running') continue;
    if (turn.kind === 'chapter' && turn.chapterNumber) {
      const chapters = await scanChapterFiles(id);
      const exists = chapters.some((entry) => entry.number === turn.chapterNumber);
      if (exists) await removeChapterFiles(id, turn.chapterNumber);
    }
    await restoreState(id, turn.number);
    await writeTurnRecord(id, {
      ...turn,
      status: 'interrupted',
      finishedAt: nowIso(),
      error: 'interrupted by a server restart'
    });
    interrupted.push(turn.number);
  }
  return { interrupted, queued };
}

export async function recoverAllUniverses() {
  const recovered = [];
  for (const universe of await listUniverses()) {
    const result = await recoverUniverse(universe.id);
    for (const turnNumber of result.interrupted) {
      recovered.push({ universeId: universe.id, turnNumber, action: 'interrupted' });
    }
    for (const turn of result.queued) {
      recovered.push({ universeId: universe.id, turnNumber: turn.number, action: 'queued', turn });
    }
  }
  return recovered;
}
