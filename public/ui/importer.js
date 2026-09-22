/**
 * scriptaWorlds — The Import tab: upload a book the team did not write here.
 *
 * A PDF or a DOCX becomes a universe of its own: the server stores the upload outside the books, extracts
 * its text without a model, and an import turn writes the chapters, canon, threads and atlas under the
 * import skill. Afterwards the book is an ordinary universe — it can be reviewed, analysed, rewritten
 * chapter by chapter and printed like one written here.
 *
 * The panel never guesses: it shows the record the server keeps (state, detected title, chapters, words,
 * warnings), it offers Continue while the import has chapters left, and it shows the refusal in the
 * server's own words when a file cannot be read.
 */
import { elem, languageLabel, state } from './state.js';
import {
  api,
  createUniverseFromImport,
  extractImport,
  readImport,
  uploadBook
} from './api.js';
import { selectUniverse } from './universe.js';

const LEAD = 'Upload a book as a PDF or a DOCX. Its text is read here, its chapters are written into a '
  + 'universe of its own, and from then on it behaves exactly like a book written here: you can review it, '
  + 'read the reports, rewrite a chapter or print an edition.';

const FORMATS = 'pdf,docx';
const POLL_MS = 1500;
const MAX_POLLS = 400;

const FORMAT_LABEL = { pdf: 'PDF', docx: 'DOCX', null: 'file' };

export function importPanel() {
  const file = elem('input', {
    className: 'import__file',
    attrs: { id: 'import-file', type: 'file', accept: '.pdf,.docx', 'aria-describedby': 'import-note' }
  });
  const title = elem('input', {
    className: 'import__field',
    attrs: { id: 'import-title', type: 'text', maxlength: '120', placeholder: 'Title of the book (optional — the file name is used when it has none)' }
  });
  const language = elem('select', {
    className: 'import__field',
    attrs: { id: 'import-language', 'aria-label': 'Language of the book' }
  });
  language.append(elem('option', { text: 'Language: as the file says', attrs: { value: '' } }));
  for (const code of ['ro', 'en', 'fr', 'de', 'es', 'it', 'pt', 'nl']) {
    language.append(elem('option', { text: languageLabel(code), attrs: { value: code } }));
  }
  return elem('section', { className: 'newpanel', attrs: { 'data-panel': 'import', id: 'import-panel' } },
    elem('p', { className: 'custom__lead', text: LEAD }),
    elem('div', { className: 'import__row' }, file),
    elem('div', { className: 'import__row' }, title, language),
    elem('div', { className: 'custom__actions' },
      elem('button', {
        className: 'btn btn--accent',
        text: 'Upload the book',
        attrs: { type: 'button', id: 'import-start' },
        on: { click: (event) => startUpload(event.currentTarget) }
      }),
      elem('button', {
        className: 'btn',
        text: 'Create the universe',
        attrs: { type: 'button', id: 'import-create', hidden: true },
        on: { click: (event) => createOrContinue(event.currentTarget) }
      })
    ),
    elem('p', { className: 'import__note', attrs: { id: 'import-note' },
      text: `Up to ${FORMATS === 'pdf,docx' ? 'a PDF or a DOCX' : FORMATS} of the size the server accepts; a scanned PDF without a text layer is refused rather than guessed at.` }),
    elem('div', { className: 'import__status', attrs: { id: 'import-status', hidden: true } }),
    elem('p', { className: 'custom__error', attrs: { id: 'import-error', hidden: true } })
  );
}

function statusBlock() {
  return document.getElementById('import-status');
}

export function renderImportError() {
  const line = document.getElementById('import-error');
  if (!line) return;
  line.textContent = state.importError ?? '';
  line.hidden = !state.importError;
}

function setError(message) {
  state.importError = message ?? null;
  renderImportError();
}

/** Draw what the server said about the current upload, in the words the record uses. */
export function renderImportStatus() {
  const block = statusBlock();
  if (!block) return;
  const record = state.importRecord;
  block.replaceChildren();
  block.hidden = record === null;
  if (!record) return;
  const lines = [];
  const stateText = {
    received: 'Uploaded; its text has not been read yet.',
    extracting: 'Reading the text of the book…',
    ready: 'The text is read.',
    error: 'The book could not be read.'
  };
  lines.push(`${record.filename} · ${FORMAT_LABEL[record.format] ?? record.format ?? 'file'} · ${Math.round((record.bytes ?? 0) / 1024)} KiB`);
  lines.push(stateText[record.state] ?? record.state);
  if (record.detected?.title) {
    lines.push(`Title: ${record.detected.title}${record.detected.title_source === 'filename' ? ' (from the uploaded name)' : ''}`);
  }
  if (Array.isArray(record.chapters) && record.chapters.length > 0) {
    lines.push(`${record.chapters.length} chapter${record.chapters.length === 1 ? '' : 's'} · ${record.words ?? 0} words`);
  }
  for (const warning of record.warnings ?? []) lines.push(warning);
  if (record.error) lines.push(record.error);
  const progress = state.importProgress;
  if (progress) {
    lines.push(`${progress.imported} of ${progress.total} chapters are in the universe${progress.complete ? ' — the import is complete' : ''}`);
    if (progress.next) lines.push(`The next turn carries the extraction chapters ${progress.next.from}–${progress.next.to}.`);
  }
  for (const line of lines) block.append(elem('p', { className: 'import__line', text: line }));

  const create = document.getElementById('import-create');
  if (create) {
    const ready = record.state === 'ready';
    create.hidden = !ready;
    create.textContent = record.universe_id
      ? (progress?.complete ? 'Open the universe' : 'Continue the import')
      : 'Create the universe';
    create.disabled = state.importBusy;
  }
  const start = document.getElementById('import-start');
  if (start) start.disabled = state.importBusy;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Upload, then follow the record until the extraction either succeeds or refuses. */
export async function startUpload(button) {
  const field = document.getElementById('import-file');
  const chosen = field?.files?.[0] ?? null;
  if (!chosen) {
    setError('Choose a PDF or a DOCX first.');
    return;
  }
  state.importBusy = true;
  setError(null);
  state.importProgress = null;
  try {
    state.importRecord = await uploadBook(chosen);
    renderImportStatus();
    if (state.importRecord.state === 'received' || state.importRecord.state === 'error') {
      state.importRecord = (await extractImport(state.importRecord.import_id)).import;
    }
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      renderImportStatus();
      if (state.importRecord.state === 'ready' || state.importRecord.state === 'error') break;
      await wait(POLL_MS);
      state.importRecord = (await readImport(state.importRecord.import_id)).import;
    }
    renderImportStatus();
    if (state.importRecord.state === 'error') setError(state.importRecord.error ?? 'The book could not be read.');
  } catch (error) {
    setError(error.message);
  } finally {
    state.importBusy = false;
    renderImportStatus();
    if (button) button.focus();
  }
}

/** Create the universe of a ready upload, or carry its next window, and follow it to the end. */
export async function createOrContinue(button) {
  const record = state.importRecord;
  if (!record?.import_id) return;
  state.importBusy = true;
  setError(null);
  try {
    if (record.universe_id && state.importProgress?.complete) {
      await selectUniverse(record.universe_id);
      return;
    }
    const title = document.getElementById('import-title')?.value?.trim() || null;
    const language = document.getElementById('import-language')?.value || null;
    let answer = await createUniverseFromImport(record.import_id, { title, language });
    let lastImported = -1;
    while (answer.turn) {
      renderImportStatus();
      // One turn at a time: the universe runs a single turn, and the next window is queued only after this
      // one has settled.
      for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
        await wait(POLL_MS);
        const detail = await api(`/api/universes/${encodeURIComponent(answer.universe.id)}`).catch(() => null);
        const running = (detail?.activeJob ? 1 : 0) + (detail?.queuedJobs?.length ?? 0);
        if (running === 0) break;
      }
      const status = await readImport(record.import_id);
      state.importProgress = status.progress ?? null;
      state.importRecord = status.import;
      renderImportStatus();
      if (state.importProgress?.complete) break;
      // A turn that added nothing will not add anything on the next try either: stop instead of queueing
      // the same window again, and say where the reason is.
      const imported = state.importProgress?.imported ?? 0;
      if (imported <= lastImported) {
        setError(`The import turn did not add a chapter. Open ${answer.universe.id} and read its last turn for the reason, then continue when it is fixed.`);
        break;
      }
      lastImported = imported;
      answer = await createUniverseFromImport(record.import_id, {});
      if (answer.turn === null) break;
    }
    const status = await readImport(record.import_id);
    state.importProgress = status.progress ?? null;
    state.importRecord = status.import;
    renderImportStatus();
    if (state.importProgress?.complete) {
      await selectUniverse(record.universe_id ?? answer.universe?.id ?? null);
    }
  } catch (error) {
    setError(error.message);
  } finally {
    state.importBusy = false;
    renderImportStatus();
  }
}
