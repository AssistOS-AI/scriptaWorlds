#!/usr/bin/env node
/**
 * scripta-book-export — edition verifier: the acceptance step the server runs after an edition has
 * been rendered, instead of trusting a file name or a five-byte header.
 *
 *   node skills/scripta-book-export/scripts/verify-edition.mjs \
 *     --universe <universe-folder> [--format both|docx|pdf] [--since <epoch-ms>]
 *     [--fonts <folder>] [--language <code>]
 *
 * It reads the universe and its `exports/` folder and writes nothing anywhere. For every requested
 * format it requires a produced document, establishes that the file is a readable document for that
 * format (a PDF with a cross-reference table, a trailer and a page tree; a DOCX whose ZIP members
 * inflate and whose required Word parts parse), and compares the file with the record
 * `exports/edition-manifest.json` holds — its size, its hash, its page count and the accepted
 * version (§8.2) it was rendered from. A document whose recorded version is no longer the accepted
 * version of the universe is reported as `historical`, so an old edition is never presented as the
 * current book.
 *
 * stdout: ONE JSON line, the only output:
 *   {"schema_version":"edition-verification.v1","ok":true|false,"errors":[…],"warnings":[…],
 *    "documents":[{"format","path","bytes","sha256","pages","source_version","historical"}]}
 * Exit: 0 when `ok` is true, 2 in every other case (a failed check, an invalid argument or an
 * unusable universe). No npm dependency: the document checks live in `verify.mjs`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BookError, EXIT_USAGE, fail, readBytesFile } from './lib/errors.mjs';
import { acceptedVersion, languageCode, loadBook } from './lib/book.mjs';
import { resolveFonts } from './lib/fonts.mjs';
import { layoutBook, usedFaces } from './lib/layout.mjs';
import { DOCUMENT_FORMATS, REQUEST_FORMATS, editionManifestFile, manifestDocument, readManifest } from './lib/manifest.mjs';
import { verifyFile } from './lib/verify.mjs';

const SCHEMA = 'edition-verification.v1';

const USAGE =
  'Usage: node verify-edition.mjs --universe <universe-folder> [--format both|docx|pdf] ' +
  '[--since <epoch-ms>] [--fonts <folder>] [--language <code>]';

function parseArgs(argv) {
  const options = { universe: null, format: 'both', since: null, fonts: null, language: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const needsValue = (name) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`Option ${name} requires a value. ${USAGE}`, 'USAGE', EXIT_USAGE);
      }
      i += 1;
      return value;
    };
    if (arg === '--universe') options.universe = needsValue(arg);
    else if (arg === '--fonts') options.fonts = needsValue(arg);
    else if (arg === '--since') {
      const value = needsValue(arg);
      if (!/^\d+$/.test(value)) {
        fail(`--since expects a time in epoch milliseconds, not ${JSON.stringify(value)}. ${USAGE}`, 'USAGE', EXIT_USAGE);
      }
      options.since = Number(value);
    } else if (arg === '--language') {
      const value = needsValue(arg);
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

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The chapter files of the universe: `chapters/NNNN-slug.md`, with the number of the name. */
function chapterFiles(universeDir) {
  const dir = join(universeDir, 'chapters');
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    const match = /^(\d{4})-([a-z0-9-]+)\.md$/.exec(name);
    if (!match) continue;
    const file = join(dir, name);
    if (!statSync(file).isFile()) continue;
    files.push({ number: Number(match[1]), name });
  }
  return files.sort((a, b) => a.number - b.number);
}

/** The newest document of one format in `exports/`, or `null`; `since` keeps a run's own files. */
function latestDocument(exportsDir, format, since) {
  if (!existsSync(exportsDir)) return null;
  const matches = [];
  for (const name of readdirSync(exportsDir)) {
    if (!name.toLowerCase().endsWith(`.${format}`)) continue;
    const file = join(exportsDir, name);
    const stat = statSync(file);
    if (!stat.isFile()) continue;
    if (since !== null && stat.mtimeMs < since) continue;
    matches.push({ name, mtimeMs: stat.mtimeMs });
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches[0] ?? null;
}

/**
 * The edition of one universe, as the server sees it after an export turn.
 * @returns {{errors: Array<object>, warnings: Array<object>, documents: Array<object>}}
 */
function verifyEdition(options) {
  const universeDir = resolve(options.universe);
  if (!existsSync(universeDir) || !statSync(universeDir).isDirectory()) {
    fail(`No universe folder at ${universeDir}. ${USAGE}`, 'MISSING_UNIVERSE', EXIT_USAGE);
  }
  const errors = [];
  const warnings = [];
  const documents = [];
  const report = (code, message, extra = {}) => errors.push({ code, message, ...extra });

  // Two files for one chapter number leave no single chapter set to bind the edition to.
  const numbers = new Map();
  for (const chapter of chapterFiles(universeDir)) {
    const first = numbers.get(chapter.number);
    if (!first) {
      numbers.set(chapter.number, chapter);
      continue;
    }
    const number = String(chapter.number).padStart(4, '0');
    report(
      'DUPLICATE_CHAPTER',
      `Two chapter files carry the number ${number}: chapters/${first.name} and chapters/${chapter.name}; ` +
        'the edition cannot be bound to one chapter set. Keep one file per chapter number.',
      { path: `chapters/${chapter.name}` },
    );
  }

  const exportsDir = join(universeDir, 'exports');
  const manifestFile = editionManifestFile(exportsDir);
  let record = null;
  if (existsSync(manifestFile)) {
    // With `--since`, a manifest written before this run records an earlier edition, not this one.
    if (options.since !== null && statSync(manifestFile).mtimeMs < options.since) {
      record = null;
    } else {
      const read = readManifest(exportsDir);
      if (read.ok) {
        record = read.manifest;
      } else if (!read.missing) {
        report('INVALID_MANIFEST', `${read.message}; without it the documents cannot be bound to a source version. Rerun build-book.mjs.`);
      }
    }
  }

  let historical = false;
  if (record) {
    if (options.language && record.language !== options.language) {
      report(
        'INVALID_MANIFEST',
        `The manifest records the edition language "${record.language}" but "${options.language}" was requested.`,
        { path: basename(manifestFile) },
      );
    }
    const currentVersion = acceptedVersion(universeDir);
    historical = record.source_version !== currentVersion;
    if (historical) {
      warnings.push({
        code: 'HISTORICAL_EDITION',
        message:
          `The edition was rendered from the accepted version ${record.source_version}, while the universe is now at ` +
          `${currentVersion}: it does not contain the current book. Render the edition again to replace it.`,
      });
    }
  }

  const requested = options.format === 'both' ? [...DOCUMENT_FORMATS] : [options.format];
  for (const format of requested) {
    const entry = record ? manifestDocument(record, format) : null;
    const latest = latestDocument(exportsDir, format, options.since);
    if (!entry) {
      if (latest) {
        report(
          'MISSING_MANIFEST',
          `exports/${latest.name} exists but no ${basename(manifestFile)} records it, so its bytes, its page count ` +
            'and the accepted version it was rendered from cannot be checked. Render the edition again with build-book.mjs.',
          { format, path: `exports/${latest.name}` },
        );
      } else {
        report(
          'NO_EXPORT',
          `No ${format} document was produced: exports/ holds no .${format} file` +
            (options.since === null ? '' : ' written at or after --since') +
            `, and ${basename(manifestFile)} records none. Render the edition with build-book.mjs --format ${format}.`,
          { format },
        );
      }
      continue;
    }

    // The manifest records paths relative to the folder that holds it; the report names them
    // relative to the universe, which is what a caller can act on.
    const file = resolve(exportsDir, entry.path);
    const where = `exports/${basename(file)}`;
    if (!file.startsWith(`${exportsDir}${sep}`)) {
      report(
        'INVALID_MANIFEST',
        `The manifest records ${entry.path}, which resolves outside ${exportsDir}; a recorded document must stay ` +
          'inside the output folder.',
        { format, path: where },
      );
      continue;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      report(
        'INVALID_EXPORT',
        `The manifest records ${where} (${entry.bytes} bytes, ${entry.sha256}) but that file does not exist. ` +
          'The edition was moved or deleted after it was rendered; render it again.',
        { format, path: where },
      );
      continue;
    }
    if (options.since !== null && statSync(file).mtimeMs < options.since) {
      report(
        'NO_EXPORT',
        `The manifest records ${where}, but the file predates this run (--since ${options.since}): this run ` +
          `produced no ${format} document.`,
        { format, path: where },
      );
      continue;
    }

    let verified;
    try {
      verified = verifyFile(file, format);
    } catch (error) {
      report('INVALID_EXPORT', error.message, { format, path: where });
      continue;
    }
    const bytes = readBytesFile(file);
    const sha256 = sha256Hex(bytes);
    const pages = format === 'pdf' ? verified.pages : null;
    const problems = [];
    if (bytes.length !== entry.bytes) problems.push(`it is ${bytes.length} bytes where the manifest records ${entry.bytes}`);
    if (sha256 !== entry.sha256) problems.push(`its sha256 is ${sha256} where the manifest records ${entry.sha256}`);
    if (format === 'pdf' && pages !== entry.pages) {
      problems.push(`it holds ${pages} pages where the manifest records ${entry.pages}`);
    }
    if (problems.length) {
      report(
        'INVALID_EXPORT',
        `${where} does not match its manifest entry: ${problems.join('; ')}. The file was changed after it was ` +
          'rendered; render the edition again.',
        { format, path: where },
      );
      continue;
    }
    documents.push({ format, path: where, bytes: bytes.length, sha256, pages, source_version: record.source_version, historical });
  }

  // The font set and the language the caller rendered with are re-checked against the accepted text:
  // C32 refuses an edition whose faces cannot render every character a face is asked for.
  if (options.fonts || options.language) {
    try {
      const book = loadBook(universeDir, options.language ? { language: options.language } : {});
      resolveFonts(options.fonts ? resolve(options.fonts) : null, (faces) => usedFaces(layoutBook(book, faces)));
    } catch (error) {
      const known = error instanceof BookError;
      report(known ? error.code : 'INTERNAL', known ? error.message : `Internal error: ${error && error.message}`);
    }
  }

  return { errors, warnings, documents };
}

function main(argv) {
  const { errors, warnings, documents } = verifyEdition(parseArgs(argv));
  return { schema_version: SCHEMA, ok: errors.length === 0, errors, warnings, documents };
}

function emit(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function runCli() {
  let envelope;
  let ok = false;
  try {
    envelope = main(process.argv.slice(2));
    ok = envelope.ok;
  } catch (error) {
    const known = error instanceof BookError;
    envelope = {
      schema_version: SCHEMA,
      ok: false,
      errors: [
        {
          code: known ? error.code : 'INTERNAL',
          message: known ? error.message : `Internal error: ${error && error.message ? error.message : String(error)}`,
        },
      ],
      warnings: [],
      documents: [],
    };
    ok = false;
  }
  emit(envelope);
  // The documented contract: 0 when `ok` is true, 2 in every other case.
  process.exitCode = ok ? 0 : 2;
}

/**
 * Runs the CLI only when this module is the entry point; `.agents/skills/<skill>` is a symlink, and
 * Node resolves `import.meta.url` to the real path while `process.argv[1]` keeps the symlink.
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
