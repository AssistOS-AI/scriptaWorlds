// The turn discipline of an import: how much of the extraction one turn may cover, and whether the
// turn journal of the record says what actually happened.
//
// The bound and the check live together here so the instruction an agent reads and the rule this
// validator applies cannot drift apart. The window is always a prefix of the extraction from the
// continuation pointer, in order, with no chapter repeated and none skipped forward.

import { CODE_INVALID_IMPORT, RECORD_PATH, TURN_MAX_CHAPTERS, TURN_MAX_WORDS, WARNING_TURN_OVERSIZE } from './limits.mjs';
import { isPlainObject, isPositiveInteger, problem, warning } from './problems.mjs';

/**
 * The window one import turn may cover, starting at `fromSourceChapter`: at most `TURN_MAX_CHAPTERS`
 * extraction chapters and at most `TURN_MAX_WORDS` words of their prose, and always the first chapter
 * even when that chapter alone is longer than the word bound.
 */
export function planTurnWindow(chapters, fromSourceChapter, limits = {}) {
  const maxChapters = limits.maxChapters ?? TURN_MAX_CHAPTERS;
  const maxWords = limits.maxWords ?? TURN_MAX_WORDS;
  const start = chapters.findIndex((chapter) => chapter.number === fromSourceChapter);
  if (start < 0) return null;
  const window = [];
  let words = 0;
  for (let index = start; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    if (window.length >= maxChapters) break;
    if (window.length > 0 && words + chapter.words > maxWords) break;
    window.push(chapter);
    words += chapter.words;
  }
  return {
    from: window[0].number,
    to: window[window.length - 1].number,
    chapters: window,
    words,
  };
}

/** The extraction chapters between two source chapter numbers, inclusive, in extraction order. */
export function sourceWindow(chapters, from, to) {
  const start = chapters.findIndex((chapter) => chapter.number === from);
  const end = chapters.findIndex((chapter) => chapter.number === to);
  if (start < 0 || end < 0 || end < start) return null;
  return chapters.slice(start, end + 1);
}

/**
 * Check the turn journal against the extraction and against the chapter entries it produced.
 *
 * A turn's range is the window it covered, which includes an extraction chapter it passed over
 * because the extraction declares no prose for it: such a chapter writes no chapter file and is
 * recorded in `skipped`, and the window still ends on it. Returns `{ turns, next }`, where `next` is
 * the extraction chapter after the last window, or `null` when the windows reach the end.
 */
export function checkTurns(raw, entries, chapters, skipped, problems, warnings) {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the import record has no turn, so no range is recorded', { path: RECORD_PATH }));
    return null;
  }
  const skippedSources = new Set(skipped.map((entry) => entry.source_chapter));
  const turns = [];
  let offset = 0;
  let pointer = chapters[0].number;
  raw.forEach((entry, index) => {
    const where = `turns[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} must be an object`, { path: RECORD_PATH }));
      return;
    }
    if (entry.number !== index + 1) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} is numbered ${JSON.stringify(entry.number)} instead of ${index + 1}`, { path: RECORD_PATH }));
    }
    if (typeof entry.imported_at !== 'string' || entry.imported_at.trim().length === 0) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} does not say when it ran`, { path: RECORD_PATH }));
    }
    const group = Array.isArray(entry.chapters) ? entry.chapters : null;
    if (!group || group.length === 0 || !group.every(isPositiveInteger)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} does not list the chapters it wrote`, { path: RECORD_PATH }));
      return;
    }
    const slice = entries.slice(offset, offset + group.length);
    if (slice.length !== group.length || slice.some((item, position) => item.chapter !== group[position])) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} does not list the chapters the record claims it wrote`, { path: RECORD_PATH }));
      return;
    }
    offset += group.length;
    const from = entry.from_source_chapter;
    const to = entry.to_source_chapter;
    if (!isPositiveInteger(from) || !isPositiveInteger(to) || to < from) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} must cover an ascending range of extraction chapters`, { path: RECORD_PATH }));
      return;
    }
    if (from !== pointer) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} starts at extraction chapter ${from} instead of continuing at ${pointer}`, { path: RECORD_PATH }));
      return;
    }
    const window = sourceWindow(chapters, from, to);
    if (!window) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} names a range the extraction does not declare`, { path: RECORD_PATH }));
      return;
    }
    for (const item of slice) {
      if (item.source_chapter < from || item.source_chapter > to) {
        problems.push(
          problem(CODE_INVALID_IMPORT, `the import record ${where} wrote extraction chapter ${item.source_chapter}, outside the range ${from}–${to} it says it covered`, {
            path: RECORD_PATH,
            chapter: item.chapter,
            source_chapter: item.source_chapter,
          }),
        );
      }
    }
    for (const chapter of window) {
      const written = slice.some((item) => item.source_chapter === chapter.number);
      if (!written && !skippedSources.has(chapter.number)) {
        problems.push(
          problem(CODE_INVALID_IMPORT, `the import record ${where} passed extraction chapter ${chapter.number} over without importing it or recording it in \`skipped\``, {
            path: RECORD_PATH,
            source_chapter: chapter.number,
          }),
        );
      }
    }
    const words = window.reduce((total, chapter) => total + chapter.words, 0);
    const allowed = planTurnWindow(chapters, from);
    const oversize = window.length > (allowed ? allowed.chapters.length : window.length) || (window.length > 1 && words > TURN_MAX_WORDS);
    if (oversize) {
      warnings.push(
        warning(
          WARNING_TURN_OVERSIZE,
          `import turn ${entry.number} covered ${window.length} extraction chapters and ${words} words, above the bound of ${TURN_MAX_CHAPTERS} chapters and ${TURN_MAX_WORDS} words`,
          { path: RECORD_PATH },
        ),
      );
    }
    const nextIndex = chapters.findIndex((chapter) => chapter.number === to) + 1;
    pointer = nextIndex < chapters.length ? chapters[nextIndex].number : null;
    turns.push({ number: entry.number, from_source_chapter: from, to_source_chapter: to, chapters: group, words });
  });
  if (offset !== entries.length) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the import record lists chapters that no turn claims', { path: RECORD_PATH }));
  }
  return { turns, next: pointer };
}
