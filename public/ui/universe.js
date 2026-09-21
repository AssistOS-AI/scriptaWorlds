/**
 * scriptaWorlds — Choosing a universe, refreshing its detail, tracking its jobs.
 */
import { api, loadIdeas } from './api.js';
import { showError } from './errors.js';
import { closeOverlays, renderPanels, renderPopups } from './overlays.js';
import { renderFooter } from './render/composer.js';
import { renderUniverseList } from './render/explore.js';
import { renderHeader } from './render/header.js';
import { renderMenuItems } from './render/menu.js';
import { renderTrack } from './render/reader.js';
import { applyTransform, buildSlides, ensureChapterMarkdown, renderChapNav, updateNav } from './slides.js';
import { stopEvents, syncEvents, unwatchJob, watchJob } from './sse.js';
import { LIVE_STATUSES, UNIVERSE_KEY, chapterKey, clamp, dom, state } from './state.js';

export async function selectUniverse(id, { initial = false, targetIndex = null } = {}) {
  state.universeId = id;
  state.universe = state.universes.find((entry) => entry.id === id) ?? null;
  try {
    localStorage.setItem(UNIVERSE_KEY, id);
  } catch { /* localStorage unavailable */ }
  const url = new URL(window.location.href);
  if (url.searchParams.get('universe') !== id) {
    url.searchParams.set('universe', id);
    try {
      window.history.replaceState(null, '', url);
    } catch { /* history unavailable */ }
  }
  stopEvents();
  state.live.clear();
  state.watched.clear();
  state.requests.clear();
  state.chapters.clear();
  state.turns.clear();
  state.ideas.delete(id);
  state.errors = [];
  state.expanded.clear();
  state.notice = null;
  state.requestChapter = null;
  state.rewrite = null;
  state.rewriteChapters.clear();
  state.slides = [];
  state.index = 0;
  state.panel = null;
  dom.track.replaceChildren();
  try {
    await refreshDetail({
      targetIndex: targetIndex ?? (initial ? readStoredIndex(id) : 'end')
    });
  } catch (error) {
    showError(error.message);
    renderTrack();
  }
  syncEvents();
  closeOverlays();
  renderPanels();
  renderPopups();
  renderHeader();
  renderUniverseList();
}

export let refreshChain = Promise.resolve();

export function refreshDetail(options) {
  const run = refreshChain.then(() => doRefreshDetail(options));
  refreshChain = run.catch(() => {});
  return run;
}

export async function doRefreshDetail({ targetIndex = 'keep' } = {}) {
  if (!state.universeId) return;
  const previousChapters = state.slides.filter((slice) => slice.kind === 'chapter').length;
  const previousCount = state.slides.length;
  const previousIndex = state.index;
  const wasAtEnd = previousCount === 0 || previousIndex >= previousCount - 1;
  const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}`);
  state.detail = payload;
  state.universe = payload.universe ?? state.universe;
  registerJobs(payload);
  const models = buildSlides();
  await ensureChapterMarkdown(models);
  state.slides = models;
  pruneLive();
  const chapterCount = models.filter((slice) => slice.kind === 'chapter').length;
  const lastChapterIndex = models.reduce((last, slice, index) => (slice.kind === 'chapter' ? index : last), -1);
  if (typeof targetIndex === 'number') state.index = clamp(targetIndex, 0, models.length - 1);
  else if (targetIndex === 'end') state.index = lastChapterIndex >= 0 ? lastChapterIndex : Math.max(0, models.length - 1);
  else if (wasAtEnd) state.index = lastChapterIndex >= 0 ? lastChapterIndex : Math.max(0, models.length - 1);
  else state.index = clamp(previousIndex, 0, Math.max(0, models.length - 1));
  if (chapterCount > previousChapters && previousChapters > 0 && !wasAtEnd && targetIndex === 'keep') {
    state.notice = { chapter: models[lastChapterIndex]?.number ?? chapterCount, index: lastChapterIndex };
  }
  renderTrack();
  renderChapNav();
  renderHeader();
  renderFooter();
  applyTransform();
  updateNav();
  renderUniverseList();
  renderMenuItems();
  saveIndex();
  state.ideas.delete(state.universeId);
  loadIdeas().catch(() => {});
}

export function readStoredIndex(id) {
  try {
    const raw = localStorage.getItem(chapterKey(id));
    if (raw == null) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveIndex() {
  if (!state.universeId) return;
  try {
    localStorage.setItem(chapterKey(state.universeId), String(state.index));
  } catch { /* localStorage unavailable */ }
}

/* ----------------------------------------------------------------- jobs */

export function upsertLive(job) {
  if (!job?.id) return { created: false };
  const previous = state.live.get(job.id) ?? {};
  const next = { ...previous, ...job, tools: previous.tools ?? [], text: previous.text ?? '' };
  state.live.set(job.id, next);
  if (LIVE_STATUSES.has(next.status)) watchJob(next.id);
  else unwatchJob(next.id);
  return { created: !previous.id };
}

export function registerJobs(detail) {
  const jobs = [];
  if (detail?.activeJob) jobs.push(detail.activeJob);
  for (const job of detail?.queuedJobs ?? []) jobs.push(job);
  for (const job of jobs) upsertLive(job);
}

export function pruneLive() {
  const turns = new Map((state.detail?.turns ?? []).map((turn) => [turn.number, turn.status]));
  for (const [jobId, job] of state.live) {
    if (LIVE_STATUSES.has(job.status) || state.watched.has(jobId)) continue;
    const settled = job.turnNumber != null && turns.has(job.turnNumber) && !LIVE_STATUSES.has(turns.get(job.turnNumber));
    if (settled) {
      state.live.delete(jobId);
      state.requests.delete(jobId);
    }
  }
}

export function liveForTurn(number) {
  if (number == null) return null;
  for (const job of state.live.values()) {
    if (job.turnNumber === number) return job;
  }
  return null;
}

/* --------------------------------------------------------------- slides */
