// Reading the host's extraction.
//
// The extraction is the only input of an import: `.agents/import/extracted.json`, written by the
// host from the uploaded file, plus the plain-text twin `.agents/import/book.md` that carries the
// same prose for comfortable reading. This module decides whether the extraction can be imported at
// all; it never repairs, guesses or fills a gap, because an import that invents prose is worthless.

import {
  CODE_INVALID_IMPORT,
  CODE_NO_EXTRACTION,
  CODE_UNPARSEABLE_JSON,
  IMPORT_SCHEMA_VERSION,
  LANGUAGE_CODE,
  SHA256_HEX,
  WARNING_EXTRACTION_WORD_MISMATCH,
} from './limits.mjs';
import { identifier, isPlainObject, isPositiveInteger, meaningful, problem, readJsonFile, warning, worstCode } from './problems.mjs';
import { countWords, normalizeTokens } from './text.mjs';

const IMPORT_ID = /^[A-Za-z0-9-]{4,64}$/;
const WORD_MISMATCH_RATIO = 0.1;

/**
 * Load and check the extraction file.
 *
 * Returns `{ ok, code, problems, warnings, extraction }`. When `ok` is false the extraction cannot
 * be imported and `extraction` is null: the caller reports and stops rather than importing half a
 * book.
 */
export function loadExtraction(file) {
  const problems = [];
  const warnings = [];
  const read = readJsonFile(file);
  if (!read.ok) {
    const code = read.kind === 'unparseable' ? CODE_UNPARSEABLE_JSON : CODE_NO_EXTRACTION;
    return { ok: false, code, problems: [problem(code, read.message, { path: file })], warnings, extraction: null };
  }
  const value = read.value;
  if (!isPlainObject(value)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction must be a JSON object', { path: file }));
    return { ok: false, code: CODE_INVALID_IMPORT, problems, warnings, extraction: null };
  }
  if (value.schema_version !== IMPORT_SCHEMA_VERSION) {
    problems.push(
      problem(CODE_INVALID_IMPORT, `the extraction declares schema_version ${JSON.stringify(value.schema_version)}; ${IMPORT_SCHEMA_VERSION} is expected`, { path: file }),
    );
  }
  const importId = identifier(value.import_id);
  if (!importId || !IMPORT_ID.test(importId)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction has no usable import_id', { path: file }));
  }

  const source = checkSource(value.source, file, problems);
  const detected = checkDetected(value.detected, file, problems);
  const chapters = checkChapters(value.chapters, file, problems, warnings);
  if (chapters && chapters.every((chapter) => chapter.words === 0)) {
    problems.push(
      problem(
        CODE_NO_EXTRACTION,
        'the extraction declares no prose at all: a scan without a text layer or an empty extraction is refused rather than invented',
        { path: file },
      ),
    );
  }

  if (problems.length > 0) {
    return { ok: false, code: worstCode(problems), problems, warnings, extraction: null };
  }
  return {
    ok: true,
    code: null,
    problems,
    warnings,
    extraction: { import_id: importId, source, detected, chapters },
  };
}

function checkSource(source, file, problems) {
  if (!isPlainObject(source)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction has no `source` object', { path: file }));
    return null;
  }
  if (!meaningful(source.filename)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction does not name the uploaded file', { path: file }));
  }
  if (!meaningful(source.format)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction does not name the format of the uploaded file', { path: file }));
  }
  if (typeof source.sha256 !== 'string' || !SHA256_HEX.test(source.sha256)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction does not carry the sha256 of the uploaded file', { path: file }));
  }
  return {
    filename: typeof source.filename === 'string' ? source.filename : null,
    format: typeof source.format === 'string' ? source.format : null,
    sha256: typeof source.sha256 === 'string' ? source.sha256 : null,
    bytes: Number.isInteger(source.bytes) ? source.bytes : null,
    pages: Number.isInteger(source.pages) ? source.pages : null,
  };
}

function checkDetected(detected, file, problems) {
  if (!isPlainObject(detected)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction has no `detected` object', { path: file }));
    return null;
  }
  if (!meaningful(detected.title)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction detected no title for the book', { path: file }));
  }
  if (detected.author !== null && detected.author !== undefined && typeof detected.author !== 'string') {
    problems.push(problem(CODE_INVALID_IMPORT, '`detected.author` must be a string or null', { path: file }));
  }
  if (detected.language !== null && detected.language !== undefined && !(typeof detected.language === 'string' && LANGUAGE_CODE.test(detected.language))) {
    problems.push(problem(CODE_INVALID_IMPORT, '`detected.language` must be a two-letter code or null', { path: file }));
  }
  return {
    title: typeof detected.title === 'string' ? detected.title : null,
    author: typeof detected.author === 'string' ? detected.author : null,
    language: typeof detected.language === 'string' ? detected.language : null,
  };
}

function checkChapters(raw, file, problems, warnings) {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the extraction declares no chapter, so there is nothing to import', { path: file }));
    return null;
  }
  const chapters = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    const where = `chapters[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the extraction entry ${where} must be an object`, { path: file }));
      return;
    }
    if (!isPositiveInteger(entry.number)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the extraction entry ${where} has no positive integer number`, { path: file }));
      return;
    }
    if (seen.has(entry.number)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the extraction declares chapter ${entry.number} twice`, { path: file, source_chapter: entry.number }));
      return;
    }
    seen.add(entry.number);
    if (entry.title !== undefined && entry.title !== null && typeof entry.title !== 'string') {
      problems.push(problem(CODE_INVALID_IMPORT, `the extraction entry ${where} has a non-string title`, { path: file, source_chapter: entry.number }));
    }
    if (typeof entry.text !== 'string') {
      problems.push(problem(CODE_INVALID_IMPORT, `the extraction entry ${where} carries no text field`, { path: file, source_chapter: entry.number }));
      return;
    }
    const wordsInText = countWords(entry.text);
    if (Number.isInteger(entry.words) && entry.words > 0) {
      const drift = Math.abs(entry.words - wordsInText) / entry.words;
      if (drift > WORD_MISMATCH_RATIO) {
        warnings.push(
          warning(
            WARNING_EXTRACTION_WORD_MISMATCH,
            `the extraction declares ${entry.words} words for chapter ${entry.number} but its text holds ${wordsInText}`,
            { path: file, source_chapter: entry.number },
          ),
        );
      }
    }
    chapters.push({
      number: entry.number,
      title: typeof entry.title === 'string' && entry.title.trim().length > 0 ? entry.title.trim() : null,
      words: wordsInText,
      text: entry.text,
      tokens: normalizeTokens(entry.text),
    });
  });
  if (problems.length > 0) return null;
  chapters.sort((left, right) => left.number - right.number);
  return chapters;
}
