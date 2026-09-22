// The book-import pipeline: an uploaded book becomes a universe that can be reviewed, rewritten chapter
// by chapter and exported exactly like a book written here. The upload is stored outside `universes/`,
// its text is extracted without a model, and `scripta-import` guides ALA while it writes the universe
// files. Nothing in this module writes a chapter: the text of the book reaches the store only through the
// import turn, so an import is as reviewable as a written book.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';
import { UniverseError } from './errors.mjs';
import { jobs } from './jobs.mjs';
import { createUniverse, readUniverseMeta } from './universe.mjs';
import { skillsDir, universeDir } from './paths.mjs';
import { nowIso, readJson } from './io.mjs';
import { DEFAULT_LANGUAGE, LANGUAGES } from './config.mjs';

export const IMPORT_SCHEMA = 'book-import.v1';

// An imported book has no authorial law: the text is the law. The charter says what is true of such a
// universe, so a later chapter turn or rewrite is bound by the same rule the import followed.
const IMPORT_LAW = 'This book was imported from a file the team uploaded: the text is the law, and canon records what it establishes.';
export const IMPORT_STATES = ['received', 'extracting', 'ready', 'error'];
const EXTRACTED_FILE = 'extracted.json';
const BOOK_FILE = 'book.md';

/** Uploads live beside the assessment workspace, never inside the store of books. */
export const importsRoot = () => join(config.assessmentWorkspace, 'imports');
export const importDir = (importId) => join(importsRoot(), String(importId));
const importFile = (importId) => join(importDir(importId), 'import.json');

function assertImportId(id) {
  if (typeof id !== 'string' || !/^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$/.test(id)) {
    throw new UniverseError('BAD_ID', 'Invalid import identifier.', 400);
  }
}

const newImportId = () => {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${suffix}`;
};

/**
 * Takes one uploaded book off the wire: the bytes are written to a file of their own while they are
 * hashed and counted, and the size limit is enforced while reading rather than after the whole upload
 * has been accepted. The record says what arrived, never what it means.
 */
export async function receiveImport({ stream, filename, format = null, maxBytes = config.importMaxBytes }) {
  const name = String(filename ?? '').trim();
  if (name.length === 0 || name.length > 200) {
    throw new UniverseError('IMPORT_FILENAME', 'An upload must carry a file name of at most 200 characters.', 400);
  }
  const declared = String(format ?? '').trim().toLowerCase() || null;
  if (declared && !['pdf', 'docx'].includes(declared)) {
    throw new UniverseError('IMPORT_UNSUPPORTED', 'A book is uploaded as a PDF or a DOCX.', 400);
  }
  const importId = newImportId();
  const dir = importDir(importId);
  await mkdir(dir, { recursive: true });
  const extension = declared ?? (name.toLowerCase().endsWith('.pdf') ? 'pdf' : name.toLowerCase().endsWith('.docx') ? 'docx' : 'bin');
  const path = join(dir, `source.${extension}`);
  const hash = createHash('sha256');
  let bytes = 0;
  let refused = null;
  await new Promise((resolve, reject) => {
    const out = createWriteStream(path);
    const fail = (error) => {
      out.destroy();
      reject(error);
    };
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        refused = new UniverseError(
          'IMPORT_TOO_LARGE',
          `A book may be up to ${Math.floor(maxBytes / (1024 * 1024))} MB; this upload passed that while it was still arriving.`,
          413
        );
        stream.destroy();
        fail(refused);
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) stream.pause();
    });
    out.on('drain', () => stream.resume());
    stream.on('error', fail);
    stream.on('end', () => out.end());
    out.on('error', fail);
    out.on('close', resolve);
  }).catch(async (error) => {
    await unlink(path).catch(() => {});
    if (error instanceof UniverseError) throw error;
    throw new UniverseError('IMPORT_UNREADABLE', `The upload could not be stored: ${error.message}`, 400);
  });
  if (bytes === 0) {
    await unlink(path).catch(() => {});
    throw new UniverseError('IMPORT_EMPTY', 'The upload was empty.', 400);
  }
  // The extension decides which extractor will read the file; a format the extractors do not support is
  // refused when the extraction starts, with the code the reader sees.
  const detectedFormat = extension === 'pdf' || extension === 'docx' ? extension : null;
  const record = {
    schema_version: IMPORT_SCHEMA,
    import_id: importId,
    filename: name,
    format: detectedFormat,
    sha256: hash.digest('hex'),
    bytes,
    state: 'received',
    source: `source.${extension}`,
    created_at: nowIso(),
    extracted_at: null,
    universe_id: null,
    detected: null,
    chapters: null,
    warnings: [],
    error: null
  };
  await writeFile(importFile(importId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export async function readImport(importId) {
  assertImportId(importId);
  const record = await readJson(importFile(importId), null);
  if (!record) throw new UniverseError('NOT_FOUND', `Import ${importId} does not exist.`, 404);
  return record;
}

export async function listImports() {
  const entries = await readdir(importsRoot(), { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = await readJson(importFile(entry.name), null);
    if (record) records.push(record);
  }
  return records.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/**
 * Reads the uploaded book and writes what it found beside the upload. Extraction is deterministic: the
 * same file always yields the same text, which is what the import turn, the analysis and a later rewrite
 * all work from.
 */
export async function extractImport(importId) {
  const record = await readImport(importId);
  const dir = importDir(importId);
  if (record.state === 'ready') return record;
  const path = join(dir, record.source);
  const failed = await stat(path).then(() => null, () => 'missing');
  if (failed) {
    const broken = { ...record, state: 'error', error: 'the uploaded file is gone from the workspace' };
    await writeFile(importFile(importId), `${JSON.stringify(broken, null, 2)}\n`, 'utf8');
    throw new UniverseError('IMPORT_MISSING', 'The uploaded file is no longer in the workspace.', 410);
  }
  await writeFile(importFile(importId), `${JSON.stringify({ ...record, state: 'extracting' }, null, 2)}\n`, 'utf8');
  try {
    // The extractor is loaded when a book is actually read: it is the heaviest module in the pipeline and
    // only the extraction path needs it.
    const { extractBook } = await import('./import.mjs');
    const extracted = await extractBook({ path, filename: record.filename, format: record.format, maxBytes: config.importMaxBytes });
    const chapters = extracted.chapters.map((chapter) => ({
      number: chapter.number,
      title: chapter.title ?? null,
      words: chapter.words ?? String(chapter.text ?? '').split(/\s+/).filter(Boolean).length
    }));
    // The extraction the import reads names the book and carries the identity of this upload. A file that
    // names itself keeps its title; a file that does not is named by the name the reader gave it, and the
    // document says which of the two it is instead of passing one off as the other.
    const detectedTitle = String(extracted.detected?.title ?? '').trim();
    const titleFromFile = detectedTitle.length > 0;
    const staged = {
      ...extracted,
      schema_version: IMPORT_SCHEMA,
      import_id: record.import_id,
      source: {
        ...(extracted.source ?? {}),
        filename: record.filename,
        format: record.format,
        sha256: record.sha256,
        bytes: record.bytes
      },
      detected: {
        ...(extracted.detected ?? {}),
        title: (titleFromFile ? detectedTitle : record.filename.replace(/\.[^.]+$/, '')).slice(0, 200),
        title_source: titleFromFile ? 'file' : 'filename'
      }
    };
    await writeFile(join(dir, EXTRACTED_FILE), `${JSON.stringify(staged)}\n`, 'utf8');
    await writeFile(
      join(dir, BOOK_FILE),
      staged.chapters
        .map((chapter) => `## ${chapter.number}. ${chapter.title ?? ''}`.trimEnd() + `\n\n${chapter.text}\n`)
        .join('\n'),
      'utf8'
    );
    const ready = {
      ...record,
      state: 'ready',
      extracted_at: nowIso(),
      detected: staged.detected,
      chapters,
      words: chapters.reduce((total, chapter) => total + chapter.words, 0),
      warnings: Array.isArray(extracted.warnings) ? extracted.warnings : [],
      error: null
    };
    await writeFile(importFile(importId), `${JSON.stringify(ready, null, 2)}\n`, 'utf8');
    return ready;
  } catch (error) {
    const broken = {
      ...record,
      state: 'error',
      error: error instanceof UniverseError ? `${error.code}: ${error.message}` : String(error?.message ?? error)
    };
    await writeFile(importFile(importId), `${JSON.stringify(broken, null, 2)}\n`, 'utf8');
    throw error;
  }
}

/** The extraction of one import as the import turn reads it, or `NOT_FOUND` when it is not ready. */
export async function readExtracted(importId) {
  const record = await readImport(importId);
  const extracted = await readJson(join(importDir(importId), EXTRACTED_FILE), null);
  if (!extracted) {
    throw new UniverseError(
      'NOT_EXTRACTED',
      record.state === 'error' ? `The extraction failed for this import (${record.error}).` : 'The uploaded book has not been extracted yet.',
      409
    );
  }
  return extracted;
}

/** Copy the extraction into a universe so the import turn reads it from inside its own folder. */
export async function stageExtractionForUniverse(universeDir, importId) {
  const extracted = await readExtracted(importId);
  const dir = join(universeDir, '.agents', 'import');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, EXTRACTED_FILE), `${JSON.stringify(extracted)}\n`, 'utf8');
  await writeFile(
    join(dir, BOOK_FILE),
    extracted.chapters
      .map((chapter) => `## ${chapter.number}. ${chapter.title ?? ''}`.trimEnd() + `\n\n${chapter.text}\n`)
      .join('\n'),
    'utf8'
  );
  return { dir, extracted, file: join(dir, EXTRACTED_FILE), book: join(dir, BOOK_FILE) };
}

/**
 * The import contract the skill publishes: where the record lives, how much one turn may carry, and which
 * chapter the import continues at. The skill owns these rules — its validator refuses a turn that breaks
 * them — so the host reads them instead of keeping a second copy that could drift.
 */
export async function loadImportContract(skillsDir) {
  const path = join(skillsDir, 'scripta-import', 'schema', 'import.v1.json');
  const raw = await readJson(path, null);
  const limits = raw?.turn_limits;
  if (!raw || !raw.record?.path || !Number.isInteger(limits?.max_chapters) || !Number.isInteger(limits?.max_words)) {
    throw new UniverseError('IMPORT_CONTRACT_MISSING', `The import skill does not publish its contract (${path}).`, 500);
  }
  return {
    recordPath: String(raw.record.path),
    limits: { maxChapters: limits.max_chapters, maxWords: limits.max_words }
  };
}

/**
 * The window one import turn may cover, exactly as the skill plans it: at most `maxChapters` extraction
 * chapters and at most `maxWords` of their prose, whichever comes first, and always at least one chapter
 * so that a turn is never empty. The window is what keeps a long book importable in bounded steps.
 */
export function planTurnWindow(chapters, fromSourceChapter, limits) {
  const ordered = [...(chapters ?? [])].sort((a, b) => a.number - b.number);
  const start = ordered.findIndex((chapter) => chapter.number === fromSourceChapter);
  if (start < 0) return null;
  const window = [];
  let words = 0;
  for (let index = start; index < ordered.length; index += 1) {
    const chapter = ordered[index];
    const size = Number.isInteger(chapter.words) && chapter.words > 0
      ? chapter.words
      : String(chapter.text ?? '').split(/\s+/).filter(Boolean).length;
    if (window.length >= limits.maxChapters) break;
    if (window.length > 0 && words + size > limits.maxWords) break;
    window.push({ ...chapter, words: size });
    words += size;
  }
  if (window.length === 0) return null;
  return {
    from: window[0].number,
    to: window[window.length - 1].number,
    chapters: window,
    words
  };
}

/**
 * Where the import stands, read from the record the import skill keeps in the universe. That record is the
 * only place a later turn learns where to continue: a chapter file does not carry the number of the
 * extraction chapter it came from, so the store alone cannot say what has been imported.
 */
export async function readImportProgress(universeDir, contract) {
  const record = await readJson(join(universeDir, contract.recordPath), null);
  const imported = Array.isArray(record?.chapters) ? record.chapters.length : 0;
  return {
    imported,
    nextSourceChapter: Number.isInteger(record?.next_source_chapter) ? record.next_source_chapter : null,
    complete: record?.complete === true,
    record
  };
}

/** The next window of an import: the first unimported chapter when no record exists yet. */
export async function nextImportStep({ skillsDir, universeDir, extracted }) {
  const contract = await loadImportContract(skillsDir);
  const progress = await readImportProgress(universeDir, contract);
  const chapters = [...(extracted?.chapters ?? [])].sort((a, b) => a.number - b.number);
  if (chapters.length === 0) {
    return { contract, progress, window: null, complete: true };
  }
  if (progress.complete) {
    return { contract, progress, window: null, complete: true };
  }
  const from = progress.nextSourceChapter ?? chapters[0].number;
  const window = planTurnWindow(chapters, from, contract.limits);
  return { contract, progress, window, complete: window === null };
}

/** What the interface reports about one import: how much of the book is in the store, and what is next. */
export function importProgress(extracted, step) {
  const total = (extracted?.chapters ?? []).length;
  const imported = step?.progress?.imported ?? 0;
  return {
    total,
    imported,
    complete: step ? step.complete === true : imported >= total,
    next: step?.window ? { from: step.window.from, to: step.window.to, chapters: step.window.chapters.length } : null
  };
}

/**
 * Turn an extracted upload into a universe: the store is created for it, the extraction is copied into
 * the universe so the import turn reads it from inside its own folder, and the first bounded import turn
 * is queued. A second call continues where the store says the import stopped, so a long book is imported
 * step by step and every step is a turn the reader can watch, retry or refuse.
 */
export async function createUniverseFromImport({ importId, title = null, language = null }) {
  const record = await readImport(importId);
  if (!record.universe_id) {
    const extracted = await readExtracted(importId);
    const name = String(title ?? extracted.detected?.title ?? record.filename.replace(/\.[^.]+$/, '')).trim().slice(0, 120);
    const chosen = String(language ?? extracted.detected?.language ?? DEFAULT_LANGUAGE).slice(0, 2).toLowerCase();
    const universe = await createUniverse({
      title: name,
      law: IMPORT_LAW,
      premise: '',
      language: LANGUAGES.includes(chosen) ? chosen : DEFAULT_LANGUAGE
    });
    await stageExtractionForUniverse(universeDir(universe.id), importId);
    const updated = {
      ...record,
      universe_id: universe.id,
      state: 'ready',
      detected: { ...(record.detected ?? {}), title: name },
      warnings: [
        ...(record.warnings ?? []),
        `imported into ${universe.id} as ${chaptersSummary(extracted)}`
      ]
    };
    await writeFile(importFile(importId), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    return startNextImportTurn({ importId, universeId: universe.id, universe, extracted });
  }
  const universe = await readUniverseMeta(record.universe_id);
  const extracted = await readExtracted(importId);
  const staged = await stageExtractionForUniverse(universeDir(record.universe_id), importId);
  return startNextImportTurn({ importId, universeId: record.universe_id, universe, extracted: staged.extracted ?? extracted });
}

const chaptersSummary = (extracted) => {
  const count = (extracted?.chapters ?? []).length;
  return `${count} chapter${count === 1 ? '' : 's'}`;
};

/** Queue the next window, or report that nothing is left to import. */
async function startNextImportTurn({ importId, universeId, universe, extracted }) {
  const step = await nextImportStep({ skillsDir, universeDir: universeDir(universeId), extracted });
  const progress = importProgress(extracted, step);
  if (!step.window) {
    return { universe, turn: null, range: null, progress };
  }
  const info = {
    totalChapters: (extracted?.chapters ?? []).length,
    detected: extracted?.detected ?? null,
    warnings: Array.isArray(extracted?.warnings) ? extracted.warnings : []
  };
  const range = { from: step.window.from, to: step.window.to };
  const turn = await jobs.startImport({ universeId, importId, range, info });
  return { universe, turn, range, progress };
}

export async function readImportStatus(importId) {
  const record = await readImport(importId);
  if (!record.universe_id) return { import: record, progress: null };
  const extracted = await readJson(join(importDir(importId), EXTRACTED_FILE), null);
  if (!extracted) return { import: record, progress: null };
  try {
    const step = await nextImportStep({ skillsDir, universeDir: universeDir(record.universe_id), extracted });
    return { import: record, progress: importProgress(extracted, step) };
  } catch (error) {
    return { import: record, progress: null, contract_error: error.message };
  }
}
