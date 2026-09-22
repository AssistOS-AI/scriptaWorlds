/**
 * scriptaWorlds — Every HTTP call the interface makes.
 */
import { renderFooter } from './render/composer.js';
import { FALLBACK_LANGUAGES, state } from './state.js';

/**
 * The single network helper. `text: true` returns the body unparsed, which is what a published view
 * of a review is (Markdown); every other call answers parsed JSON. A failed response throws an error
 * carrying the server's `code` and `status`.
 */
export async function api(path, { method = 'GET', body, text = false } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `Request failed (${response.status}).`);
    error.code = payload?.error?.code ?? null;
    error.status = response.status;
    throw error;
  }
  return text ? raw : payload;
}

/* ------------------------------------------------------- in-thread errors */

/**
 * Send one uploaded book to the server as the file itself. The name travels in a header, so a file with
 * spaces or non-ASCII characters needs no query encoding, and the server hashes and bounds the bytes while
 * they stream in rather than after they arrived.
 */
export async function uploadBook(file) {
  const response = await fetch('/api/imports', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': file.name },
    body: file
  });
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `The upload failed (${response.status}).`);
    error.code = payload?.error?.code ?? null;
    error.status = response.status;
    throw error;
  }
  return payload?.import ?? null;
}

export const listImports = () => api('/api/imports');
export const readImport = (importId) => api(`/api/imports/${encodeURIComponent(importId)}`);
export const extractImport = (importId) => api(`/api/imports/${encodeURIComponent(importId)}/extract`, { method: 'POST', body: {} });
export const createUniverseFromImport = (importId, body = {}) =>
  api(`/api/imports/${encodeURIComponent(importId)}/universe`, { method: 'POST', body });

export async function loadConfig() {
  try {
    const payload = await api('/api/config');
    const languages = Array.isArray(payload?.languages) && payload.languages.length
      ? payload.languages.filter((entry) => entry?.code)
      : FALLBACK_LANGUAGES;
    const formats = Array.isArray(payload?.formats) && payload.formats.length ? payload.formats : ['docx', 'pdf', 'both'];
    state.config = { languages, formats, degraded: false };
  } catch {
    state.config = { languages: FALLBACK_LANGUAGES, formats: ['docx', 'pdf', 'both'], degraded: true };
  }
}

export async function loadUniverses() {
  const payload = await api('/api/universes');
  state.universes = Array.isArray(payload?.universes) ? payload.universes : [];
}

export async function loadIdeas(force = false) {
  const id = state.universeId;
  if (!id) return [];
  if (!force && state.ideas.has(id)) return state.ideas.get(id);
  if (state.ideasPending) return state.ideas.get(id) ?? [];
  state.ideasPending = true;
  try {
    const payload = await api(`/api/universes/${encodeURIComponent(id)}/ideas`);
    state.ideas.set(id, Array.isArray(payload?.ideas) ? payload.ideas : []);
  } catch {
    state.ideas.set(id, []);
  } finally {
    state.ideasPending = false;
  }
  if (state.universeId === id) {
    renderFooter();
  }
  return state.ideas.get(id);
}

export async function loadTurn(number) {
  if (state.turns.has(number)) return state.turns.get(number);
  const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/turns/${number}`);
  state.turns.set(number, payload?.turn ?? null);
  return payload?.turn ?? null;
}

// The table of ideas (12 families × 15 operators = 180 cells), loaded once.
export async function loadTable() {
  if (state.table) return state.table;
  const payload = await api('/api/table');
  state.table = {
    families: payload?.families ?? [],
    operators: payload?.operators ?? [],
    elements: payload?.elements ?? []
  };
  return state.table;
}

// The library of templates (75 worlds from the book), loaded once.
export async function loadLibrary() {
  if (state.library) return state.library;
  const payload = await api('/api/library');
  state.library = Array.isArray(payload?.templates) ? payload.templates : [];
  return state.library;
}

// One template, with the request text the reader will edit.
export async function loadLibraryEntry(slug) {
  const payload = await api(`/api/library/${encodeURIComponent(slug)}`);
  return payload?.template ?? null;
}

// One cell of the table, with the distilled page behind it: the idea, what a change of that family does to a world, the work it appears in and the worlds that use it.
export async function loadTableCell(symbol) {
  const payload = await api(`/api/table/cells/${encodeURIComponent(symbol)}`);
  return payload?.cell ?? null;
}

/* ------------------------------------------- reviews (assessments, §8.5) */

// The runs of the open book, newest first, with the arc-completion events that were declared against
// it. `force` re-reads them; the list is cached because the reader opens the panel often.
export async function loadAssessments(force = false) {
  const id = state.universeId;
  if (!id) return { runs: [], arcEvents: [] };
  if (!force && state.runsLoaded) return { runs: state.runs, arcEvents: state.arcEvents };
  const payload = await api(`/api/universes/${encodeURIComponent(id)}/assessments`);
  if (state.universeId !== id) return { runs: [], arcEvents: [] };
  state.runs = Array.isArray(payload?.runs) ? payload.runs : [];
  state.arcEvents = Array.isArray(payload?.arcEvents) ? payload.arcEvents : [];
  state.runsLoaded = true;
  return { runs: state.runs, arcEvents: state.arcEvents };
}

// One review of one version: `historical` is true when a later accepted version exists.
export async function loadAssessmentRun(runId) {
  const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/assessments/${encodeURIComponent(runId)}`);
  return payload?.run ?? null;
}

export async function startAssessment(body) {
  const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/assessments`, { method: 'POST', body });
  return payload?.run ?? null;
}

export async function sendAssessmentAction(runId, action) {
  const payload = await api(
    `/api/universes/${encodeURIComponent(state.universeId)}/assessments/${encodeURIComponent(runId)}`,
    { method: 'POST', body: { action } }
  );
  return payload?.run ?? null;
}

// One published file of a run. `text` is on, because the views are Markdown and the bundle is the only
// JSON the interface parses: the route serves exactly the names the run lists in `outputs`.
export async function loadReportFile(runId, name, { text = true } = {}) {
  const path = `/api/universes/${encodeURIComponent(state.universeId)}/assessments/${encodeURIComponent(runId)}/report/${encodeURIComponent(name)}`;
  return text ? api(path, { text: true }) : api(path);
}

export function reportFileUrl(runId, name) {
  return `/api/universes/${encodeURIComponent(state.universeId)}/assessments/${encodeURIComponent(runId)}/report/${encodeURIComponent(name)}`;
}

/* -------------------------------------------- reader feedback (§8.7) */

// The responses of the open book, newest first, with the frozen targets they answer and the counts the
// team reads. `force` re-reads them; the list is cached because both surfaces of the feedback dialog
// show it.
export async function loadFeedback(force = false) {
  const empty = { feedback: [], targets: [], counts: null };
  const id = state.universeId;
  if (!id) return empty;
  if (!force && state.feedbackLoaded) {
    return { feedback: state.responses, targets: state.feedbackTargets, counts: state.feedbackCounts };
  }
  const payload = await api(`/api/universes/${encodeURIComponent(id)}/feedback`);
  if (state.universeId !== id) return empty;
  state.responses = Array.isArray(payload?.feedback) ? payload.feedback : [];
  state.feedbackTargets = Array.isArray(payload?.targets) ? payload.targets : [];
  state.feedbackCounts = payload?.counts ?? null;
  state.feedbackLoaded = true;
  return { feedback: state.responses, targets: state.feedbackTargets, counts: state.feedbackCounts };
}

// Freeze the accepted version of the displayed book (or of an arc, or of one chapter) as a reading
// target, or open the target that already exists for that version and scope: the identifier is derived
// from both, so two readers of the same text answer the same frozen copy.
export async function freezeFeedbackTarget(body) {
  const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/feedback/targets`, { method: 'POST', body });
  return { target: payload?.target ?? null, deduplicated: payload?.deduplicated === true };
}

export async function readFeedbackTarget(targetId) {
  const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/feedback/targets/${encodeURIComponent(targetId)}`);
  return payload?.target ?? null;
}

// One reader's response. `feedbackId` is optional: when the caller names one, a retried submission is
// answered with the entry that exists instead of writing a second one.
export async function submitReaderFeedback(body) {
  const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/feedback`, { method: 'POST', body });
  return { feedback: payload?.feedback ?? null, deduplicated: payload?.deduplicated === true };
}

export async function withdrawReaderFeedback(feedbackId) {
  const payload = await api(
    `/api/universes/${encodeURIComponent(state.universeId)}/feedback/${encodeURIComponent(feedbackId)}`,
    { method: 'POST', body: { action: 'withdraw' } }
  );
  return payload?.feedback ?? null;
}

// The identities of the team that read this book: a response is attributed to one of them, and a
// response whose reader is not in this list is shown by identifier alone.
export async function loadFeedbackReaders(force = false) {
  const id = state.universeId;
  if (!id) return [];
  if (!force && state.readersLoaded) return state.readers;
  const payload = await api(`/api/universes/${encodeURIComponent(id)}/readers`);
  if (state.universeId !== id) return [];
  state.readers = Array.isArray(payload?.readers) ? payload.readers : [];
  state.readersLoaded = true;
  return state.readers;
}

export async function createFeedbackReader(displayName) {
  const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/readers`, { method: 'POST', body: { displayName } });
  return payload?.reader ?? null;
}

export async function renameFeedbackReader(readerId, displayName) {
  const payload = await api(
    `/api/universes/${encodeURIComponent(state.universeId)}/readers/${encodeURIComponent(readerId)}`,
    { method: 'POST', body: { displayName } }
  );
  return payload?.reader ?? null;
}
