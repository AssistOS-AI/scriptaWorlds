/**
 * Edition language and book model: reads `universe.json` + `exports/edition.json` +
 * `chapters/NNNN-slug.md`, resolves the edition language (§3) and assembles the title, the
 * labeled sections and the word count the renderers consume.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { EXIT_USAGE, countWords, fail, readJsonFile, readTextFile, slugify } from './errors.mjs';
import { blockText, parseMarkdown } from './markdown.mjs';

const EDITION_LABELS = {
  ro: {
    toc: 'Cuprins',
    preface: 'Cuvânt înainte',
    afterword: 'Postfață',
    untitled: 'Fără titlu',
    chapter: (number) => `Capitolul ${number}`,
  },
  // Any other code falls back to the English labels (docs/contracts.md §3).
  en: {
    toc: 'Table of contents',
    preface: 'Preface',
    afterword: 'Afterword',
    untitled: 'Untitled',
    chapter: (number) => `Chapter ${number}`,
  },
};

/** Language metadata in BCP-47 form; unknown codes are used as they are. */
const EDITION_LOCALES = { ro: 'ro-RO', en: 'en-US' };

/** Lowercase ISO 639-1/639-2 code, with an optional region; `''` if the value is not a language code. */
const LANGUAGE_CODE_RE = /^([a-z]{2,3})(?:[-_][a-z0-9]+)*$/;

export function languageCode(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim().toLowerCase();
  const match = LANGUAGE_CODE_RE.exec(raw);
  return match ? match[1] : '';
}

/** Language priority: `--language` > `edition.json` > `universe.json` > `ro`. */
function resolveLanguage(flag, edition, universe) {
  const candidates = [flag, edition && edition.language, universe && universe.language];
  for (const candidate of candidates) {
    const code = languageCode(candidate);
    if (code) return code;
  }
  return 'ro';
}

function labelsFor(language) {
  return EDITION_LABELS[language] || EDITION_LABELS.en;
}

function headingTitle(blocks, fallback) {
  for (const block of blocks) {
    if (block.type === 'h1' || block.type === 'h2') return blockText(block) || fallback;
  }
  return fallback;
}

function titleFromSlug(slug, fallback) {
  const words = slug.split('-').filter(Boolean);
  if (!words.length) return fallback;
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function matterSection(kind, markdown, defaultTitle) {
  const blocks = parseMarkdown(markdown);
  let title = defaultTitle;
  let body = blocks;
  const first = blocks[0];
  if (first && (first.type === 'h1' || first.type === 'h2')) {
    title = blockText(first) || defaultTitle;
    body = blocks.slice(1);
  }
  return { kind, label: null, title, blocks: body };
}

export function loadBook(universeDir, options = {}) {
  const universeFile = join(universeDir, 'universe.json');
  if (!existsSync(universeFile)) {
    fail(`Missing ${universeFile} (this does not look like a universe folder).`, 'MISSING_UNIVERSE', EXIT_USAGE);
  }
  const universe = readJsonFile(universeFile);
  const editionFile = join(universeDir, 'exports', 'edition.json');
  const edition = existsSync(editionFile) ? readJsonFile(editionFile) : {};
  const language = resolveLanguage(options.language, edition, universe);
  const labels = labelsFor(language);

  const chaptersDir = join(universeDir, 'chapters');
  let chapterFiles = [];
  if (existsSync(chaptersDir)) {
    chapterFiles = readdirSync(chaptersDir)
      .map((name) => /^(\d{4})-([a-z0-9-]+)\.md$/.exec(name))
      .filter(Boolean)
      .map((match) => ({ number: Number(match[1]), slug: match[2], file: join(chaptersDir, match[0]) }))
      .sort((a, b) => a.number - b.number);
  }
  if (!chapterFiles.length) {
    fail(`The universe in ${universeDir} has no chapters in chapters/NNNN-slug.md.`, 'NO_CHAPTERS');
  }

  const chapters = [];
  let words = 0;
  for (const entry of chapterFiles) {
    const markdown = readTextFile(entry.file);
    const blocks = parseMarkdown(markdown);
    const title = headingTitle(blocks, titleFromSlug(entry.slug, labels.untitled));
    // The chapter title (docs/contracts.md §2.3) becomes the section heading, not a body block.
    const body = blocks[0] && (blocks[0].type === 'h1' || blocks[0].type === 'h2') ? blocks.slice(1) : blocks;
    let chapterWords = 0;
    for (const block of blocks) chapterWords += countWords(blockText(block));
    words += chapterWords;
    chapters.push({ number: entry.number, slug: entry.slug, title, blocks: body, words: chapterWords });
  }

  const title = String(edition.title || universe.title || labels.untitled);
  const sections = [];
  if (edition.preface) sections.push(matterSection('preface', edition.preface, labels.preface));
  for (const chapter of chapters) {
    sections.push({
      kind: 'chapter',
      label: labels.chapter(chapter.number),
      title: chapter.title,
      blocks: chapter.blocks,
      number: chapter.number,
      slug: chapter.slug,
    });
  }
  if (edition.afterword) sections.push(matterSection('afterword', edition.afterword, labels.afterword));

  return {
    title,
    subtitle: edition.subtitle ? String(edition.subtitle) : '',
    author: edition.author ? String(edition.author) : '',
    year: edition.year ? String(edition.year) : String(new Date().getFullYear()),
    dedication: edition.dedication ? String(edition.dedication) : '',
    language,
    locale: EDITION_LOCALES[language] || language,
    labels,
    chapters,
    wordCount: words,
    sections,
    slug: slugify(title),
    universeId: universe.id ? String(universe.id) : basename(universeDir),
  };
}
