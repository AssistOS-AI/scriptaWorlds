// The entry point of the book import, and the one place the chapter segmentation is decided. An
// uploaded PDF or DOCX becomes the `book-import.v1` object the import pipeline consumes, or a refusal
// with a code; the importer never returns a half-read book and never guesses at text.
//
// Invariants:
// - `extractBook` is the only file reader: it bounds itself with `maxBytes` before it reads, hashes the
//   bytes it read, and dispatches to `./import-docx.mjs` or `./import-pdf.mjs` for the format work.
// - `detectFormat` answers from the bytes first (a `%PDF-` header, a ZIP local file header) and from
//   the file name second, so a wrong extension is caught as unreadable rather than parsed as text.
// - Refusals are `UniverseError`s with a stable code: `IMPORT_UNSUPPORTED` for a format the importer
//   does not read, `IMPORT_TOO_LARGE` for an upload past the byte limit and for a pathological page or
//   entry count, `IMPORT_NO_TEXT` for a book without a text layer, and `IMPORT_UNREADABLE` for an
//   empty, truncated or mislabelled file.
// - `segmentChapters` is shared by both formats so one book cannot be sliced two ways: a heading is a
//   short standalone paragraph that is either numbered or set clearly larger than the body, chapter
//   numbers are contiguous from 1, the heading line is the chapter title and is kept out of the text,
//   and a document without a detectable boundary becomes one chapter named by its title plus a warning.
// - `source.pages` is the number of pages examined for a PDF and the page count Word last recorded for
//   a DOCX, which is null when the package does not carry `docProps/app.xml`.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { UniverseError } from './errors.mjs';
import { extractDocx } from './import-docx.mjs';
import { extractPdf } from './import-pdf.mjs';

/** The schema version of the returned object; the pipeline validates against it. */
export const IMPORT_SCHEMA_VERSION = 'book-import.v1';

/** The formats the importer reads, and the upload bound it applies before reading anything. */
export const IMPORT_FORMATS = ['pdf', 'docx'];
export const IMPORT_LIMITS = { maxBytes: 64 * 1024 * 1024 };

// A heading is short and standalone. These are the boundaries this rule recognises in any language:
// an Arabic or Roman number on its own, a number that opens a short line, and a division word
// ("chapter", "capitolul", "part", "book") followed by its number.
const HEADING_KEYWORD = /^(chapter|capitolul|capitol|partea|part|cartea|book|section|prolog|prologue|epilog|epilogue)\b/i;
const SENTENCE_TAIL = /[,;:]$/;
const MAX_HEADING_CHARACTERS = 80;
const MAX_HEADING_WORDS = 12;
const LARGER_THAN_BODY = 1.2;

function formatFromName(filename) {
  const extension = extname(String(filename ?? '')).replace(/^\./, '').toLowerCase();
  return IMPORT_FORMATS.includes(extension) ? extension : null;
}

function normalizeFormat(format) {
  if (format === null || format === undefined || format === '') return null;
  const value = String(format).trim().toLowerCase();
  return IMPORT_FORMATS.includes(value) ? value : null;
}

/** The format of an upload: the bytes decide when they are recognisable, the file name otherwise. */
export function detectFormat({ filename = '', bytes = null } = {}) {
  if (bytes !== null && bytes !== undefined) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
    if (data.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004') return 'docx';
  }
  return formatFromName(filename);
}

/** The size the most text was set in: the body size a heading has to stand out from. */
export function bodyFontSize(paragraphs) {
  const weight = new Map();
  for (const paragraph of paragraphs ?? []) {
    if (!Number.isFinite(paragraph.size)) continue;
    const key = paragraph.size.toFixed(1);
    weight.set(key, (weight.get(key) ?? 0) + String(paragraph.text ?? '').length);
  }
  let best = null;
  for (const [key, count] of weight) {
    if (best === null || count > best.count) best = { size: Number(key), count };
  }
  return best === null ? null : best.size;
}

/** True for a standalone division line: `Chapter 3`, `Capitolul 3`, `3.`, `III`, `Part II of the ledger`. */
export function isNumberedHeading(text) {
  const value = String(text ?? '').trim();
  // A numbered line that ends like a sentence is prose, not a heading: `Chapter 3. The Long Night` is a
  // heading, `Chapter 3 ends the ledger.` is a sentence.
  if (/\.$/.test(value) && value.split(/\s+/).length > 3) return false;
  if (/^\d{1,3}[.)]?$/.test(value)) return true;
  if (/^[IVXLCDM]{1,7}\.?$/.test(value)) return true;
  if (/^\d{1,3}[.)]?\s+\S/.test(value)) return true;
  return HEADING_KEYWORD.test(value) && /\b(\d{1,4}|[IVXLCDM]{1,7})\b/.test(value);
}

function countWords(text) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

/**
 * Slices paragraphs into chapters. `depth` marks the heading depth a DOCX style gives a paragraph, and
 * only the shallowest depth the document uses starts a chapter; a paragraph without a depth is a
 * heading when it is short, standalone and numbered or clearly larger than the body.
 */
export function segmentChapters(paragraphs, { documentTitle = null } = {}) {
  const warnings = [];
  const blocks = (paragraphs ?? []).filter((paragraph) => String(paragraph.text ?? '').trim());
  const depths = blocks.map((paragraph) => paragraph.depth).filter((depth) => Number.isInteger(depth));
  const shallowest = depths.length ? Math.min(...depths) : null;
  const bodySize = bodyFontSize(blocks);
  const isHeading = (paragraph) => {
    if (Number.isInteger(paragraph.depth)) return paragraph.depth === shallowest;
    const text = paragraph.text.trim();
    if (text.length > MAX_HEADING_CHARACTERS || SENTENCE_TAIL.test(text)) return false;
    if (text.split(/\s+/).length > MAX_HEADING_WORDS) return false;
    if ((paragraph.lines ?? 1) > 2) return false;
    if (isNumberedHeading(text)) return true;
    return Number.isFinite(bodySize) && Number.isFinite(paragraph.size) && paragraph.size >= bodySize * LARGER_THAN_BODY;
  };

  const chapters = [];
  let headings = 0;
  let current = { title: null, texts: [] };
  const close = () => {
    const text = current.texts.join('\n\n').trim();
    if (current.title === null && text === '') return;
    chapters.push({ title: current.title, text });
  };
  for (const paragraph of blocks) {
    if (isHeading(paragraph)) {
      headings += 1;
      close();
      current = { title: paragraph.text.trim(), texts: [] };
      continue;
    }
    current.texts.push(paragraph.text.trim());
  }
  close();

  if (headings === 0) {
    warnings.push('No chapter heading was detected, so the whole document is returned as one chapter and the import step must segment it.');
    const text = blocks.map((paragraph) => paragraph.text.trim()).join('\n\n');
    return { chapters: [{ number: 1, title: documentTitle, text }], warnings, bodySize };
  }
  if (chapters[0].title === null) {
    warnings.push('The paragraphs before the first heading are returned as the first chapter, which has no title of its own.');
  }
  return {
    chapters: chapters.map((chapter, index) => ({ number: index + 1, title: chapter.title, text: chapter.text })),
    warnings,
    bodySize
  };
}

// A book title page is the first paragraph of the first page, set clearly larger than the body. A
// numbered line is a chapter heading even when it is large, so it is never taken for the book title.
function titlePageParagraph(paragraphs, bodySize) {
  const first = paragraphs[0];
  if (!first || first.page !== 1 || (first.lines ?? 1) > 1) return null;
  if (!Number.isFinite(bodySize) || !Number.isFinite(first.size) || first.size < bodySize * LARGER_THAN_BODY) return null;
  if (first.text.length > 120 || isNumberedHeading(first.text)) return null;
  return first;
}

function sameText(left, right) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

/**
 * Turns an uploaded file into the `book-import.v1` object, or refuses it with a coded `UniverseError`.
 * `format` is the declared format; without it the file name and the bytes decide.
 */
export async function extractBook({ path = null, filename = null, format = null, maxBytes = IMPORT_LIMITS.maxBytes } = {}) {
  if (typeof path !== 'string' || path === '') {
    throw new UniverseError('IMPORT_UNREADABLE', 'The import needs the path of the uploaded file.', 400);
  }
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isFile()) {
    throw new UniverseError('IMPORT_UNREADABLE', `The uploaded file cannot be read: ${path}.`, 400);
  }
  if (info.size === 0) throw new UniverseError('IMPORT_UNREADABLE', 'The uploaded file is empty.', 400);
  if (info.size > maxBytes) {
    throw new UniverseError('IMPORT_TOO_LARGE', `The uploaded file is ${info.size} bytes, above the ${maxBytes} bytes the importer accepts.`, 413);
  }
  const bytes = await readFile(path).catch(() => null);
  if (bytes === null) {
    throw new UniverseError('IMPORT_UNREADABLE', `The uploaded file cannot be read: ${path}.`, 400);
  }

  const name = filename ?? basename(path);
  if (format !== null && format !== undefined && format !== '' && normalizeFormat(format) === null) {
    throw new UniverseError('IMPORT_UNSUPPORTED', `The importer reads PDF and DOCX books; the declared format "${format}" is neither.`, 400);
  }
  const declared = normalizeFormat(format) ?? formatFromName(name);
  const detected = detectFormat({ filename: name, bytes });
  if (declared === null && detected === null) {
    throw new UniverseError('IMPORT_UNSUPPORTED', `The importer reads PDF and DOCX books; "${name}" is neither.`, 400);
  }
  if (declared !== null && detected !== null && declared !== detected) {
    throw new UniverseError('IMPORT_UNREADABLE', `"${name}" is declared as ${declared} but its bytes are a ${detected} file.`, 400);
  }
  const target = declared ?? detected;

  const extracted = target === 'docx' ? extractDocx({ bytes }) : extractPdf({ bytes });
  if (extracted.paragraphs.length === 0) {
    throw new UniverseError('IMPORT_NO_TEXT', `The ${target.toUpperCase()} file was read and carries no text paragraph.`, 422);
  }

  // A PDF has no title paragraph role of its own: the information dictionary decides, and failing that
  // the oversized first line of the first page, which is then not also a chapter.
  let paragraphs = extracted.paragraphs;
  let title = extracted.title;
  if (target === 'pdf') {
    const bodySize = bodyFontSize(paragraphs);
    const first = paragraphs[0];
    const matchesTitle = title !== null && first?.page === 1 && sameText(first.text, title);
    const titlePage = title === null ? titlePageParagraph(paragraphs, bodySize) : null;
    if (matchesTitle || titlePage) {
      title = title ?? titlePage.text;
      paragraphs = paragraphs.filter((paragraph, index) => index !== 0);
    }
  }

  const segmented = segmentChapters(paragraphs, { documentTitle: title });
  return {
    schema_version: IMPORT_SCHEMA_VERSION,
    source: {
      filename: name,
      format: target,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      pages: extracted.pages ?? null
    },
    detected: {
      title: title ?? null,
      author: extracted.author ?? null,
      language: extracted.language ?? null
    },
    chapters: segmented.chapters.map((chapter) => ({
      number: chapter.number,
      title: chapter.title ?? null,
      words: countWords(chapter.text),
      text: chapter.text
    })),
    warnings: [...extracted.warnings, ...segmented.warnings]
  };
}
