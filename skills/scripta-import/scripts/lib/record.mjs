// The import record: `drafts/import-progress.json`.
//
// One import is a sequence of bounded turns. The record is what makes the sequence possible: it
// names the extraction the universe was built from, the chapters that are already imported, the
// range every turn covered and the extraction chapter the next turn starts at. It is also the
// machine-readable mark that tells a reader (and this validator) that a universe was imported
// rather than written. A universe without it is not refused as a book; it is refused as an import.

import {
  CODE_INVALID_IMPORT,
  CODE_UNPARSEABLE_JSON,
  IMPORT_SCHEMA_VERSION,
  RECORD_PATH,
  SEGMENTATIONS,
} from './limits.mjs';
import { identifier, isPlainObject, isPositiveInteger, meaningful, problem, readJsonFile, worstCode } from './problems.mjs';
import { checkTurns, sourceWindow } from './turns.mjs';

const CHAPTER_FILE = /^chapters\/(\d{4})-([a-z0-9-]+)\.md$/;

/** The language decision: which language the book is in, and which one the state files are written in. */
function checkLanguage(value, file, problems) {
  if (!isPlainObject(value)) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the import record has no `language` decision', { path: file }));
    return null;
  }
  for (const key of ['book', 'state', 'universe']) {
    const entry = value[key];
    if (entry !== null && entry !== undefined && !(typeof entry === 'string' && /^[a-z]{2}$/.test(entry))) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record language.${key} must be a two-letter code or null`, { path: file }));
    }
  }
  if (typeof value.match !== 'boolean') {
    problems.push(problem(CODE_INVALID_IMPORT, 'the import record language.match must be true or false', { path: file }));
  }
  return {
    book: typeof value.book === 'string' ? value.book : null,
    state: typeof value.state === 'string' ? value.state : null,
    universe: typeof value.universe === 'string' ? value.universe : null,
    match: value.match === true,
  };
}

/**
 * The chapters the import wrote: one entry per chapter file, ascending, numbered without a hole from
 * the import's start, each naming the extraction chapter it came from and the file and title that
 * exist on disk.
 */
function checkChapterEntries(raw, file, problems) {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(problem(CODE_INVALID_IMPORT, 'the import record lists no imported chapter', { path: file }));
    return null;
  }
  const entries = [];
  let previous = null;
  raw.forEach((entry, index) => {
    const where = `chapters[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record entry ${where} must be an object`, { path: file }));
      return;
    }
    if (!isPositiveInteger(entry.chapter)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record entry ${where} has no positive integer chapter`, { path: file }));
      return;
    }
    if (!isPositiveInteger(entry.source_chapter)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record entry ${where} has no positive integer source_chapter`, { path: file, chapter: entry.chapter }));
      return;
    }
    if (previous !== null && entry.chapter <= previous) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record entry ${where} is not in ascending chapter order`, { path: file, chapter: entry.chapter }));
      return;
    }
    previous = entry.chapter;
    const fileMatch = typeof entry.file === 'string' ? CHAPTER_FILE.exec(entry.file) : null;
    if (!fileMatch) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record entry ${where} does not name a chapter file`, { path: file, chapter: entry.chapter }));
    } else if (Number.parseInt(fileMatch[1], 10) !== entry.chapter) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `the import record entry ${where} names ${entry.file}, which is chapter ${Number.parseInt(fileMatch[1], 10)}`, {
          path: file,
          chapter: entry.chapter,
        }),
      );
    }
    if (entry.segment !== null && entry.segment !== undefined && !isPositiveInteger(entry.segment)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record entry ${where} has a segment that is not null or a positive integer`, { path: file, chapter: entry.chapter }));
      return;
    }
    if (!meaningful(entry.title)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record entry ${where} does not name the title it wrote`, { path: file, chapter: entry.chapter }));
    }
    entries.push({
      chapter: entry.chapter,
      source_chapter: entry.source_chapter,
      segment: isPositiveInteger(entry.segment) ? entry.segment : null,
      file: typeof entry.file === 'string' ? entry.file : null,
      title: typeof entry.title === 'string' ? entry.title.trim() : null,
    });
  });
  return entries;
}

/**
 * The chapters the import passed without writing a chapter file. Only an extraction chapter that
 * carries no prose at all may be skipped — a part title or a blank page — so a readable chapter can
 * never be dropped in silence.
 */
function checkSkipped(raw, file, problems) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} declares \`skipped\` as something other than a list`, { path: file }));
    return [];
  }
  const skipped = [];
  const seen = new Set();
  raw.forEach((entry, index) => {
    const where = `skipped[${index}]`;
    if (!isPlainObject(entry)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} must be an object`, { path: file }));
      return;
    }
    if (!isPositiveInteger(entry.source_chapter)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} has no positive integer source_chapter`, { path: file }));
      return;
    }
    if (seen.has(entry.source_chapter)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record skips extraction chapter ${entry.source_chapter} twice`, { path: file, source_chapter: entry.source_chapter }));
      return;
    }
    seen.add(entry.source_chapter);
    if (!meaningful(entry.reason)) {
      problems.push(problem(CODE_INVALID_IMPORT, `the import record ${where} does not say why the chapter was passed over`, { path: file, source_chapter: entry.source_chapter }));
      return;
    }
    skipped.push({ source_chapter: entry.source_chapter, reason: entry.reason.trim() });
  });
  return skipped;
}

/** Load and check the import record against the extraction it claims to come from. */
export function loadRecord(universeDir, extraction) {
  const file = `${universeDir}/${RECORD_PATH}`;
  const problems = [];
  const warnings = [];
  const read = readJsonFile(file);
  if (!read.ok) {
    const code = read.kind === 'unparseable' ? CODE_UNPARSEABLE_JSON : CODE_INVALID_IMPORT;
    const message = read.kind === 'missing' ? `no ${RECORD_PATH}: this universe carries no import record` : read.message;
    return { ok: false, code, problems: [problem(code, message, { path: RECORD_PATH })], warnings, record: null };
  }
  const value = read.value;
  if (!isPlainObject(value)) {
    return { ok: false, code: CODE_INVALID_IMPORT, problems: [problem(CODE_INVALID_IMPORT, `${RECORD_PATH} must be a JSON object`, { path: RECORD_PATH })], warnings, record: null };
  }
  if (value.schema_version !== IMPORT_SCHEMA_VERSION) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} declares schema_version ${JSON.stringify(value.schema_version)}; ${IMPORT_SCHEMA_VERSION} is expected`, { path: RECORD_PATH }));
  }
  if (!identifier(value.import_id)) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} has no usable import_id`, { path: RECORD_PATH }));
  }
  if (!isPlainObject(value.source) || typeof value.source.sha256 !== 'string') {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} does not name the extraction it imported`, { path: RECORD_PATH }));
  } else if (value.source.sha256 !== extraction.source.sha256) {
    problems.push(
      problem(CODE_INVALID_IMPORT, `${RECORD_PATH} was written for another extraction: the record names ${value.source.sha256}, the supplied extraction is ${extraction.source.sha256}`, {
        path: RECORD_PATH,
      }),
    );
  }
  if (value.import_id !== extraction.import_id) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} names import ${JSON.stringify(value.import_id)}, the supplied extraction is ${extraction.import_id}`, { path: RECORD_PATH }));
  }
  if (!SEGMENTATIONS.includes(value.segmentation)) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} declares an unknown segmentation ${JSON.stringify(value.segmentation)} (use ${SEGMENTATIONS.join('/')})`, { path: RECORD_PATH }));
  }
  if (!isPositiveInteger(value.start_chapter)) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} has no positive integer start_chapter`, { path: RECORD_PATH }));
  }
  if (typeof value.complete !== 'boolean') {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} must say whether the import is complete`, { path: RECORD_PATH }));
  }
  if (value.next_source_chapter !== null && !isPositiveInteger(value.next_source_chapter)) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} has no continuation pointer`, { path: RECORD_PATH }));
  }
  if (typeof value.updated_at !== 'string' || value.updated_at.trim().length === 0) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} does not say when it was last written`, { path: RECORD_PATH }));
  }
  const language = checkLanguage(value.language, RECORD_PATH, problems);
  const entries = checkChapterEntries(value.chapters, RECORD_PATH, problems);
  const skipped = checkSkipped(value.skipped, RECORD_PATH, problems);
  let journal = null;
  if (entries) {
    journal = checkTurns(value.turns, entries, extraction.chapters, skipped, problems, warnings);
  }
  if (problems.length > 0) {
    return { ok: false, code: worstCode(problems), problems, warnings, record: null };
  }

  const first = entries[0].chapter;
  if (first !== value.start_chapter) {
    problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} starts at chapter ${value.start_chapter} but its first imported chapter is ${first}`, { path: RECORD_PATH }));
  }
  entries.forEach((entry, index) => {
    if (entry.chapter !== value.start_chapter + index) {
      problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} skips chapter ${value.start_chapter + index}`, { path: RECORD_PATH, chapter: entry.chapter }));
    }
  });
  // One extraction chapter may be cut into several chapters, but never into a hole: the segments of
  // a cut chapter are 1..k, and a chapter that was kept whole says so with a null segment.
  const bySource = new Map();
  for (const entry of entries) {
    if (!bySource.has(entry.source_chapter)) bySource.set(entry.source_chapter, []);
    bySource.get(entry.source_chapter).push(entry);
  }
  const sourceOrder = extraction.chapters.map((chapter) => chapter.number);
  for (const [sourceChapter, group] of bySource) {
    if (!sourceOrder.includes(sourceChapter)) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `${RECORD_PATH} imports extraction chapter ${sourceChapter}, which the extraction does not declare`, { path: RECORD_PATH, source_chapter: sourceChapter }),
      );
      continue;
    }
    if (group.length === 1 && group[0].segment !== null) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `${RECORD_PATH} marks chapter ${group[0].chapter} as segment ${group[0].segment} of extraction chapter ${sourceChapter}, which the extraction keeps whole`, {
          path: RECORD_PATH,
          chapter: group[0].chapter,
          source_chapter: sourceChapter,
        }),
      );
    }
    group.forEach((entry, position) => {
      if (group.length > 1 && entry.segment !== position + 1) {
        problems.push(
          problem(CODE_INVALID_IMPORT, `${RECORD_PATH} numbers the segments of extraction chapter ${sourceChapter} as ${JSON.stringify(entry.segment)} instead of ${position + 1}`, {
            path: RECORD_PATH,
            chapter: entry.chapter,
            source_chapter: sourceChapter,
          }),
        );
      }
    });
  }
  const seenSources = entries.map((entry) => sourceOrder.indexOf(entry.source_chapter));
  for (let index = 1; index < seenSources.length; index += 1) {
    if (seenSources[index] < seenSources[index - 1]) {
      problems.push(problem(CODE_INVALID_IMPORT, `${RECORD_PATH} does not import the extraction in order`, { path: RECORD_PATH, chapter: entries[index].chapter }));
      break;
    }
  }
  const skippedSources = new Set(skipped.map((entry) => entry.source_chapter));
  for (const entry of entries) {
    const source = extraction.chapters[sourceOrder.indexOf(entry.source_chapter)];
    if (source && source.words === 0) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `${RECORD_PATH} imports extraction chapter ${entry.source_chapter}, which carries no prose; a structural mark is recorded in \`skipped\``, {
          path: RECORD_PATH,
          chapter: entry.chapter,
          source_chapter: entry.source_chapter,
        }),
      );
    }
    if (skippedSources.has(entry.source_chapter)) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `${RECORD_PATH} both imports and skips extraction chapter ${entry.source_chapter}`, {
          path: RECORD_PATH,
          chapter: entry.chapter,
          source_chapter: entry.source_chapter,
        }),
      );
    }
  }
  for (const entry of skipped) {
    const index = sourceOrder.indexOf(entry.source_chapter);
    if (index < 0) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `${RECORD_PATH} skips extraction chapter ${entry.source_chapter}, which the extraction does not declare`, {
          path: RECORD_PATH,
          source_chapter: entry.source_chapter,
        }),
      );
      continue;
    }
    if (extraction.chapters[index].words > 0) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `${RECORD_PATH} skips extraction chapter ${entry.source_chapter}, which carries ${extraction.chapters[index].words} words of prose`, {
          path: RECORD_PATH,
          source_chapter: entry.source_chapter,
        }),
      );
    }
  }
  if (journal) {
    const expected = journal.next;
    const declared = value.next_source_chapter ?? null;
    if (declared !== expected) {
      problems.push(
        problem(CODE_INVALID_IMPORT, `${RECORD_PATH} continues at ${JSON.stringify(declared)} while the turns end at ${JSON.stringify(expected)}`, { path: RECORD_PATH }),
      );
    }
    if (value.complete !== (expected === null)) {
      problems.push(
        problem(
          CODE_INVALID_IMPORT,
          expected === null
            ? `${RECORD_PATH} says the import is unfinished, but every extraction chapter has been imported`
            : `${RECORD_PATH} says the import is complete, but extraction chapter ${expected} has not been imported`,
          { path: RECORD_PATH },
        ),
      );
    }
    const covered = new Set();
    for (const turn of journal.turns) {
      for (const chapter of sourceWindow(extraction.chapters, turn.from_source_chapter, turn.to_source_chapter) ?? []) {
        covered.add(chapter.number);
      }
    }
    for (const entry of skipped) {
      if (!covered.has(entry.source_chapter)) {
        problems.push(
          problem(CODE_INVALID_IMPORT, `${RECORD_PATH} skips extraction chapter ${entry.source_chapter} before any turn has reached it`, {
            path: RECORD_PATH,
            source_chapter: entry.source_chapter,
          }),
        );
      }
    }
  }
  if (problems.length > 0) {
    return { ok: false, code: worstCode(problems), problems, warnings, record: null };
  }
  return {
    ok: true,
    code: null,
    problems,
    warnings,
    record: {
      import_id: value.import_id,
      start_chapter: value.start_chapter,
      next_source_chapter: value.next_source_chapter ?? null,
      complete: value.complete === true,
      segmentation: value.segmentation,
      language,
      chapters: entries,
      skipped,
      turns: journal ? journal.turns : [],
      source_chapters: sourceOrder,
    },
  };
}
