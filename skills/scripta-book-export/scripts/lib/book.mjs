/**
 * Edition language and book model: reads `universe.json` + `exports/edition.json` +
 * `chapters/NNNN-slug.md`, resolves the edition language (§3) and assembles the title, the
 * labeled sections, the word count the renderers consume, and the chapter inventory (relative
 * path, sha256, bytes).
 *
 * It also computes the accepted version of `docs/contracts.md` §8.2 — `contentIdentity` over the
 * role files `versionEntries` finds — which is what an edition is bound to: the renderer records it
 * as the `source_version` of `exports/edition-manifest.json` and the verifier recomputes it from
 * the universe on disk, so an edition rendered from content that has since changed is visibly
 * historical instead of pretending to contain the current book.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

import { EXIT_USAGE, countWords, fail, readBytesFile, readJsonFile, slugify } from './errors.mjs';
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

/**
 * The content identity of `docs/contracts.md` §8.2 over `entries`: `sha256:` + the hex digest of
 * `` `${path}\t${sha256}\t${bytes}\n` `` for every entry, sorted by path in byte order.
 */
export function contentIdentity(entries) {
  const byPath = (a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));
  const lines = [...entries]
    .sort(byPath)
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`)
    .join('');
  return `sha256:${createHash('sha256').update(lines, 'utf8').digest('hex')}`;
}

/** The roles that make up the narrative content of an accepted version (§8.2). */
export const VERSION_ROLES = Object.freeze(['chapter', 'offer', 'canon', 'threads', 'atlas']);

/**
 * The role files of a universe, relative to its folder, with the hash and the size each one has
 * now: the chapters, their offers and the three state documents. `universe.json` (role `meta`) and
 * the assessment inputs are deliberately absent, because §8.2 excludes them from the identity.
 * @returns {Array<{path: string, role: string, sha256: string, bytes: number}>}
 */
export function versionEntries(universeDir) {
  const entries = [];
  const add = (relative, role) => {
    const file = join(universeDir, relative);
    if (!existsSync(file)) return;
    const data = readBytesFile(file);
    entries.push({ path: relative, role, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length });
  };
  const chaptersDir = join(universeDir, 'chapters');
  if (existsSync(chaptersDir)) {
    const names = readdirSync(chaptersDir);
    for (const name of names.filter((entry) => /^\d{4}-[a-z0-9-]+\.md$/.test(entry)).sort()) {
      add(`chapters/${name}`, 'chapter');
    }
    for (const name of names.filter((entry) => /^\d{4}-offer\.json$/.test(entry)).sort()) {
      add(`chapters/${name}`, 'offer');
    }
  }
  add('canon.md', 'canon');
  add('threads.json', 'threads');
  add('atlas.json', 'atlas');
  return entries;
}

/** The accepted version of the universe as it is on disk now (§8.2). */
export function acceptedVersion(universeDir) {
  return contentIdentity(versionEntries(universeDir));
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
    const data = readBytesFile(entry.file);
    const markdown = data.toString('utf8');
    const blocks = parseMarkdown(markdown);
    const title = headingTitle(blocks, titleFromSlug(entry.slug, labels.untitled));
    // The chapter title (docs/contracts.md §2.3) becomes the section heading, not a body block.
    const body = blocks[0] && (blocks[0].type === 'h1' || blocks[0].type === 'h2') ? blocks.slice(1) : blocks;
    let chapterWords = 0;
    for (const block of blocks) chapterWords += countWords(blockText(block));
    words += chapterWords;
    chapters.push({
      number: entry.number,
      slug: entry.slug,
      path: `chapters/${basename(entry.file)}`,
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
      title,
      blocks: body,
      words: chapterWords,
    });
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
