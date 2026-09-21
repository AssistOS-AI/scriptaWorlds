// The chapter, turn and export files of one universe: naming conventions, scanning, version history
// and removal. Every function here reads or writes inside `universes/<id>/`, never a turn record's
// bookkeeping (that belongs to `./universe.mjs`) and never a state snapshot (that belongs to
// `./universe-state.mjs`).
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { universeDir } from './paths.mjs';
import { pad, readJson, readText, writeJson } from './io.mjs';

const CHAPTER_RE = /^(\d{4})-([a-z0-9][a-z0-9-]*)\.md$/;
const OFFER_RE = /^(\d{4})-offer\.json$/;
const TURN_RE = /^(\d{4})\.json$/;
const EXPORT_RE = /\.(pdf|docx)$/i;

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function chapterTitle(markdown) {
  const line = (markdown ?? '').split('\n').find((entry) => /^#\s+\S/.test(entry.trim()));
  if (!line) return 'Untitled chapter';
  return line.replace(/^#\s+/, '').trim();
}

export function countWords(markdown) {
  return (markdown ?? '')
    .replace(/^#+\s*/gm, '')
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

export async function scanChapterFiles(id) {
  const dir = join(universeDir(id), 'chapters');
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const offers = new Map();
  for (const name of entries) {
    const match = OFFER_RE.exec(name);
    if (!match) continue;
    const offer = await readJson(join(dir, name), null);
    if (offer && typeof offer === 'object') offers.set(Number.parseInt(match[1], 10), normalizeOffer(offer));
  }
  const chapters = [];
  for (const name of entries) {
    const match = CHAPTER_RE.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    const [raw, info] = await Promise.all([readText(path, ''), stat(path)]);
    const number = Number.parseInt(match[1], 10);
    chapters.push({
      number,
      slug: match[2],
      title: chapterTitle(raw),
      createdAt: toIso(info.mtime),
      words: countWords(raw),
      bytes: info.size,
      file: `chapters/${name}`,
      offer: offers.get(number) ?? null
    });
  }
  return chapters.sort((a, b) => a.number - b.number);
}

/** ALA's narrative offer: a short text plus 2–3 concrete decisions for the next episode. */
export function normalizeOffer(raw) {
  const teaser = typeof raw?.teaser === 'string' ? raw.teaser.trim().slice(0, 1200) : '';
  const options = Array.isArray(raw?.options)
    ? raw.options
        .filter((option) => option && typeof option === 'object' && typeof option.prompt === 'string' && option.prompt.trim())
        .slice(0, 4)
        .map((option) => ({
          label: String(option.label ?? '').trim().slice(0, 80) || option.prompt.trim().slice(0, 40),
          prompt: String(option.prompt).trim().slice(0, 600)
        }))
    : [];
  if (!teaser && options.length === 0) return null;
  return { teaser, options };
}

export async function scanTurns(id) {
  const dir = join(universeDir(id), 'turns');
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const turns = [];
  for (const name of entries) {
    const match = TURN_RE.exec(name);
    if (!match) continue;
    const record = await readJson(join(dir, name), null);
    if (!record) continue;
    turns.push({ number: Number.parseInt(match[1], 10), ...record });
  }
  return turns.sort((a, b) => a.number - b.number);
}

/** The turn record without the answer and the agent log, as the interface lists it. */
export function turnSummary(turn) {
  return {
    number: turn.number,
    kind: turn.kind ?? 'chapter',
    status: turn.status ?? 'done',
    createdAt: turn.createdAt ?? null,
    durationMs: turn.durationMs ?? null,
    request: turn.request ?? '',
    chapterNumber: turn.chapterNumber ?? null,
    chapterTitle: turn.chapterTitle ?? null,
    error: turn.error ?? null,
    exports: turn.exports ?? []
  };
}

export async function nextTurnNumber(id) {
  const turns = await scanTurns(id);
  return (turns.at(-1)?.number ?? 0) + 1;
}

export async function writeTurnRecord(id, record) {
  await writeJson(join(universeDir(id), 'turns', `${pad(record.number)}.json`), record);
}

/** The chapter markdown file of one chapter number: `0007-<slug>.md`. */
export async function findChapterFile(universeId, chapterNumber) {
  const dir = join(universeDir(universeId), 'chapters');
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const prefix = `${pad(chapterNumber)}-`;
  const match = entries.find((name) => name.startsWith(prefix) && name.endsWith('.md'));
  if (!match) return null;
  const path = join(dir, match);
  const info = await stat(path);
  return { name: match, path, size: info.size };
}

export async function removeChapterFiles(id, number) {
  const dir = join(universeDir(id), 'chapters');
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (CHAPTER_RE.exec(name) && Number.parseInt(name.slice(0, 4), 10) === number) {
      await unlink(join(dir, name));
    }
    if (OFFER_RE.exec(name) && Number.parseInt(name.slice(0, 4), 10) === number) {
      await unlink(join(dir, name));
    }
  }
}

/** Copy the current text of a chapter to chapters/.history/NNNN-vK.md (version archive). */
export async function archiveChapter(id, number) {
  const dir = join(universeDir(id), 'chapters');
  const historyDir = join(dir, '.history');
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const chapterFile = entries.find((name) => CHAPTER_RE.exec(name) && Number.parseInt(name.slice(0, 4), 10) === number);
  if (!chapterFile) return null;
  const text = await readText(join(dir, chapterFile), '');
  await mkdir(historyDir, { recursive: true });
  const existing = await readdir(historyDir).catch(() => []);
  const version = existing.filter((name) => name.startsWith(`${pad(number)}-v`)).length + 1;
  const target = join(historyDir, `${pad(number)}-v${version}.md`);
  await writeFile(target, text, 'utf8');
  return { file: `chapters/.history/${pad(number)}-v${version}.md`, text, version };
}

/** Remove chapters from `fromNumber` upwards (used when rewriting an older chapter). */
export async function dropChaptersFrom(id, fromNumber) {
  const chapters = await scanChapterFiles(id);
  const dropped = chapters.filter((chapter) => chapter.number >= fromNumber).map((chapter) => chapter.number);
  for (const number of dropped) await removeChapterFiles(id, number);
  return dropped;
}

export async function listChapterHistory(id, number) {
  const historyDir = join(universeDir(id), 'chapters', '.history');
  let entries = [];
  try {
    entries = await readdir(historyDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(`${pad(number)}-v`) && name.endsWith('.md'))
    .sort()
    .map((name) => ({ file: `chapters/.history/${name}`, version: Number.parseInt(name.replace(/^.*-v(\d+)\.md$/, '$1'), 10) }));
}

export async function listExports(id) {
  const dir = join(universeDir(id), 'exports');
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    if (!EXPORT_RE.test(name)) continue;
    const info = await stat(join(dir, name));
    files.push({
      name,
      format: name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx',
      bytes: info.size,
      createdAt: toIso(info.mtime),
      url: `/api/files/${id}/${encodeURIComponent(name)}`
    });
  }
  return files.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** The editions written since `sinceMs`, as the turn result reports them. */
export async function recentExportFiles(universeId, sinceMs) {
  const dir = join(universeDir(universeId), 'exports');
  let entries = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of entries) {
    if (!EXPORT_RE.test(name)) continue;
    const info = await stat(join(dir, name));
    if (info.mtimeMs + 1_000 < sinceMs) continue;
    files.push({
      format: name.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx',
      name,
      bytes: info.size
    });
  }
  return files;
}
