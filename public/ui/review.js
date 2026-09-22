/**
 * scriptaWorlds — The review surface: asking for a review of a frozen accepted version and following
 * the run until it settles.
 *
 * A review never touches the book. The host freezes the accepted version into a packet outside
 * `universes/` and runs one separate-phase skill over it (docs/contracts.md §8.5), so this module only
 * builds the request, keeps the run list, and watches the runs this client started.
 */
import { loadAssessmentRun, loadAssessments, sendAssessmentAction, startAssessment } from './api.js';
import { showError } from './errors.js';
import { openPanel, renderPanels } from './overlays.js';
import { RUN_LIVE_STATUSES, RUN_POLL_MS, dom, state } from './state.js';

export function reviewTarget() {
  return state.review;
}

/** The chapters the book already accepted, in order: the only chapters a review can cover. */
export function acceptedChapterNumbers() {
  return [...(state.detail?.chapters ?? [])]
    .map((chapter) => chapter.number)
    .filter((number) => Number.isInteger(number))
    .sort((a, b) => a - b);
}

export function chapterTitle(number) {
  const found = (state.detail?.chapters ?? []).find((chapter) => chapter.number === number);
  return found?.title ?? null;
}

/**
 * Open the review panel on the chapter whose toolbar was used. The scope, the phase, the observations
 * and the aggregate are remembered in `state.review` while the reader changes them, so a refresh of the
 * run list never discards a choice.
 */
export function openReview({ chapter = null } = {}) {
  const numbers = acceptedChapterNumbers();
  const last = numbers[numbers.length - 1] ?? null;
  const current = chapter != null && numbers.includes(chapter) ? chapter : last;
  state.review = {
    chapter: current,
    scope: 'chapter',
    from: current ?? numbers[0] ?? 1,
    to: Math.min((current ?? numbers[0] ?? 1) + 2, last ?? current ?? 1),
    phase: 'metrics',
    mode: 'generic',
    aggregate: false,
    intention: '',
    busy: false,
    error: null,
    active: null,
    built: false
  };
  openPanel('review');
  dom['review-close'].focus();
  refreshRuns({ force: true }).catch(() => {});
}

/** The scope body of `POST /api/universes/:id/assessments`: the whole book, or the named chapters. */
export function reviewScope() {
  const model = state.review;
  if (!model) return null;
  if (model.scope === 'book') return { kind: 'book' };
  if (model.scope === 'arc') {
    const numbers = acceptedChapterNumbers();
    const low = Math.min(Number(model.from) || 0, Number(model.to) || 0);
    const high = Math.max(Number(model.from) || 0, Number(model.to) || 0);
    const chapters = numbers.filter((number) => number >= low && number <= high);
    return chapters.length ? { kind: 'chapter', chapters } : null;
  }
  return model.chapter != null ? { kind: 'chapter', chapters: [model.chapter] } : null;
}

export function reviewScopeLabel() {
  const model = state.review;
  const scope = reviewScope();
  if (!model || !scope) return 'no chapter to review';
  if (scope.kind === 'book') return `the whole book (${acceptedChapterNumbers().length} chapters)`;
  if (model.scope === 'arc') return `chapters ${scope.chapters.join(', ')}`;
  return `chapter ${scope.chapters[0]}${chapterTitle(scope.chapters[0]) ? ` · ${chapterTitle(scope.chapters[0])}` : ''}`;
}

/** Start one review and watch the run it produced. */
export async function startReview() {
  const model = state.review;
  if (!model || model.busy) return;
  if (!state.universeId) return;
  const scope = reviewScope();
  if (!scope) {
    model.error = 'There is no accepted chapter in this scope to review yet.';
    renderPanels();
    return;
  }
  const body = { phase: model.phase, scope, mode: model.mode };
  if (model.aggregate) {
    body.aggregate = true;
    const intention = String(model.intention ?? '').trim();
    // The intention is what the emotional component is compared against; without one the aggregate
    // reports why it is unavailable rather than scoring an intention nobody stated.
    if (intention) body.intention = intention;
  }
  model.busy = true;
  model.error = null;
  renderPanels();
  try {
    const run = await startAssessment(body);
    if (!run) throw new Error('The host accepted the request but returned no run.');
    upsertRun(run);
    model.active = run.run_id;
    if (RUN_LIVE_STATUSES.has(run.status)) watchRun(run.run_id);
    await refreshRuns({ force: true });
  } catch (error) {
    model.error = error.message;
    // A phase that fails before it publishes still leaves a run behind, with the reason it recorded: the
    // list is re-read so that run is visible with its own state instead of only the line above it.
    await refreshRuns({ force: true }).catch(() => {});
  } finally {
    const current = state.review;
    if (current) current.busy = false;
    renderPanels();
  }
}

export async function cancelRun(runId) {
  await runAction(runId, 'cancel');
}

export async function retryRun(runId) {
  await runAction(runId, 'retry');
}

async function runAction(runId, action) {
  try {
    const run = await sendAssessmentAction(runId, action);
    if (run) {
      upsertRun(run);
      if (action === 'retry' && RUN_LIVE_STATUSES.has(run.status)) watchRun(run.run_id);
    }
    await refreshRuns({ force: true });
  } catch (error) {
    if (state.review) {
      state.review.error = error.message;
      renderPanels();
    } else {
      showError(error.message);
    }
  }
}

/** Re-read the run list of the open book and repaint whichever panel shows it. */
export async function refreshRuns({ force = true } = {}) {
  const { runs } = await loadAssessments(force);
  if (state.panel === 'review' || state.panel === 'report') renderPanels();
  return runs;
}

/**
 * A turn finished, changed the accepted version, or a review settled: the cached list is out of date.
 * The event stream calls this, so the list follows the book instead of a timer that keeps asking.
 */
export function runsChanged() {
  if (!state.universeId) return;
  state.runsLoaded = false;
  if (state.panel === 'review' || state.panel === 'report') {
    refreshRuns({ force: true }).catch(() => {});
  }
}

export function upsertRun(run) {
  if (!run?.run_id) return;
  const rest = state.runs.filter((entry) => entry.run_id !== run.run_id);
  const merged = { ...(state.runs.find((entry) => entry.run_id === run.run_id) ?? {}), ...run };
  rest.push(merged);
  rest.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  state.runs = rest;
}

export function findRun(runId) {
  return state.runs.find((run) => run.run_id === runId) ?? null;
}

/** Leaving a book, or opening the start screen: no run of another book is listed and none is watched. */
export function resetAssessmentState() {
  stopRunWatch();
  state.runs = [];
  state.arcEvents = [];
  state.runsLoaded = false;
  state.review = null;
  state.report = null;
}

/** The newest run that published something to read: what the report panel opens by default. */
export function newestReadableRun() {
  return state.runs.find((run) => run.status === 'done' && Array.isArray(run.outputs) && run.outputs.length > 0)
    ?? state.runs[0]
    ?? null;
}

/* --------------------------------------------------------------- watching */

let watch = null;

/**
 * Follow one run while it is queued or running. The check stops the moment the run settles, so an open
 * panel watches a run, never the whole store.
 */
export function watchRun(runId) {
  stopRunWatch();
  if (!runId) return;
  watch = { runId, universeId: state.universeId, timer: setInterval(() => { pollRun(runId); }, RUN_POLL_MS) };
  pollRun(runId);
}

export function stopRunWatch() {
  if (!watch) return;
  clearInterval(watch.timer);
  watch = null;
}

export function watchedRunId() {
  return watch?.runId ?? null;
}

async function pollRun(runId) {
  if (!watch || watch.runId !== runId) return;
  if (!state.universeId || watch.universeId !== state.universeId) {
    stopRunWatch();
    return;
  }
  let run = null;
  try {
    run = await loadAssessmentRun(runId);
  } catch {
    stopRunWatch();
    return;
  }
  if (!watch || watch.runId !== runId) return;
  if (!run) {
    stopRunWatch();
    return;
  }
  upsertRun(run);
  if (!RUN_LIVE_STATUSES.has(run.status)) {
    stopRunWatch();
    await refreshRuns({ force: true }).catch(() => {});
    return;
  }
  renderPanels();
}
