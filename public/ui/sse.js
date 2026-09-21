/**
 * scriptaWorlds — Server sent events and the polling fallback.
 */
import { api } from './api.js';
import { showError } from './errors.js';
import { renderMenuItems } from './render/menu.js';
import { patchActivity } from './render/reader.js';
import { LIVE_STATUSES, state } from './state.js';
import { refreshDetail, upsertLive } from './universe.js';

export function syncEvents() {
  if (state.watched.size === 0) {
    stopEvents();
    return;
  }
  if (state.events) return;
  state.events = { mode: 'aggregate', source: null, gotMessage: false, retry: 0, streams: new Map(), poll: null };
  if (!state.universeId) return;
  openAggregate();
}

export function stopEvents() {
  const events = state.events;
  if (!events) return;
  events.source?.close();
  for (const stream of events.streams.values()) stream.close();
  if (events.poll) clearInterval(events.poll);
  state.events = null;
}

export function openAggregate() {
  const events = state.events;
  if (!events || !state.universeId) return;
  let source;
  try {
    source = new EventSource(`/api/universes/${encodeURIComponent(state.universeId)}/events`);
  } catch {
    enableEventFallback();
    return;
  }
  events.source = source;
  source.onmessage = (event) => {
    events.gotMessage = true;
    events.retry = 0;
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEvent(payload);
  };
  source.onerror = () => {
    source.close();
    if (!events.gotMessage) {
      enableEventFallback();
      return;
    }
    events.retry += 1;
    if (events.retry > 6) {
      enableEventFallback();
      return;
    }
    if (events.mode !== 'aggregate') return;
    setTimeout(() => {
      if (state.events === events && events.mode === 'aggregate') openAggregate();
    }, 2000);
  };
}

// Degraded mode: server without the aggregate stream → per job streams + polling.

export function enableEventFallback() {
  const events = state.events;
  if (!events || events.mode === 'fallback') return;
  events.mode = 'fallback';
  events.source?.close();
  events.source = null;
  for (const jobId of state.watched) openJobStream(jobId);
  if (state.watched.size > 0) startStatusPolling();
}

export function openJobStream(jobId) {
  const events = state.events;
  if (!events || events.mode !== 'fallback' || !state.universeId) return;
  if (events.streams.has(jobId)) return;
  let source;
  try {
    source = new EventSource(`/api/universes/${encodeURIComponent(state.universeId)}/events?job=${encodeURIComponent(jobId)}`);
  } catch {
    return;
  }
  events.streams.set(jobId, source);
  source.onmessage = (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEvent(payload, jobId);
  };
  source.onerror = () => { /* closes on done/error */ };
}

export function closeJobStream(jobId) {
  const stream = state.events?.streams.get(jobId);
  if (!stream) return;
  stream.close();
  state.events.streams.delete(jobId);
}

export function watchJob(jobId) {
  if (!jobId || state.watched.has(jobId)) return;
  state.watched.add(jobId);
  syncEvents();
  if (state.events?.mode === 'fallback') openJobStream(jobId);
  startStatusPolling();
}

export function unwatchJob(jobId) {
  if (!jobId) return;
  state.watched.delete(jobId);
  closeJobStream(jobId);
  if (state.watched.size === 0) {
    stopStatusPolling();
    syncEvents();
  }
}

export function startStatusPolling() {
  const events = state.events;
  if (!events || events.poll) return;
  events.poll = setInterval(pollStatuses, 1800);
}

export function stopStatusPolling() {
  if (!state.events?.poll) return;
  clearInterval(state.events.poll);
  state.events.poll = null;
}

export async function pollStatuses() {
  if (state.watched.size === 0) {
    stopStatusPolling();
    return;
  }
  let structural = false;
  for (const jobId of [...state.watched]) {
    let job = null;
    try {
      job = (await api(`/api/jobs/${encodeURIComponent(jobId)}`))?.job ?? null;
    } catch {
      job = null;
    }
    if (!job) {
      state.watched.delete(jobId);
      closeJobStream(jobId);
      continue;
    }
    const { created } = upsertLive(job);
    if (created) structural = true;
    if (!LIVE_STATUSES.has(job.status)) {
      state.watched.delete(jobId);
      closeJobStream(jobId);
      structural = true;
    }
  }
  if (structural) {
    try {
      await refreshDetail({ targetIndex: 'keep' });
      return;
    } catch { /* retry next tick */ }
  }
  patchActivity();
  renderMenuItems();
  if (state.watched.size === 0) stopStatusPolling();
}

export function handleEvent(payload, streamJobId = null) {
  if (!payload || typeof payload !== 'object') return;
  const id = payload.job?.id ?? payload.jobId ?? streamJobId;
  if (payload.type === 'job' && payload.job) {
    const { created } = upsertLive(payload.job);
    if (created) {
      refreshDetail({ targetIndex: 'keep' }).catch((error) => showError(error.message));
      return;
    }
    if (!LIVE_STATUSES.has(payload.job.status)) finishJob(payload.job.id);
    patchActivity();
    renderMenuItems();
    return;
  }
  if (!id) return;
  const live = state.live.get(id);
  if (!live) return;
  switch (payload.type) {
    case 'phase':
      live.phase = payload.text ?? live.phase;
      break;
    case 'delta':
      live.text = `${live.text ?? ''}${payload.text ?? ''}`.slice(-20_000);
      break;
    case 'done':
      live.status = 'done';
      finishJob(id);
      return;
    case 'error':
      live.status = 'error';
      live.error = payload.message ?? 'The chapter could not be finished.';
      finishJob(id);
      return;
    default:
      break;
  }
  patchActivity();
}

export function finishJob(jobId) {
  unwatchJob(jobId);
  refreshDetail({ targetIndex: 'keep' }).catch((error) => showError(error.message));
}

/* ------------------------------------------------------------- actions */
