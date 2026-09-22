// The whole check: the extraction, the import record, the chapter set and the state files, in that
// order, reported as one envelope.
//
// The extraction and the record are read first and on their own, because neither the chapters nor
// the state files can be judged without knowing which book was imported and how far it has come.
// Everything after them is reported together: an operator wants the whole defect list of one turn,
// not the first one.

import { checkChapters, scanChapterFiles } from './chapters.mjs';
import { loadExtraction } from './extraction.mjs';
import { VALIDATION_SCHEMA_VERSION } from './limits.mjs';
import { worstCode } from './problems.mjs';
import { loadRecord } from './record.mjs';
import { checkState } from './state.mjs';

function envelope(base) {
  return {
    schema_version: VALIDATION_SCHEMA_VERSION,
    ok: false,
    code: null,
    errors: [],
    warnings: [],
    ...base,
  };
}

function format(entries) {
  return entries.map((entry) => `${entry.code}: ${entry.message}`);
}

/**
 * Validate a universe after one import turn.
 *
 *   universeDir    the folder of the universe
 *   extractionPath the host's `extracted.json`
 *   range          `{ from, to }` to check only the chapters one turn wrote, or null for all of them
 */
export function validateImport({ universeDir, extractionPath, range = null }) {
  const loaded = loadExtraction(extractionPath);
  if (!loaded.ok) {
    return envelope({
      code: loaded.code,
      universe: universeDir,
      extraction: extractionPath,
      errors: format(loaded.problems),
      warnings: format(loaded.warnings),
    });
  }
  const extraction = loaded.extraction;

  const recordResult = loadRecord(universeDir, extraction);
  if (!recordResult.ok) {
    return envelope({
      code: recordResult.code,
      universe: universeDir,
      extraction: extractionPath,
      import_id: extraction.import_id,
      errors: format(recordResult.problems),
      warnings: format([...loaded.warnings, ...recordResult.warnings]),
    });
  }
  const record = recordResult.record;

  const chapterResult = checkChapters({ universeDir, extraction, record, range });
  let highestChapter = record.chapters[record.chapters.length - 1].chapter;
  for (const [number] of scanChapterFiles(universeDir)) {
    if (number > highestChapter) highestChapter = number;
  }
  const stateResult = checkState({ universeDir, record, highestChapter });

  const problems = [...chapterResult.problems, ...stateResult.problems];
  const warnings = [...loaded.warnings, ...recordResult.warnings, ...chapterResult.warnings, ...stateResult.warnings];

  return envelope({
    ok: problems.length === 0,
    code: worstCode(problems),
    universe: universeDir,
    extraction: extractionPath,
    import_id: record.import_id,
    source: { filename: extraction.source.filename, sha256: extraction.source.sha256 },
    segmentation: record.segmentation,
    start_chapter: record.start_chapter,
    last_imported_chapter: record.chapters[record.chapters.length - 1].chapter,
    range: range ? `${range.from}-${range.to}` : null,
    complete: record.complete,
    next_source_chapter: record.next_source_chapter,
    chapters_checked: chapterResult.checked.length,
    words_checked: chapterResult.words,
    errors: format(problems),
    warnings: format(warnings),
  });
}
