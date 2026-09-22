// The chapter files of an imported universe.
//
// Three questions are answered here, all of them mechanically: is the chapter set intact (every
// chapter the record claims exists once, and the numbers of the checked range have no hole), does
// each file hold a renderable chapter whose title is the one the record wrote, and does its prose
// come from the extraction chapter it claims to come from — the same words, in the same order,
// within the band cleaning can explain.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CHAPTER_FILE,
  CODE_INVALID_IMPORT,
  CODE_MISSING_CHAPTER,
  CODE_WORD_COVERAGE,
  PROSE_COVERAGE_MIN,
  SEGMENT_MAX_WORDS,
  SEGMENT_MIN_WORDS,
  WARNING_SEGMENT_OFF_BAND,
} from './limits.mjs';
import { problem, readTextFile, warning, worstCode } from './problems.mjs';
import { chapterTitle, countWords, normalizeTokens, pad4, plausibleWordRange, proseCoverage, proseText } from './text.mjs';

/** Every chapter file of a universe, grouped by chapter number; a number may hold several files. */
export function scanChapterFiles(universeDir) {
  let names = [];
  try {
    names = readdirSync(join(universeDir, 'chapters'));
  } catch {
    return new Map();
  }
  const files = new Map();
  for (const name of names) {
    const match = CHAPTER_FILE.exec(name);
    if (!match) continue;
    const number = Number.parseInt(match[1], 10);
    if (!files.has(number)) files.set(number, []);
    files.get(number).push(name);
  }
  return files;
}

/**
 * Check the imported chapters of the universe, optionally only the chapters of one range.
 *
 * `range` is `{ from, to }` over *extraction* chapter numbers — the range one import turn covered,
 * which is the range the record's own turn journal carries — and `null` when the whole import is
 * checked.
 */
export function checkChapters({ universeDir, extraction, record, range }) {
  const problems = [];
  const warnings = [];
  const files = scanChapterFiles(universeDir);
  const checked = [];
  const entries = record.chapters.filter((entry) => !range || (entry.source_chapter >= range.from && entry.source_chapter <= range.to));
  const lastChapter = record.chapters[record.chapters.length - 1].chapter;

  if (range) {
    // A range names the extraction chapters one turn covered, which is the vocabulary the host plans
    // turns with and the range the record's own turn journal carries. Every chapter of it must be
    // declared by the extraction and must lie behind the continuation pointer.
    const declared = new Set(extraction.chapters.map((chapter) => chapter.number));
    const frontier = record.next_source_chapter === null ? Number.POSITIVE_INFINITY : record.next_source_chapter;
    for (let number = range.from; number <= range.to; number += 1) {
      if (!declared.has(number)) {
        problems.push(problem(CODE_MISSING_CHAPTER, `the extraction declares no chapter ${number}, which the checked range ${range.from}-${range.to} includes`, { path: 'drafts/import-progress.json', source_chapter: number }));
      } else if (number >= frontier) {
        problems.push(problem(CODE_MISSING_CHAPTER, `extraction chapter ${number} is not imported yet: the import continues at ${frontier}`, { path: 'drafts/import-progress.json', source_chapter: number }));
      }
    }
  } else if (!record.complete) {
    for (const [number] of files) {
      if (number > lastChapter) {
        problems.push(
          problem(CODE_INVALID_IMPORT, `chapter ${number} exists beyond the imported range, but the import says it is unfinished at chapter ${lastChapter}`, {
            path: `chapters/${pad4(number)}`,
            chapter: number,
          }),
        );
      }
    }
  }

  const bySource = new Map();
  for (const entry of entries) {
    const held = files.get(entry.chapter) ?? [];
    const path = entry.file ?? `chapters/${pad4(entry.chapter)}`;
    if (held.length === 0) {
      problems.push(problem(CODE_MISSING_CHAPTER, `chapter ${entry.chapter} is recorded as ${path} but no such file exists`, { path, chapter: entry.chapter }));
      continue;
    }
    if (held.length > 1) {
      problems.push(
        problem(CODE_MISSING_CHAPTER, `chapter ${entry.chapter} has ${held.length} files (${held.join(', ')}); one chapter is one file`, {
          path: `chapters/${pad4(entry.chapter)}`,
          chapter: entry.chapter,
        }),
      );
      continue;
    }
    if (entry.file && held[0] !== entry.file.split('/').pop()) {
      problems.push(
        problem(CODE_MISSING_CHAPTER, `chapter ${entry.chapter} is recorded as ${entry.file} but the folder holds chapters/${held[0]}`, {
          path: entry.file,
          chapter: entry.chapter,
        }),
      );
      continue;
    }
    const read = readTextFile(join(universeDir, 'chapters', held[0]));
    if (!read.ok) {
      problems.push(problem(CODE_MISSING_CHAPTER, `chapter ${entry.chapter} cannot be read: ${read.message}`, { path: `chapters/${held[0]}`, chapter: entry.chapter }));
      continue;
    }
    const title = chapterTitle(read.text);
    if (title === null) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `chapter ${entry.chapter} does not begin with its title as \`# Title\`, so no renderer can read it as a chapter`, {
          path: `chapters/${held[0]}`,
          chapter: entry.chapter,
        }),
      );
    } else if (entry.title && title !== entry.title) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `chapter ${entry.chapter} is recorded with the title ${JSON.stringify(entry.title)} but its file says ${JSON.stringify(title)}`, {
          path: `chapters/${held[0]}`,
          chapter: entry.chapter,
        }),
      );
    }
    const words = countWords(read.text);
    if (!bySource.has(entry.source_chapter)) bySource.set(entry.source_chapter, { words: 0, tokens: [], segments: [] });
    const group = bySource.get(entry.source_chapter);
    group.words += words;
    group.tokens.push(...normalizeTokens(proseText(read.text)));
    group.segments.push({ chapter: entry.chapter, words, path: `chapters/${held[0]}` });
    checked.push({ chapter: entry.chapter, source_chapter: entry.source_chapter, file: `chapters/${held[0]}`, words });
  }

  for (const [sourceChapter, group] of bySource) {
    const source = extraction.chapters.find((chapter) => chapter.number === sourceChapter);
    if (!source) continue;
    const band = plausibleWordRange(source.words);
    if (group.words < band.lower || group.words > band.upper) {
      problems.push(
        problem(
          CODE_WORD_COVERAGE,
          `extraction chapter ${sourceChapter} holds ${source.words} words and the imported ${group.segments.length > 1 ? 'chapters hold' : 'chapter holds'} ${group.words}, outside the plausible band ${band.lower}–${band.upper}`,
          { path: group.segments.map((segment) => segment.path).join(', '), source_chapter: sourceChapter },
        ),
      );
    }
    const forward = proseCoverage(source.tokens, group.tokens);
    const backward = proseCoverage(group.tokens, source.tokens);
    if (forward < PROSE_COVERAGE_MIN || backward < PROSE_COVERAGE_MIN) {
      problems.push(
        problem(
          CODE_WORD_COVERAGE,
          `the imported text of extraction chapter ${sourceChapter} is not the book's own prose: ${Math.round(forward * 100)}% of it occurs in the extraction and ${Math.round(backward * 100)}% of the extraction occurs in it (at least ${Math.round(PROSE_COVERAGE_MIN * 100)}% of both is required)`,
          { path: group.segments.map((segment) => segment.path).join(', '), source_chapter: sourceChapter },
        ),
      );
    }
    if (record.segmentation === 'word_count' && group.segments.length > 1) {
      group.segments.forEach((segment, index) => {
        const last = index === group.segments.length - 1;
        if (last) return;
        if (segment.words < SEGMENT_MIN_WORDS || segment.words > SEGMENT_MAX_WORDS) {
          warnings.push(
            warning(
              WARNING_SEGMENT_OFF_BAND,
              `chapter ${segment.chapter} cuts extraction chapter ${sourceChapter} at ${segment.words} words, outside the segmentation band ${SEGMENT_MIN_WORDS}–${SEGMENT_MAX_WORDS}`,
              { path: segment.path, chapter: segment.chapter, source_chapter: sourceChapter },
            ),
          );
        }
      });
    }
  }

  const words = checked.reduce((total, chapter) => total + chapter.words, 0);
  return { ok: problems.length === 0, code: worstCode(problems), problems, warnings, checked, words };
}
