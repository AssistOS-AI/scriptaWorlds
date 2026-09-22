// The small text measures the validator uses: word counts, normalized tokens and the run overlap
// that proves an imported chapter carries the extraction's own prose.
//
// Tokenization is deliberately blunt. A word is a maximal run of letters and digits after
// normalization, so punctuation, quotation marks, dashes and page furniture cannot make two copies
// of the same sentence look different, and a model is never asked whether two passages agree.

import { PROSE_RUN, WORD_RATIO_MAX, WORD_RATIO_MIN, WORD_SLACK } from './limits.mjs';

const NOT_WORD = /[^\p{L}\p{N}]+/gu;

/** The number of whitespace-separated words, counted exactly as the chapter validator counts them. */
export function countWords(text) {
  return String(text ?? '')
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Lower-cased letter/digit tokens; every other character becomes a separator. */
export function normalizeTokens(text) {
  const normalized = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(NOT_WORD, ' ')
    .trim();
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * The prose of a chapter file: every heading line and every scene separator is dropped, because a
 * fallback title such as `# Chapter 7` is written by this skill and does not come from the book.
 */
export function proseText(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) return false;
    if (/^([-*_])\1{2,}$/.test(trimmed)) return false;
    return true;
  });
  return kept.join('\n');
}

/** The title of a chapter file: the first non-empty line, without its `# `. */
export function chapterTitle(markdown) {
  const line = String(markdown ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  const match = /^#\s+(.+)$/.exec(line);
  return match ? match[1].trim() : null;
}

/** The set of overlapping runs of `size` tokens. */
export function shingleSet(tokens, size = PROSE_RUN) {
  const runs = new Set();
  for (let index = 0; index + size <= tokens.length; index += 1) {
    runs.add(tokens.slice(index, index + size).join(' '));
  }
  return runs;
}

/**
 * The fraction of the candidate's runs that occur in the source. Cleaning removes material, so a
 * candidate taken from the source keeps almost every run; prose that was written rather than
 * copied shares almost none. A candidate shorter than one run falls back to single tokens, which
 * is what makes the measure usable on the very short chapters a test writes.
 */
export function proseCoverage(sourceTokens, candidateTokens, size = PROSE_RUN) {
  if (candidateTokens.length === 0) return 0;
  if (candidateTokens.length < size) {
    const source = new Set(sourceTokens);
    let hits = 0;
    for (const token of candidateTokens) if (source.has(token)) hits += 1;
    return hits / candidateTokens.length;
  }
  const source = shingleSet(sourceTokens, size);
  let total = 0;
  let hits = 0;
  for (let index = 0; index + size <= candidateTokens.length; index += 1) {
    total += 1;
    if (source.has(candidateTokens.slice(index, index + size).join(' '))) hits += 1;
  }
  return total === 0 ? 0 : hits / total;
}

/**
 * The word band an imported chapter must stay inside to be a plausible copy of its source chapter:
 * a ratio band plus an absolute slack, so cleaning the page numbers of a short chapter cannot be
 * mistaken for cutting its prose. The band is about quantity; whether the words are the book's own
 * is what `proseCoverage` answers.
 */
export function plausibleWordRange(sourceWords, limits = {}) {
  const minRatio = limits.minRatio ?? WORD_RATIO_MIN;
  const maxRatio = limits.maxRatio ?? WORD_RATIO_MAX;
  const slack = limits.slack ?? WORD_SLACK;
  const lower = Math.floor(Math.min(sourceWords * minRatio, sourceWords - slack));
  const upper = Math.ceil(Math.max(sourceWords * maxRatio, sourceWords + slack));
  return { lower: Math.max(0, lower), upper };
}

/** A four-digit chapter number, as it appears in a file name and in `universe.json`. */
export function pad4(value) {
  return String(value).padStart(4, '0');
}
