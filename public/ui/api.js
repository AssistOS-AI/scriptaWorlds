/**
 * scriptaWorlds — Every HTTP call the interface makes.
 */
import { renderFooter } from './render/composer.js';
import { FALLBACK_LANGUAGES, state } from './state.js';

export async function api(path, { method = 'GET', body } = {}) {
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
  return payload;
}

/* ------------------------------------------------------- in-thread errors */

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
