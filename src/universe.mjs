// The universe store: creating a universe and changing it, and the views the interface reads
// (`listUniverses`, `readUniverseDetail`, `readChapter`, `readIdeas`). The chapter, turn and export
// files belong to `./universe-chapters.mjs`, the canon snapshots to `./universe-state.mjs`.
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, DEFAULT_LANGUAGE, isSupportedLanguage, languageLabel } from './config.mjs';
import { fileExists, isUniverseId, slugify, syncUniverseSkills, universeDir, universesDir } from './paths.mjs';
import { UniverseError, notFound } from './errors.mjs';
import { composeLaw, resolveElements } from './periodic.mjs';
import { pad, readJson, readText, writeJson } from './io.mjs';
import { acceptedChapters, listChapterHistory, listExports, scanChapterFiles, scanTurns, turnSummary } from './universe-chapters.mjs';
import { canonTemplate, charterTemplate, fictionPrompt, universeAgentsDoc } from './universe-prompts.mjs';

function assertUniverseId(id) {
  if (!isUniverseId(id)) throw new UniverseError('BAD_ID', 'Invalid universe identifier.', 400);
}

export function publicMeta(meta, chapters) {
  const last = chapters.at(-1) ?? null;
  return {
    id: meta.id,
    title: meta.title,
    summary: meta.summary ?? '',
    autoTitle: meta.autoTitle === true,
    law: meta.law ?? '',
    premise: meta.premise ?? '',
    elements: Array.isArray(meta.elements) ? meta.elements : [],
    status: meta.status === 'closed' ? 'closed' : 'open',
    language: meta.language ?? 'ro',
    model: meta.model ?? config.model,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    chapterCount: chapters.length,
    lastChapterTitle: last ? last.title : null
  };
}

export async function listUniverses() {
  let entries = [];
  try {
    entries = await readdir(universesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const universes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isUniverseId(entry.name)) continue;
    const meta = await readJson(join(universesDir, entry.name, 'universe.json'), null);
    if (!meta) continue;
    const chapters = await acceptedChapters(entry.name);
    universes.push(publicMeta(meta, chapters));
  }
  return universes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function readUniverseMeta(id) {
  assertUniverseId(id);
  const meta = await readJson(join(universeDir(id), 'universe.json'), null);
  if (!meta) throw notFound();
  return meta;
}

export async function readUniverseDetail(id) {
  const meta = await readUniverseMeta(id);
  const chapters = await acceptedChapters(id);
  const turns = await scanTurns(id);
  const chapterTurn = new Map();
  for (const turn of turns) {
    if (turn.kind === 'chapter' && turn.chapterNumber) chapterTurn.set(turn.chapterNumber, turn.number);
    // the last turn wins: a rewrite produces a new turn for the same chapter
  }
  for (const chapter of chapters) {
    chapter.turnNumber = chapterTurn.get(chapter.number) ?? null;
    delete chapter.file;
  }
  const threads = await readJson(join(universeDir(id), 'threads.json'), { open: [], closed: [], promises: [] });
  const canon = await readText(join(universeDir(id), 'canon.md'), '');
  return {
    universe: publicMeta(meta, chapters),
    chapters,
    turns: turns.map(turnSummary),
    threads,
    canon: { summary: (canon ?? '').trim().slice(0, 1500) },
    exports: await listExports(id)
  };
}

export async function readChapter(id, number) {
  await readUniverseMeta(id);
  const chapters = await acceptedChapters(id);
  const chapter = chapters.find((entry) => entry.number === number);
  if (!chapter) throw notFound(`Chapter ${number} does not exist.`);
  const markdown = await readText(join(universeDir(id), chapter.file), '');
  const turns = await scanTurns(id);
  const turn = turns.filter((entry) => entry.kind === 'chapter' && entry.chapterNumber === number).at(-1);
  return {
    number: chapter.number,
    slug: chapter.slug,
    title: chapter.title,
    createdAt: chapter.createdAt,
    words: chapter.words,
    bytes: chapter.bytes,
    turnNumber: turn ? turn.number : null,
    rewritten: Boolean(turn?.rewrite),
    versions: (await listChapterHistory(id, number)).length,
    offer: chapter.offer ?? null,
    markdown
  };
}

/**
 * Concrete continuation ideas derived from open threads and from the last chapter.
 * Costs no agent run: the interface uses them for the closing panel and as default suggestions.
 */
export async function readIdeas(id) {
  const meta = await readUniverseMeta(id);
  const threads = await readJson(join(universeDir(id), 'threads.json'), {}) ?? {};
  const chapters = await acceptedChapters(id);
  const shorten = (text, max = 64) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  };
  const ideas = [];

  const openItems = [...(threads.open ?? []), ...(threads.promises ?? [])]
    .filter((item) => item && (item.question || item.promise))
    .sort((a, b) => (Number(a.due_chapter) || 99) - (Number(b.due_chapter) || 99));
  for (const item of openItems.slice(0, 2)) {
    const text = item.question ?? item.promise;
    ideas.push({
      label: shorten(text),
      prompt: fictionPrompt(meta.language, 'continue', text),
      source: item.kind === 'promise' ? 'promise' : 'thread'
    });
  }

  for (const item of (threads.deferred_answers ?? []).slice(0, 1)) {
    if (!item?.question) continue;
    ideas.push({
      label: shorten(item.question),
      prompt: fictionPrompt(meta.language, 'answer', item.question),
      source: 'deferred'
    });
  }

  const last = chapters.at(-1);
  if (last?.offer?.options?.length) {
    const option = last.offer.options[0];
    if (!ideas.some((idea) => idea.prompt === option.prompt)) {
      ideas.push({ label: shorten(option.label, 48), prompt: option.prompt, source: 'latest' });
    }
  } else if (last) {
    ideas.push({
      label: shorten(`After "${last.title}"`, 48),
      prompt: `Continue after "${last.title}".`,
      source: 'latest'
    });
  }

  ideas.push({ label: 'Let ten years pass', prompt: fictionPrompt(meta.language, 'jump', ''), source: 'timejump' });

  const seen = new Set();
  return ideas.filter((idea) => {
    const key = idea.prompt.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

/** One turn record as its route reads it: the full record, or `NOT_FOUND` when it does not exist. */
export async function readTurn(id, number) {
  await readUniverseMeta(id);
  const record = await readJson(join(universeDir(id), 'turns', `${pad(number)}.json`), null);
  if (!record) throw notFound(`Turn ${number} does not exist.`);
  return { number, ...record };
}

export async function createUniverse({
  title = '',
  law = '',
  premise = '',
  language = DEFAULT_LANGUAGE,
  provisionalTitle = '',
  summary = '',
  elements = []
} = {}) {
  const cleanTitle = String(title ?? '').trim() || String(provisionalTitle ?? '').trim();
  if (cleanTitle.length > 300) throw new UniverseError('BAD_TITLE', 'The title can have at most 300 characters.', 400);
  const autoTitle = !String(title ?? '').trim();
  // A universe is a compound: the reader picks ingredients from the periodic table and the law is
  // composed from them. A law written by hand is kept and the ingredients are appended to it.
  const cleanElements = await resolveElements(elements);
  const cleanLaw = composeLaw(cleanElements, law).slice(0, 4000);
  if (cleanLaw.length < 24) {
    throw new UniverseError(
      'BAD_LAW',
      'Choose at least one ingredient from the table of ideas, or write the law of the universe.',
      400
    );
  }
  const cleanPremise = String(premise ?? '').trim().slice(0, 2000);
  const cleanLanguage = String(language ?? DEFAULT_LANGUAGE).trim().toLowerCase();
  if (!isSupportedLanguage(cleanLanguage)) {
    throw new UniverseError('BAD_LANGUAGE', `Language "${language}" is not supported.`, 400);
  }

  const base = slugify(cleanTitle || 'universe');
  let id = base;
  for (let attempt = 2; await fileExists(universeDir(id)); attempt += 1) {
    id = `${base}-${attempt}`;
    if (attempt > 50) throw new UniverseError('ID_TAKEN', 'Could not allocate a free identifier.', 409);
  }

  const now = new Date().toISOString();
  const meta = {
    id,
    title: cleanTitle || 'A universe with no name yet',
    summary: String(summary ?? '').trim().slice(0, 600),
    autoTitle,
    law: cleanLaw,
    premise: cleanPremise,
    elements: cleanElements,
    status: 'open',
    language: cleanLanguage,
    model: config.model,
    createdAt: now,
    updatedAt: now,
    chapterCount: 0,
    lastChapter: null
  };

  const dir = universeDir(id);
  await mkdir(join(dir, 'chapters'), { recursive: true });
  await mkdir(join(dir, 'turns'), { recursive: true });
  await mkdir(join(dir, 'exports'), { recursive: true });
  await writeJson(join(dir, 'universe.json'), meta);
  await writeFile(join(dir, 'charter.md'), charterTemplate(cleanTitle, cleanLanguage, cleanLaw), 'utf8');
  await writeFile(join(dir, 'canon.md'), canonTemplate(cleanTitle, cleanLaw, cleanPremise, cleanElements), 'utf8');
  await writeJson(join(dir, 'threads.json'), { open: [], closed: [], promises: [], deferred_answers: [] });
  await writeJson(join(dir, 'atlas.json'), { version: 1, axes: [] });
  await writeFile(join(dir, 'AGENTS.md'), universeAgentsDoc(cleanTitle, cleanLanguage, cleanLaw, cleanElements), 'utf8');
  await syncUniverseSkills(dir);
  return publicMeta(meta, []);
}

export async function setUniverseLaw(id, law) {
  const clean = String(law ?? '').trim().slice(0, 4000);
  if (clean.length < 24) {
    throw new UniverseError('BAD_LAW', 'The fundamental law is too short to define a universe.', 400);
  }
  const meta = await readUniverseMeta(id);
  meta.law = clean;
  meta.updatedAt = new Date().toISOString();
  await writeJson(join(universeDir(id), 'universe.json'), meta);
  const chapters = await acceptedChapters(id);
  return publicMeta(meta, chapters);
}

/**
 * Takes the name the agent wrote in `universe-title.txt` (the first chapter names the universe)
 * and stores it as the universe title. Only applied while the title is still provisional.
 */
export async function applyAgentTitle(id) {
  const raw = await readText(join(universeDir(id), 'universe-title.txt'), null);
  const meta = await readUniverseMeta(id);
  if (raw === null) return null;
  const name = (raw.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '')
    .replace(/^#\s*/, '')
    .replace(/^["'“”„]|["'“”„]$/g, '')
    .trim();
  // The name the reader sees in the header must be a short title (4-5 words), never a sentence:
  // the descriptive text of the template lives in `summary`.
  const words = name.split(/\s+/).filter(Boolean);
  if (!name || name.length > 60 || words.length < 2 || words.length > 7) return null;
  const previous = String(meta.title ?? '').trim();
  const previousLooksLikeASentence = previous.split(/\s+/).filter(Boolean).length > 7;
  if (!meta.autoTitle && !previousLooksLikeASentence && previous === name) return null;
  // A long descriptive line kept as the displayed title is moved to `summary`, where the interface
  // shows it as a hint; the header always carries the short name.
  if (!meta.summary && previousLooksLikeASentence) meta.summary = previous.slice(0, 600);
  meta.title = name;
  meta.autoTitle = false;
  meta.updatedAt = new Date().toISOString();
  await writeJson(join(universeDir(id), 'universe.json'), meta);
  // `universe-title.txt` is a hand-off file: it exists only while the book has no name, so the folder
  // never keeps a stale line that contradicts the adopted title.
  await unlink(join(universeDir(id), 'universe-title.txt')).catch(() => {});
  return name;
}

/**
 * Change the language of a book. Before the book has chapters the change is applied everywhere the
 * server owns the text: `universe.json`, the universe's own `AGENTS.md` and the generated language
 * line of `charter.md`, and only that line, so a human edit of the charter is never overwritten.
 * Once the book has chapters its language is fixed, because its prose is written in that language and
 * a change would leave the chapters and the permanent guidance contradicting each other.
 */
export async function setUniverseLanguage(id, language) {
  const clean = String(language ?? '').trim().toLowerCase();
  if (!isSupportedLanguage(clean)) {
    throw new UniverseError('BAD_LANGUAGE', `Language "${language}" is not supported.`, 400);
  }
  const meta = await readUniverseMeta(id);
  const previous = meta.language ?? DEFAULT_LANGUAGE;
  const chapters = await scanChapterFiles(id);
  if (previous === clean) return publicMeta(meta, chapters);
  if (chapters.length > 0) {
    throw new UniverseError(
      'LANGUAGE_LOCKED',
      `This book already has ${chapters.length} chapter(s) written in ${languageLabel(previous)}; its language is fixed. Start a new universe to write in another language.`,
      409
    );
  }
  meta.language = clean;
  meta.updatedAt = new Date().toISOString();
  await writeJson(join(universeDir(id), 'universe.json'), meta);
  await refreshLanguageGuidance(id, meta);
  return publicMeta(meta, []);
}

/** Refresh the language of the guidance the server generated, without touching human text. */
async function refreshLanguageGuidance(id, meta) {
  const dir = universeDir(id);
  // `AGENTS.md` is generated by the server at creation and is rewritten for the new language.
  await writeFile(
    join(dir, 'AGENTS.md'),
    universeAgentsDoc(meta.title, meta.language, meta.law, Array.isArray(meta.elements) ? meta.elements : []),
    'utf8'
  );
  // `charter.md` belongs to a human: only its generated language line is refreshed, and only when
  // that line is still present. A removed or rewritten line is left exactly as the human wrote it.
  const charterPath = join(dir, 'charter.md');
  const charter = await readText(charterPath, null);
  if (charter === null) return;
  const refreshed = charter.replace(
    /Fiction language: \*\*[^*]*\*\*/,
    `Fiction language: **${languageLabel(meta.language)} (${meta.language})**`
  );
  if (refreshed !== charter) await writeFile(charterPath, refreshed, 'utf8');
}

export async function setUniverseStatus(id, status) {
  const meta = await readUniverseMeta(id);
  if (!['open', 'closed'].includes(status)) {
    throw new UniverseError('BAD_STATUS', 'Invalid status (open|closed).', 400);
  }
  meta.status = status;
  meta.updatedAt = new Date().toISOString();
  await writeJson(join(universeDir(id), 'universe.json'), meta);
  const chapters = await acceptedChapters(id);
  return publicMeta(meta, chapters);
}

export async function touchUniverse(id) {
  const meta = await readUniverseMeta(id);
  meta.updatedAt = new Date().toISOString();
  await writeJson(join(universeDir(id), 'universe.json'), meta);
}
