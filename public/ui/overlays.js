/**
 * scriptaWorlds — The four overlays: i, Rewrite, Universes and Edition dialogs.
 */
import { api } from './api.js';
import { renderUniverseList } from './render/explore.js';
import { renderMenuItems } from './render/menu.js';
import { renderRequests } from './render/reader.js';
import { renderReport } from './render/report.js';
import { renderFeedback } from './render/feedback.js';
import { renderReview } from './render/review.js';
import { dom, state } from './state.js';
import { refreshDetail, upsertLive } from './universe.js';

export function rewriteTarget() {
  return state.rewrite;
}

export function openRewrite(chapterNumber) {
  const slice = state.slides.find((model) => model.kind === 'chapter' && model.number === chapterNumber);
  state.rewrite = { chapter: chapterNumber, title: slice?.title ?? null, later: null, error: null };
  openPanel('rewrite');
  renderRewrite();
}

export function renderRewrite() {
  const target = rewriteTarget();
  if (!target) return;
  dom['rewrite-title'].textContent = target.title
    ? `Rewrite chapter ${target.chapter} · ${target.title}`
    : `Rewrite chapter ${target.chapter}`;
  const error = dom['rewrite-error'];
  error.textContent = target.error ?? '';
  error.hidden = !target.error;
  const submit = dom['rewrite-submit'];
  submit.disabled = target.busy === true;
  submit.textContent = target.later ? 'Rewrite anyway' : 'Rewrite chapter';
  dom['rewrite-instructions'].disabled = target.busy === true;
}

export async function sendRewrite({ dropLater = false } = {}) {
  const target = rewriteTarget();
  if (!target || !state.universeId) return;
  const instructions = dom['rewrite-instructions'].value.trim();
  if (instructions.length < 10) {
    target.error = 'Tell me what is wrong and what should change — at least a sentence.';
    target.later = null;
    renderRewrite();
    return;
  }
  target.busy = true;
  target.error = null;
  renderRewrite();
  try {
    const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/chapters/${target.chapter}/rewrite`, {
      method: 'POST',
      body: { instructions, dropLater }
    });
    const job = payload?.job;
    if (job?.id) {
      state.requests.set(job.id, instructions);
      state.rewriteChapters.set(job.id, target.chapter);
      upsertLive({ ...job, tools: [], text: '' });
    }
    dom['rewrite-instructions'].value = '';
    state.rewrite = null;
    closePanel();
    await refreshDetail({ targetIndex: 'keep' });
  } catch (error) {
    if (error.code === 'LATER_CHAPTERS' && Array.isArray(error.laterChapters) && error.laterChapters.length) {
      target.later = error.laterChapters;
      target.error = `${error.message} Rewriting this chapter removes the later ones; the removed versions stay in the archive.`;
    } else {
      target.later = null;
      target.error = error.message;
    }
  } finally {
    const current = rewriteTarget();
    if (current) {
      current.busy = false;
      renderRewrite();
    }
  }
}

export const PANELS = ['requests', 'rewrite', 'review', 'report', 'feedback'];

export const POPUPS = ['universes', 'more', 'tabledialog'];

export function renderPanels() {
  for (const name of PANELS) dom[name].hidden = state.panel !== name;
  if (state.panel === 'requests') renderRequests();
  if (state.panel === 'rewrite') renderRewrite();
  if (state.panel === 'review') renderReview();
  if (state.panel === 'report') renderReport();
  if (state.panel === 'feedback') renderFeedback();
}

export function openPanel(name) {
  state.panel = name;
  closePopup();
  renderPanels();
}

export function closePanel() {
  if (state.panel == null) return;
  state.panel = null;
  renderPanels();
}

export function renderPopups() {
  for (const name of POPUPS) dom[name].hidden = state.popup !== name;
  dom['btn-universes'].setAttribute('aria-expanded', state.popup === 'universes' ? 'true' : 'false');
  dom['btn-more'].setAttribute('aria-expanded', state.popup === 'more' ? 'true' : 'false');
  if (state.popup === 'universes') renderUniverseList();
  if (state.popup === 'more') renderMenuItems();
}

export function openPopup(name) {
  state.popup = state.popup === name ? null : name;
  if (state.popup) closePanel();
  renderPopups();
  if (state.popup === 'universes') dom['universes-close'].focus();
  else if (state.popup === 'more') dom['btn-more'].focus();
}

export function closePopup() {
  if (state.popup == null) return;
  state.popup = null;
  renderPopups();
}

export function closeOverlays() {
  closePopup();
  closePanel();
}
