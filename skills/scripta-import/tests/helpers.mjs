// Fixtures for the import suites.
//
// A fixture is a real universe folder: `chapters/*.md`, `canon.md`, `threads.json`, `atlas.json`,
// `universe.json`, `drafts/import-progress.json` and the host's `.agents/import/extracted.json`.
// The builders write the chapter prose once and use it twice — as the extraction's text and as the
// imported chapter — so a fixture that passes the validator is a faithful import by construction,
// and a test that wants a defect changes exactly one thing.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const VALIDATOR = resolve(HERE, '..', 'scripts', 'validate-import.mjs');

export function tempDir(prefix = 'scripta-import-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(paths) {
  for (const path of paths) rmSync(path, { recursive: true, force: true });
}

export function writeFile(root, relative, data) {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  return full;
}

export function writeJson(root, relative, value) {
  return writeFile(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

export function pad4(value) {
  return String(value).padStart(4, '0');
}

/** The file-name slug of a title: lowercase, hyphen-separated, Romanian diacritics transliterated. */
export function slugify(title) {
  return String(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[șş]/g, 's')
    .replace(/[țţ]/g, 't')
    .replace(/[ăâ]/g, 'a')
    .replace(/î/g, 'i')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Deterministic prose of exactly `words` tokens, in paragraphs of forty words. Every token is
 * unique, so prose written by the generator can never look like prose taken from it, and the
 * overlap measure of a faithful copy is exactly one.
 */
export function prose(words, seed = 'w', { furnitureEvery = 0 } = {}) {
  const tokens = Array.from({ length: words }, (_, index) => `${seed}${index}`);
  const blocks = [];
  let paragraph = [];
  tokens.forEach((token, index) => {
    paragraph.push(token);
    if (paragraph.length === 40) {
      blocks.push(paragraph.join(' '));
      paragraph = [];
    }
    if (furnitureEvery > 0 && (index + 1) % furnitureEvery === 0) {
      blocks.push(`THE ASH ARCHIVE ${index + 1}`);
    }
  });
  if (paragraph.length > 0) blocks.push(paragraph.join(' '));
  return { text: blocks.join('\n\n'), cleaned: blocks.filter((block) => !block.startsWith('THE ASH ARCHIVE')).join('\n\n') };
}

/** Cut a chapter's text into `count` segments at paragraph boundaries. */
export function segment(text, count) {
  const paragraphs = text.split('\n\n').filter(Boolean);
  if (count <= 1) return [text];
  const groups = Array.from({ length: count }, () => []);
  paragraphs.forEach((paragraph, index) => {
    groups[Math.floor((index * count) / paragraphs.length)].push(paragraph);
  });
  return groups.map((group) => group.join('\n\n'));
}

function canonicalCanon(law) {
  return [
    '# Canon — Imported Book',
    '',
    '## Fundamental laws',
    `- ${law}`,
    '',
    '## World',
    '- The archive admits one reader at a time (ch. 1).',
    '',
    '## Recurring characters',
    '- **The keeper** — reads the shelves and wants to finish one catalogue (ch. 1).',
    '',
    '## Timeline',
    '- Year 12 — the first living author is registered (ch. 1).',
    '',
    '## Stable facts',
    '- The registry never deletes an entry (ch. 2).',
    '',
    '## Mysteries with a fixed cause',
    '',
  ].join('\n');
}

function canonicalThreads() {
  return {
    open: [{ id: 'thread-0001', kind: 'mystery', question: 'Who lit the lamps before the keeper arrived?', created_chapter: 1, due_chapter: 4, status: 'open' }],
    closed: [],
    promises: [{ id: 'prom-0001', to: 'The keeper', promise: 'The catalogue will be finished.', created_chapter: 1, due_chapter: 5, status: 'open' }],
    deferred_answers: [],
  };
}

function canonicalAtlas(chapters) {
  return {
    version: 1,
    axes: [
      {
        id: 'knowledge-truth',
        name: 'Knowledge & truth',
        nodes: [{ id: 'catalogue-of-the-dead', label: 'A catalogue of the dead', state: 'dramatized', chapters: [chapters[0]] }],
      },
    ],
  };
}

/**
 * Build one universe and its extraction.
 *
 *   chapters      `{ sourceChapterNumber: wordCount | { words, title, split, skip } }`
 *   furnitureEvery insert running heads into the extraction that the chapter file does not carry
 *   record        overrides merged into `drafts/import-progress.json`
 *   chaptersDir   omit a chapter file by number, or replace its text / name
 */
export function buildFixture(options = {}) {
  const root = options.root ?? tempDir();
  const universe = join(root, 'universe');
  mkdirSync(universe, { recursive: true });
  const law = options.law ?? 'Every book borrows the light of the one read before it.';
  const language = options.language ?? 'ro';
  const spec = options.chapters ?? { 1: { words: 120 }, 2: { words: 140 } };
  const importId = options.importId ?? '20260922T155732-ab12';
  const sourceChapters = [];
  const recordChapters = [];
  const skipped = [];
  const written = new Map();
  let chapterNumber = options.startChapter ?? 1;
  let wordsImported = 0;

  for (const [key, raw] of Object.entries(spec)) {
    const number = Number(key);
    const entry = typeof raw === 'number' ? { words: raw } : raw;
    const words = entry.words ?? 120;
    const title = entry.title ?? `Chapter ${number}`;
    const generated = words === 0 ? { text: '', cleaned: '' } : prose(words, `c${number}`, { furnitureEvery: options.furnitureEvery ?? 0 });
    sourceChapters.push({ number, title: words === 0 ? null : title, words, text: generated.text });
    if (entry.skip || words === 0) {
      skipped.push({ source_chapter: number, reason: 'the extraction declares no prose for it (a part title or a blank page)' });
      continue;
    }
    const parts = segment(generated.cleaned, entry.split ?? 1);
    parts.forEach((part, index) => {
      const fileTitle = parts.length > 1 ? `${title} (${index + 1})` : title;
      const slug = options.slugFromTitle ? slugify(title) : `chapter-${number}`;
      const file = `chapters/${pad4(chapterNumber)}-${slug}${parts.length > 1 ? `-${index + 1}` : ''}.md`;
      writeFile(universe, file, `# ${fileTitle}\n\n${part}\n`);
      recordChapters.push({
        chapter: chapterNumber,
        source_chapter: number,
        segment: parts.length > 1 ? index + 1 : null,
        file,
        title: fileTitle,
      });
      wordsImported += part.split(/\s+/).filter(Boolean).length + fileTitle.split(' ').length;
      written.set(chapterNumber, file);
      chapterNumber += 1;
    });
  }

  for (const [key, raw] of Object.entries(options.pending ?? {})) {
    const number = Number(key);
    const words = typeof raw === 'number' ? raw : (raw.words ?? 60);
    sourceChapters.push({ number, title: `Chapter ${number}`, words, text: prose(words, `c${number}`).text });
  }

  const extractionFile = writeJson(universe, '.agents/import/extracted.json', {
    schema_version: 'book-import.v1',
    import_id: importId,
    source: { filename: 'book.pdf', format: 'pdf', sha256: options.sha256 ?? 'a'.repeat(64), bytes: 123456, pages: 210 },
    detected: { title: 'The Ash Archive', author: 'A. Writer', language: options.detectedLanguage ?? language },
    chapters: sourceChapters.sort((left, right) => left.number - right.number),
    warnings: [],
  });

  const accounted = new Set([...recordChapters.map((entry) => entry.source_chapter), ...skipped.map((entry) => entry.source_chapter)]);
  const accountedNumbers = sourceChapters.filter((chapter) => accounted.has(chapter.number)).map((chapter) => chapter.number);
  const turns =
    options.turns ??
    [
      {
        number: 1,
        from_source_chapter: accountedNumbers[0],
        to_source_chapter: accountedNumbers[accountedNumbers.length - 1],
        chapters: recordChapters.map((entry) => entry.chapter),
        imported_at: '2026-09-22T16:30:00.000Z',
      },
    ];

  const record = {
    schema_version: 'book-import.v1',
    import_id: importId,
    source: { filename: 'book.pdf', format: 'pdf', sha256: options.sha256 ?? 'a'.repeat(64), bytes: 123456, pages: 210 },
    detected: { title: 'The Ash Archive', author: 'A. Writer', language: options.detectedLanguage ?? language },
    language: { book: options.detectedLanguage ?? language, state: options.detectedLanguage ?? language, universe: language, match: (options.detectedLanguage ?? language) === language },
    segmentation: options.segmentation ?? 'host',
    start_chapter: options.startChapter ?? 1,
    next_source_chapter: options.nextSourceChapter ?? null,
    complete: options.complete ?? true,
    chapters: recordChapters,
    skipped,
    turns,
    updated_at: '2026-09-22T16:30:00.000Z',
    ...(options.record ?? {}),
  };
  writeJson(universe, 'drafts/import-progress.json', record);

  writeFile(universe, 'canon.md', options.canon ?? canonicalCanon(law));
  writeJson(universe, 'threads.json', options.threads ?? canonicalThreads());
  writeJson(universe, 'atlas.json', options.atlas ?? canonicalAtlas(recordChapters.map((entry) => entry.chapter)));
  writeJson(universe, 'universe.json', {
    id: 'imported-book',
    title: 'The Ash Archive',
    language,
    law,
    ...(options.universe ?? {}),
  });

  return { root, universe, extractionFile, record, recordChapters, sourceChapters, wordsImported };
}

/** Run the validator and return the exit status, the parsed envelope and the raw streams. */
export function runCli(args) {
  const result = spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: 'utf8' });
  const lines = result.stdout.split('\n').filter((line) => line.trim().length > 0);
  let envelope = null;
  try {
    envelope = JSON.parse(lines[lines.length - 1]);
  } catch {
    envelope = null;
  }
  return { status: result.status, envelope, stdout: result.stdout, stderr: result.stderr, lines };
}
