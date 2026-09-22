/**
 * scriptaWorlds — The slide list (one per chapter), navigation and the chapter nav strip.
 */
import { api } from './api.js';
import { renderFooter } from './render/composer.js';
import { renderNotice } from './render/header.js';
import { LIVE_STATUSES, clamp, dom, elem, state } from './state.js';
import { liveForTurn, saveIndex } from './universe.js';

export function buildSlides() {
  const detail = state.detail;
  if (!detail) return [];
  const chapters = [...(detail.chapters ?? [])].sort((a, b) => a.number - b.number);
  const turns = new Map((detail.turns ?? []).map((turn) => [turn.number, turn]));
  const slices = chapters.map((chapter) => {
    const turn = chapter.turnNumber != null ? turns.get(chapter.turnNumber) ?? null : null;
    return {
      key: `c${chapter.number}`,
      kind: 'chapter',
      number: chapter.number,
      title: chapter.title,
      chapter,
      offer: chapter.offer ?? null,
      turnNumber: chapter.turnNumber ?? null,
      request: turn?.request ?? null
    };
  });
  const known = new Set(chapters.map((chapter) => chapter.number));
  // Pending work is counted in chapters, not in turns: a queue of three chapter turns behind a book of
  // eight accepted chapters reads 9, 10 and 11 even when rewrites and editions have pushed the turn
  // numbers far ahead of the chapter numbers. An edition never takes a chapter number.
  let nextNumber = chapters.reduce((max, chapter) => Math.max(max, chapter.number), 0) + 1;
  const pending = (detail.turns ?? [])
    .filter((turn) => turn.kind === 'chapter'
      && !(turn.chapterNumber != null && known.has(turn.chapterNumber))
      && turn.status !== 'done')
    .sort((a, b) => a.number - b.number);
  for (const turn of pending) {
    const live = liveForTurn(turn.number);
    const status = live && LIVE_STATUSES.has(live.status) ? live.status : turn.status;
    const number = turn.chapterNumber ?? nextNumber;
    if (turn.chapterNumber == null) nextNumber += 1;
    slices.push({
      key: `t${turn.number}`,
      kind: 'activity',
      number,
      title: null,
      offer: null,
      turnNumber: turn.number,
      request: turn.request ?? state.requests.get(live?.id) ?? null,
      status,
      error: turn.error ?? live?.error ?? null,
      live
    });
  }
  return slices;
}

/**
 * The identity of the chapter text a cached body belongs to. A rewrite can replace the prose with a
 * body of exactly the same length, so the byte count alone would keep showing the old chapter: the
 * entry's byte count, its store timestamp, its word count and its title together change whenever the
 * text does.
 */
function chapterIdentity(meta) {
  if (!meta) return null;
  return `${meta.bytes ?? '?'}:${meta.createdAt ?? '?'}:${meta.words ?? '?'}:${meta.title ?? '?'}`;
}

export async function ensureChapterMarkdown(models) {
  const chapters = state.detail?.chapters ?? [];
  await Promise.all(models.map(async (model) => {
    if (model.kind !== 'chapter' || !model.number) return;
    const meta = chapters.find((chapter) => chapter.number === model.number);
    const identity = chapterIdentity(meta);
    const cached = state.chapters.get(model.number);
    if (cached && identity !== null && cached.identity === identity && cached.markdown) return;
    try {
      const payload = await api(`/api/universes/${encodeURIComponent(state.universeId)}/chapters/${model.number}`);
      state.chapters.set(model.number, {
        identity,
        bytes: payload.chapter?.bytes ?? meta?.bytes ?? null,
        markdown: payload.chapter?.markdown ?? ''
      });
    } catch (error) {
      // A failed fetch is not cached as the chapter: the next refresh tries again, and the slide says
      // what happened in the meantime.
      state.chapters.set(model.number, { identity: null, bytes: meta?.bytes ?? null, markdown: null, error: error.message });
    }
  }));
}

/* -------------------------------------------------------------- render */

export function renderChapNav() {
  const items = [];
  state.slides.forEach((slice, index) => {
    if (slice.kind === 'welcome') return;
    const live = slice.kind !== 'chapter';
    const label = slice.number != null ? String(slice.number) : '•';
    const title = slice.kind === 'chapter'
      ? `Chapter ${slice.number} · ${slice.title ?? ''}`
      : (navTitle(slice) ?? 'Chapter in progress');
    items.push(elem('button', {
      className: `chapnav__item${live ? ' chapnav__item--live' : ''}`,
      text: label,
      attrs: {
        type: 'button',
        'data-index': String(index),
        title,
        'aria-label': title,
        'aria-current': 'false'
      },
      on: { click: () => navigate(index) }
    }));
  });
  dom.chapnav.replaceChildren(...items);
}

export function navTitle(model) {
  if (!model) return 'New story';
  if (model.kind === 'welcome') return 'New story';
  if (model.kind === 'empty') return 'New story';
  if (model.kind === 'activity') {
    if (model.status === 'queued') return `Waiting (${model.live?.queuePosition ?? 1} in queue)`;
    if (model.status === 'running') return `Writing chapter ${model.number}…`;
    if (model.status === 'interrupted') return 'Chapter interrupted';
    if (model.status === 'error') return 'Chapter failed';
    return `Chapter ${model.number}`;
  }
  return `Chapter ${model.number} · ${model.title ?? 'untitled'}`;
}

export function navigate(index) {
  if (!state.slides.length && !state.universeId) {
    state.index = 0;
    return;
  }
  state.index = clamp(index, 0, Math.max(0, dom.track.children.length - 1));
  applyTransform();
  updateNav();
  renderFooter();
  saveIndex();
  state.notice = null;
  renderNotice();
}

export function applyTransform() {
  dom.track.style.transform = `translateX(${-state.index * 100}%)`;
}

export function updateNav() {
  const model = state.slides[state.index] ?? (state.universeId ? null : { kind: 'welcome' });
  const total = state.slides.length;
  dom['nav-title'].textContent = navTitle(model);
  dom['nav-count'].textContent = `${total ? state.index + 1 : 0}/${total}`;
  dom['nav-prev'].disabled = state.index <= 0;
  dom['nav-next'].disabled = state.index >= Math.max(0, dom.track.children.length - 1);
  for (const item of dom.chapnav.children) {
    item.setAttribute('aria-current', Number(item.dataset.index) === state.index ? 'true' : 'false');
  }
  const current = dom.chapnav.querySelector('[aria-current="true"]');
  if (current) current.scrollIntoView({ inline: 'center', block: 'nearest' });
}
