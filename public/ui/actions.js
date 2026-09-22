/**
 * scriptaWorlds — Reader actions: send, retry, create, explore.
 */
import { api, loadUniverses } from './api.js';
import { showError } from './errors.js';
import { closePanel } from './overlays.js';
import { autosize, setComposerError } from './render/composer.js';
import { renderCustomError } from './render/custom.js';
import { ingredientPayload } from './render/ingredients.js';
import { renderMenuItems } from './render/menu.js';
import { render } from './render/reader.js';
import { resetAssessmentState } from './review.js';
import { openJobStream, stopEvents } from './sse.js';
import { dom, state } from './state.js';
import { refreshDetail, selectUniverse, upsertLive } from './universe.js';

export function openExploration() {
  stopEvents();
  resetAssessmentState();
  state.universeId = null;
  state.universe = null;
  state.detail = null;
  state.slides = [];
  state.index = 0;
  state.panel = null;
  state.notice = null;
  state.requestChapter = null;
  state.rewrite = null;
  state.chapters.clear();
  state.expanded.clear();
  const url = new URL(window.location.href);
  url.searchParams.delete('universe');
  try {
    window.history.replaceState(null, '', url);
  } catch { /* history unavailable */ }
  render();
  dom.input.focus();
}

/* ------------------------------------------------------------- header */

export async function submitRequest(message, { kind = 'chapter', format = null, stay = false, close = false } = {}) {
  if (close) closePanel();
  const text = String(message ?? '').trim();
  if (!text) return;
  if (!state.universeId) {
    showError('Pick a universe or start a new one first — your text stays in the field.');
    return;
  }
  const current = state.slides?.[state.index] ?? null;
  const sourceChapter = current?.kind === 'chapter' ? current.number : null;
  try {
    const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/turns`, {
      method: 'POST',
      body: kind === 'export'
        ? { message: text, kind, format: format ?? 'both' }
        : { message: text, kind, ...(sourceChapter === null ? {} : { sourceChapter }) }
    });
    const job = payload?.job;
    if (job?.id) {
      state.requests.set(job.id, text);
      upsertLive({ ...job, tools: [], text: '' });
      if (state.events?.mode === 'fallback') openJobStream(job.id);
    }
    state.errors = [];
    if (!stay) {
      dom.input.value = '';
      autosize();
    }
    await refreshDetail({ targetIndex: 'end' });
    renderMenuItems();
  } catch (error) {
    showError(error.message);
  }
}

export async function sendFromInput() {
  const text = dom.input.value.trim();
  if (!text) return;
  dom.send.disabled = true;
  try {
    if (!state.universeId) await createFromField(text);
    else await submitRequest(text);
  } finally {
    dom.send.disabled = false;
  }
}

/**
 * `Start` in the Custom tab: the text of the large field is the specification of a new universe, so
 * it is validated here, sent as the law, and the field is cleared once the universe exists. The
 * refusal line lives under that field rather than under the composer, because that is where the
 * reader is looking.
 */
export async function startFromSpec(button = null) {
  const text = String(state.customSpec ?? '').trim();
  if (text.length < 24) {
    state.customError = 'Describe the world in at least one sentence — that text becomes its law.';
    renderCustomError();
    return;
  }
  state.customError = null;
  renderCustomError();
  const control = button ?? document.getElementById('custom-start');
  if (control) control.disabled = true;
  try {
    const created = await createFromField(text, {
      onError: (message) => {
        state.customError = message;
        renderCustomError();
      }
    });
    if (created) {
      state.customSpec = '';
      const field = document.getElementById('custom-spec');
      if (field) field.value = '';
    }
  } finally {
    if (control) control.disabled = false;
  }
}

// With no universe open, Send builds one: the picked template, the chosen ingredients, or
// just the text (which the server treats as the law). Nothing is created before this point.
async function createFromField(text, { onError = null } = {}) {
  const elements = ingredientPayload();
  const body = {
    prompt: text,
    language: state.language ?? state.config.languages[0]?.code ?? 'en',
    start: true,
    ...(state.libraryPick ? { library: state.libraryPick.slug } : {}),
    ...(elements.length ? { elements } : {})
  };
  setComposerError(null);
  try {
    const payload = await api('/api/universes', { method: 'POST', body });
    state.ingredients = [];
    state.libraryPick = null;
    state.libraryEntry = null;
    dom.input.value = '';
    autosize();
    await loadUniverses();
    const id = payload?.universe?.id;
    const job = payload?.job;
    if (job?.id) {
      state.requests.set(job.id, text);
      upsertLive({ ...job, tools: [], text: '' });
    }
    if (id) await selectUniverse(id, { targetIndex: 'end' });
    else await refreshDetail({ targetIndex: 'keep' });
    return true;
  } catch (error) {
    // The field keeps the text; the line under it says what the server refused.
    if (onError) onError(error.message);
    else setComposerError(error.message);
    return false;
  }
}

export async function retryTurn(number, button) {
  if (!state.universeId || number == null) return;
  button.disabled = true;
  try {
    const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/turns/${number}/retry`, { method: 'POST' });
    const job = payload?.job;
    if (job?.id) {
      const slice = state.slides.find((model) => model.turnNumber === number);
      state.requests.set(job.id, slice?.request ?? 'Retry this chapter');
      upsertLive({ ...job, tools: [], text: '' });
    }
    await refreshDetail({ targetIndex: 'keep' });
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------ events */
