/**
 * Bounded selection from the synthetic literary case library (C65).
 *
 * The host's annotation prompt asks for teaching examples; this module chooses
 * them instead of "the first eight entries". Given a book language and a
 * maximum size, it returns real cases — the paired before/after text, the
 * changed feature, the expected evidence and the acceptable alternative
 * readings — preferring cases in the book's language and filling the rest with
 * English, and it never mixes in the declared regression holdout.
 *
 * Selection never ranks a quiet scene, a static character, a closed ending or a
 * local cultural setting as a defect: the rule is stated in the returned record
 * and in the published rubric anchors, and the cases themselves carry an
 * `acceptable_alternative_readings` list so a disagreement is discussed, not
 * scored.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail } from './errors.mjs';
import { loadCaseLibrary } from './case-library.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the library lives when the caller does not name its own directory. */
export const DEFAULT_CASE_LIBRARY = resolve(HERE, '..', '..', 'fixtures', 'literary-cases');

export const SELECTION_SCHEMA_VERSION = 'literary-case-selection.v1';

/** The selection rule the host must state in the prompt, word for word. */
export const SELECTION_RULE =
  'A quiet scene, a static character, a closed ending or a local cultural setting is not a defect by ' +
  'default; a case is teaching material about one changed literary feature, not a ranking of its subject matter.';

/** Project one case document into the bounded teaching shape the host consumes. */
export function toTeachingCase(document) {
  return {
    id: document.id,
    language: document.language,
    title: document.title,
    target_distinction: document.target_distinction,
    distinction_statement: document.distinction_statement,
    intention: document.intention,
    change: {
      feature: document.change.feature,
      description: document.change.description,
      changed_paragraphs: [...document.change.changed_paragraphs],
    },
    before: { label: document.before.label, text: document.before.text },
    after: { label: document.after.label, text: document.after.text },
    expected_evidence: document.expected_evidence.map((entry) => ({
      side: entry.side,
      quote: entry.quote,
      start: entry.start,
      end: entry.end,
      expectation: entry.expectation,
    })),
    acceptable_alternative_readings: [...document.acceptable_alternative_readings],
  };
}

/**
 * Select up to `maxSize` teaching cases. `language` is the book's language;
 * cases in that language come first and the remainder is filled with English
 * cases. Cases in the index's `regression_subset` are never returned.
 */
export function selectTeachingCases({ language, maxSize = 8, libraryRoot = DEFAULT_CASE_LIBRARY }) {
  if (typeof language !== 'string' || language.length === 0) {
    fail('language must be a non-empty string', 'INVALID_ARGUMENTS');
  }
  if (!Number.isInteger(maxSize) || maxSize < 0) {
    fail(`maxSize must be a non-negative integer, got ${JSON.stringify(maxSize)}`, 'INVALID_ARGUMENTS');
  }
  const library = loadCaseLibrary(libraryRoot);
  const regression = new Set(library.index && library.index.regression_subset ? library.index.regression_subset.case_ids : []);
  const preferred = [];
  const english = [];
  for (const document of library.cases.values()) {
    if (!document || typeof document.id !== 'string') continue;
    if (regression.has(document.id)) continue;
    if (document.language === language) preferred.push(document);
    else if (document.language === 'en') english.push(document);
  }
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  preferred.sort(byId);
  english.sort(byId);
  // The book's language first, the rest in English. An English book's preferred
  // cases already are the English cases, so the rest contributes nothing extra.
  const pool = [...preferred, ...english];
  const cases = pool.slice(0, maxSize).map(toTeachingCase);
  return {
    schema_version: SELECTION_SCHEMA_VERSION,
    requested_language: language,
    max_size: maxSize,
    count: cases.length,
    selection_rule: SELECTION_RULE,
    excluded_regression: [...regression].sort(),
    cases,
  };
}
