// Fixture builders shared by the store, turn and runtime groups of `scripts/check.mjs`. They build
// real temporary universes and read them back the way the server does, so a check asserts an observable
// outcome instead of an internal call.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUniverse } from '../src/universe.mjs';
import { createHash } from 'node:crypto';
import { universeDir } from '../src/paths.mjs';

export const LAW = 'Cities exist only as long as someone tells them; silence dissolves them into stone.';
export const CANON = (world) => `# Canon — ${world}\n\n## Fundamental laws\n- Cities exist only as long as someone tells them; silence dissolves them into stone.\n\n## World\n- ${world}\n\n## Recurring characters\n\n## Timeline\n\n## Stable facts\n\n## Mysteries with a fixed cause\n`;
export const CHAPTER = (name, key) => `# ${name}\n\n${`The ledger was read aloud so the district would keep standing. (${key})\n\n`.repeat(20)}`;
export const OFFER = (teaser) => JSON.stringify({
  teaser,
  options: [
    { label: 'Go on', prompt: 'Continue the story: follow the ledger into the next district.' },
    { label: 'Stay', prompt: 'Continue the story: stay and read the ledger again.' }
  ]
});
export const EMPTY_THREADS = JSON.stringify({ open: [], closed: [], promises: [], deferred_answers: [] });

export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/** The owned narrative files of a universe with their content hashes: the accepted inventory. */
export async function inventory(id) {
  const dir = universeDir(id);
  const files = new Map();
  for (const name of ['canon.md', 'threads.json', 'atlas.json']) {
    const raw = await readFile(join(dir, name)).catch(() => null);
    if (raw) files.set(name, sha256Hex(raw));
  }
  for (const folder of ['chapters', 'drafts']) {
    for (const name of await readdir(join(dir, folder)).catch(() => [])) {
      if (!/^\d{4}-(offer\.json|.+\.md)$/.test(name)) continue;
      const raw = await readFile(join(dir, folder, name)).catch(() => null);
      if (raw) files.set(`${folder}/${name}`, sha256Hex(raw));
    }
  }
  return files;
}

/** The difference between two inventories, in the order a reviewer wants to read it. */
export function inventoryDiff(before, after) {
  const changes = [];
  for (const [path, hash] of before) {
    if (!after.has(path)) changes.push(`removed ${path}`);
    else if (after.get(path) !== hash) changes.push(`changed ${path}`);
  }
  for (const path of after.keys()) if (!before.has(path)) changes.push(`added ${path}`);
  return changes;
}

/** A universe with one accepted chapter and one accepted offer, ready to be snapshotted. */
export async function bookWithChapter(checkSeed, label = 'store') {
  const universe = await createUniverse({ title: `${label} ${checkSeed}`, law: LAW, language: 'en' });
  const dir = universeDir(universe.id);
  await mkdir(join(dir, 'drafts'), { recursive: true });
  await writeFile(join(dir, 'canon.md'), CANON('pre-chapter state'), 'utf8');
  await writeFile(join(dir, 'threads.json'), EMPTY_THREADS, 'utf8');
  await writeFile(join(dir, 'atlas.json'), JSON.stringify({ version: 1, axes: [] }), 'utf8');
  await writeFile(join(dir, 'chapters', '0001-one.md'), CHAPTER('One', 'first'), 'utf8');
  await writeFile(join(dir, 'chapters', '0001-offer.json'), OFFER('The keeper read the ledger aloud and the district answered. Now the registry wants the price.'), 'utf8');
  return universe;
}

/** A universe with two accepted chapters and their offers. */
export async function bookWithTwoChapters(checkSeed, label) {
  const universe = await bookWithChapter(checkSeed, label);
  const dir = universeDir(universe.id);
  await writeFile(join(dir, 'chapters', '0002-two.md'), CHAPTER('Two', 'second'), 'utf8');
  await writeFile(join(dir, 'chapters', '0002-offer.json'), OFFER('Two chapters of ledger and a district that holds. What does the registry charge for silence?'), 'utf8');
  return universe;
}

/** Wait until a turn record reaches a status the caller accepts, or the deadline passes. */
export async function waitForTurn(id, number, predicate, timeoutMs = 20_000) {
  const path = join(universeDir(id), 'turns', `${String(number).padStart(4, '0')}.json`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await readFile(path, 'utf8').then((raw) => JSON.parse(raw), () => null);
    if (record && predicate(record)) return record;
    if (Date.now() > deadline) return record;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Write a durable turn record directly, for the states a check wants to set up. */
export async function turnRecord(id, number, record) {
  await writeFile(join(universeDir(id), 'turns', `${String(number).padStart(4, '0')}.json`), JSON.stringify({
    number,
    createdAt: new Date().toISOString(),
    ...record
  }), 'utf8');
}
