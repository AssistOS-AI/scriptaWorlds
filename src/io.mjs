// Low-level file and text helpers shared by the universe store (`./universe*.mjs`) and the turn
// pipeline (`./omp.mjs`, `./jobs.mjs`). No module-level state, no dependency on either side.
import { readFile, rename, writeFile } from 'node:fs/promises';

/** Reads a text file; a missing or unreadable file answers the fallback instead of throwing. */
export async function readText(path, fallback = null) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return fallback;
  }
}

/** Reads and parses a JSON file; a missing file or invalid JSON answers the fallback. */
export async function readJson(path, fallback = null) {
  const raw = await readText(path, null);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Writes JSON through a temporary file and a rename, so a reader never sees a half-written file. */
export async function writeJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/** Zero-pads a number to `width` digits (chapter and turn file names: `0007`). */
export function pad(number, width = 4) {
  return String(number).padStart(width, '0');
}

export function nowIso() {
  return new Date().toISOString();
}

/** Cuts a long text to `max` characters, marking the cut so the reader knows it is incomplete. */
export function truncate(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}\n… (trunchiat)`;
}
