// Problems, warnings and the two file readers the validator is built from.
//
// A problem is `{ code, message }` plus the path, chapter or source chapter it belongs to. The
// envelope's own `code` is the most severe code present, chosen from `CODE_ORDER`, so an answer is
// stable no matter in which order the checks happened to run.

import { readFileSync } from 'node:fs';

import { CODE_ORDER } from './limits.mjs';

/** Exit statuses of `validate-import.mjs`: zero means the import holds, two means it does not. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 2;

export function problem(code, message, extra = {}) {
  return { code, message, ...extra };
}

export function warning(code, message, extra = {}) {
  return { code, message, ...extra };
}

/** The most severe code among the problems, or `null` when there are none. */
export function worstCode(problems) {
  for (const code of CODE_ORDER) {
    if (problems.some((entry) => entry.code === code)) return code;
  }
  return null;
}

/**
 * Read a text file. The result names why it failed instead of throwing, because "the file is not
 * there" and "the file is there but says nothing" are two different reports for the operator.
 */
export function readTextFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const missing = error && error.code === 'ENOENT';
    return { ok: false, kind: missing ? 'missing' : 'unreadable', text: '', message: `${file}: ${error?.message ?? error}` };
  }
  if (text.trim().length === 0) return { ok: false, kind: 'empty', text, message: `${file} is empty` };
  return { ok: true, kind: 'ok', text, message: '' };
}

/** Read a JSON file: absent, unreadable, empty and unparseable are distinguished. */
export function readJsonFile(file) {
  const read = readTextFile(file);
  if (!read.ok) return read;
  try {
    return { ok: true, kind: 'ok', value: JSON.parse(read.text), text: read.text, message: '' };
  } catch (error) {
    return { ok: false, kind: 'unparseable', text: read.text, message: `${file} is not valid JSON: ${error?.message ?? error}` };
  }
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/** A non-empty string with no surrounding whitespace. */
export function identifier(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && !/\s/.test(text) ? text : null;
}

/** A string that carries information: at least three characters and one letter. */
export function meaningful(value) {
  const text = String(value ?? '').trim();
  return text.length >= 3 && /\p{L}/u.test(text);
}
