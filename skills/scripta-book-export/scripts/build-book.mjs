#!/usr/bin/env node
/**
 * scripta-book-export — book renderer (DOCX + PDF) for scriptaWorlds universes.
 *
 * Contract: docs/contracts.md §2 (on-disk layout) and §3 (renderer CLI).
 *
 *   node skills/scripta-book-export/scripts/build-book.mjs \
 *     --universe <universe-folder> [--out <folder>] [--format both|docx|pdf] [--fonts <folder>]
 *     [--language <code>]
 *
 * This file is only the command line: argument parsing, the render pipeline and the single JSON
 * line on stdout. The engine lives in ./lib/:
 *   errors.mjs    exit codes, BookError/fail, file readers, slug/date/XML helpers, byte helpers
 *   truetype.mjs  TrueType parsing, cmap, glyph access, subsetting
 *   fonts.mjs     font discovery/ranking, BookFace, resolveFonts
 *   markdown.mjs  the accepted Markdown subset
 *   book.mjs      edition language, labels and the book model (universe + edition + chapters)
 *   layout.mjs    pagination shared by both outputs (pages, TOC, title/dedication page)
 *   pdf.mjs       own PDF writer (subsetted fonts, outline, info)
 *   docx.mjs      own ZIP + OOXML writer
 *
 * The edition language (§3) localizes the labels (table of contents, default preface/afterword,
 * "Capitolul N", the title page); the book text is not translated. Default: `language` from
 * `exports/edition.json`, then from `universe.json`, otherwise `ro`; unknown codes use the
 * English labels. No npm dependencies: only built-in `node:` modules.
 * Output: a SINGLE JSON line on stdout. Exit codes: 0 success, 2 usage error,
 * 1 processing error.
 */

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BookError, EXIT_PROCESSING, EXIT_USAGE, fail, formatStamp } from './lib/errors.mjs';
import { essentialCodes, resolveFonts } from './lib/fonts.mjs';
import { blockText } from './lib/markdown.mjs';
import { languageCode, loadBook } from './lib/book.mjs';
import { layoutBook } from './lib/layout.mjs';
import { renderPdf } from './lib/pdf.mjs';
import { renderDocx } from './lib/docx.mjs';

const USAGE =
  'Usage: node build-book.mjs --universe <universe-folder> [--out <folder>] ' +
  '[--format both|docx|pdf] [--fonts <folder>] [--language <code>]';

function parseArgs(argv) {
  const options = { universe: null, out: null, format: 'both', fonts: null, language: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const needsValue = (name) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`Option ${name} requires a value. ${USAGE}`, 'USAGE', EXIT_USAGE);
      i += 1;
      return value;
    };
    if (arg === '--universe') options.universe = needsValue(arg);
    else if (arg === '--out') options.out = needsValue(arg);
    else if (arg === '--fonts') options.fonts = needsValue(arg);
    else if (arg === '--language') {
      const value = needsValue(arg);
      // Unknown codes are not an error: the edition falls back to the English labels (§3).
      if (!languageCode(value)) {
        fail(`Unknown language: ${value}. Use a language code (for example ro, en). ${USAGE}`, 'USAGE', EXIT_USAGE);
      }
      options.language = value;
    } else if (arg === '--format') {
      const value = needsValue(arg).toLowerCase();
      if (!['both', 'docx', 'pdf'].includes(value)) {
        fail(`Unknown format: ${value}. Accepted values: both, docx, pdf. ${USAGE}`, 'USAGE', EXIT_USAGE);
      }
      options.format = value;
    } else {
      fail(`Unknown argument: ${arg}. ${USAGE}`, 'USAGE', EXIT_USAGE);
    }
  }
  if (!options.universe) fail(`Missing --universe. ${USAGE}`, 'USAGE', EXIT_USAGE);
  return options;
}

function collectBookCodes(book) {
  const codes = new Set(essentialCodes());
  const add = (text) => {
    for (const ch of String(text)) codes.add(ch.codePointAt(0));
  };
  add(book.title);
  add(book.subtitle);
  add(book.author);
  add(book.year);
  add(book.dedication);
  add(book.labels.toc);
  add(book.labels.preface);
  add(book.labels.afterword);
  add(book.labels.untitled);
  for (const section of book.sections) {
    add(section.title);
    add(section.label || '');
    for (const block of section.blocks) add(blockText(block));
  }
  return codes;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function main(argv) {
  const options = parseArgs(argv);
  const buildDate = new Date();
  const universeDir = resolve(options.universe);
  const book = loadBook(universeDir, { language: options.language });
  const fontSet = resolveFonts(options.fonts ? resolve(options.fonts) : null, collectBookCodes(book));
  const faces = fontSet.faces;
  const layout = layoutBook(book, faces);

  for (const style of ['regular', 'bold', 'italic', 'bolditalic']) {
    const face = faces[style];
    if (face.missingChars.size) {
      process.stderr.write(
        `warning: font ${face.psName} has no glyphs ${[...face.missingChars].join(' ')}; ` +
          'those characters are replaced with "?"\n',
      );
    }
  }

  const outDir = options.out ? resolve(options.out) : join(universeDir, 'exports');
  mkdirSync(outDir, { recursive: true });
  const stamp = formatStamp(buildDate);
  const outputs = [];
  if (options.format === 'pdf' || options.format === 'both') {
    const rendered = renderPdf(book, faces, layout, buildDate);
    const file = join(outDir, `${book.slug}-${stamp}.pdf`);
    writeFileSync(file, rendered.data);
    outputs.push({ format: 'pdf', path: file, bytes: rendered.data.length, pages: rendered.pages });
  }
  if (options.format === 'docx' || options.format === 'both') {
    const rendered = renderDocx(book, layout, buildDate);
    const file = join(outDir, `${book.slug}-${stamp}.docx`);
    writeFileSync(file, rendered.data);
    outputs.push({ format: 'docx', path: file, bytes: rendered.data.length, pages: null });
  }
  emit({
    ok: true,
    title: book.title,
    chapters: book.chapters.length,
    words: book.wordCount,
    outputs,
  });
}

function runCli() {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const known = error instanceof BookError;
    emit({
      ok: false,
      error: known ? error.message : `Internal error: ${error && error.message ? error.message : String(error)}`,
      code: known ? error.code : 'INTERNAL',
    });
    process.exitCode = known ? error.exitCode : EXIT_PROCESSING;
  }
}

/**
 * Runs the CLI only when this module is the entry point.
 * `.agents/skills/<skill>` is a symlink, and Node resolves `import.meta.url` to the real path,
 * while `process.argv[1]` keeps the symlink: a naive comparison would exit silently, with no
 * JSON line and no files, exactly on the path documented in the skill.
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) runCli();
