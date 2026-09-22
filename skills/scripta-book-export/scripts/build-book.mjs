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
 *   fonts.mjs     font discovery/ranking, BookFace, resolveFonts (per-face glyph coverage)
 *   markdown.mjs  the accepted Markdown subset
 *   book.mjs      edition language, labels and the book model (universe + edition + chapters
 *                 with their sha256 hashes and the §8.2 chapter identity)
 *   layout.mjs    pagination shared by both outputs (pages, TOC, title/dedication page)
 *   pdf.mjs       own PDF writer (subsetted fonts, outline, info)
 *   docx.mjs      own ZIP + OOXML writer
 *   verify.mjs    structural verification of the produced files (objects/xref/trailer, ZIP/OOXML)
 *   manifest.mjs  the `edition-manifest.v1` record that binds the edition to its source version
 *
 * The edition language (§3) localizes the labels (table of contents, default preface/afterword,
 * "Capitolul N", the title page); the book text is not translated. Default: `language` from
 * `exports/edition.json`, then from `universe.json`, otherwise `ro`; unknown codes use the
 * English labels. No npm dependencies: only built-in `node:` modules.
 * Output: a SINGLE JSON line on stdout. Exit codes: 0 success, 2 usage error,
 * 1 processing error. Every produced file is verified before success is reported, and
 * `exports/edition-manifest.json` (schema `edition-manifest.v1`) is written once all of them are
 * readable: it records the requested format, each document with its path, size, hash and page count,
 * and `source_version` — the accepted version of `docs/contracts.md` §8.2 that was rendered — so the
 * verifier (`scripts/verify-edition.mjs`) can check the edition against the content it came from and
 * report an older edition as historical instead of current.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BookError, EXIT_PROCESSING, EXIT_USAGE, fail, formatStamp } from './lib/errors.mjs';
import { resolveFonts } from './lib/fonts.mjs';
import { contentIdentity, languageCode, loadBook, versionEntries } from './lib/book.mjs';
import { layoutBook, usedFaces } from './lib/layout.mjs';
import { renderPdf } from './lib/pdf.mjs';
import { renderDocx } from './lib/docx.mjs';
import { REQUEST_FORMATS, buildManifest, editionManifestFile, writeManifest } from './lib/manifest.mjs';
import { verifyFile } from './lib/verify.mjs';

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
      if (!REQUEST_FORMATS.includes(value)) {
        fail(`Unknown format: ${value}. Accepted values: ${REQUEST_FORMATS.join(', ')}. ${USAGE}`, 'USAGE', EXIT_USAGE);
      }
      options.format = value;
    } else {
      fail(`Unknown argument: ${arg}. ${USAGE}`, 'USAGE', EXIT_USAGE);
    }
  }
  if (!options.universe) fail(`Missing --universe. ${USAGE}`, 'USAGE', EXIT_USAGE);
  return options;
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Writes a produced edition and verifies it on disk, so success is only reported for a file that
 * can be read back. A file that fails verification is removed: a broken edition is never left
 * behind pretending to be a result.
 */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeVerified(file, data, format) {
  writeFileSync(file, data);
  try {
    return verifyFile(file, format);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
}

/**
 * The accepted version the edition is bound to: the §8.2 identity of the role files on disk, with
 * every chapter the book model read compared against the file it came from, so a chapter rewritten
 * while the renderer runs is refused instead of being recorded as if it had been rendered.
 */
function acceptedSourceVersion(universeDir, book) {
  const entries = versionEntries(universeDir);
  const recorded = new Map(entries.map((entry) => [entry.path, entry]));
  for (const chapter of book.chapters) {
    const entry = recorded.get(chapter.path);
    if (!entry || entry.sha256 !== chapter.sha256 || entry.bytes !== chapter.bytes) {
      fail(
        `${chapter.path} changed while the edition was being rendered: the file on disk is not the chapter that ` +
          'was read into the edition. Nothing was written; run the export again.',
        'EDITION_CHANGED',
      );
    }
  }
  return contentIdentity(entries);
}

function main(argv) {
  const options = parseArgs(argv);
  const buildDate = new Date();
  const universeDir = resolve(options.universe);
  const book = loadBook(universeDir, { language: options.language });
  const sourceVersion = acceptedSourceVersion(universeDir, book);
  // A family is accepted only when every face the layout renders with covers the characters it is
  // asked to render: the probe lays the book out with the candidate faces and returns the faces it
  // used, each carrying its own characters. An incomplete family is refused with MISSING_FONT.
  const fontSet = resolveFonts(options.fonts ? resolve(options.fonts) : null, (faces) =>
    usedFaces(layoutBook(book, faces)),
  );
  const faces = fontSet.faces;
  const layout = layoutBook(book, faces);

  const outDir = options.out ? resolve(options.out) : join(universeDir, 'exports');
  mkdirSync(outDir, { recursive: true });
  const stamp = formatStamp(buildDate);
  const outputs = [];
  if (options.format === 'pdf' || options.format === 'both') {
    const rendered = renderPdf(book, faces, layout, buildDate);
    const file = join(outDir, `${book.slug}-${stamp}.pdf`);
    const verified = writeVerified(file, rendered.data, 'pdf');
    if (verified.pages !== rendered.pages) {
      rmSync(file, { force: true });
      fail(
        `The produced PDF was laid out as ${rendered.pages} pages but its page objects describe ${verified.pages}.`,
        'BAD_PDF',
      );
    }
    // The reported page count is the one read back from the page objects, not the intended one.
    outputs.push({ format: 'pdf', path: file, bytes: rendered.data.length, pages: verified.pages, sha256: sha256Hex(rendered.data) });
  }
  if (options.format === 'docx' || options.format === 'both') {
    const rendered = renderDocx(book, layout, buildDate);
    const file = join(outDir, `${book.slug}-${stamp}.docx`);
    writeVerified(file, rendered.data, 'docx');
    outputs.push({ format: 'docx', path: file, bytes: rendered.data.length, pages: null, sha256: sha256Hex(rendered.data) });
  }
  // The record is written only now, when every produced file has been read back and the edition is
  // complete: a failed run leaves no manifest claiming documents it does not have.
  const manifest = buildManifest({
    universeId: book.universeId,
    generatedAt: buildDate.toISOString(),
    format: options.format,
    language: book.language,
    sourceVersion,
    documents: outputs.map((output) => ({
      format: output.format,
      path: relative(outDir, output.path),
      bytes: output.bytes,
      sha256: output.sha256,
      pages: output.pages,
    })),
  });
  writeManifest(outDir, manifest);

  emit({
    ok: true,
    title: book.title,
    chapters: book.chapters.length,
    words: book.wordCount,
    source_version: sourceVersion,
    manifest: basename(editionManifestFile(outDir)),
    chapterInventory: book.chapters.map((chapter) => ({
      number: chapter.number,
      path: chapter.path,
      sha256: chapter.sha256,
      bytes: chapter.bytes,
    })),
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
