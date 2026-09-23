/**
 * scriptaWorlds — The reading track: chapter slices, consoles, live turns.
 */
import { retryTurn } from '../actions.js';
import { loadTurn } from '../api.js';
import { errorRow } from '../errors.js';
import { openFeedback } from '../feedback.js';
import { iconButton } from '../icons.js';
import { openPanel, openRewrite, renderPanels, renderPopups } from '../overlays.js';
import { openReport } from '../report.js';
import { openReview } from '../review.js';
import { openSessions } from '../sessions.js';
import { renderNewScreen, renderUniverseList, welcomePanel } from './explore.js';
import { renderFooter } from './composer.js';
import { renderHeader } from './header.js';
import { renderMenuItems } from './menu.js';
import { applyTransform, navTitle, renderChapNav, updateNav } from '../slides.js';
import { FAILED_STATUSES, dom, elem, state } from '../state.js';
import { saveIndex } from '../universe.js';
import { renderMarkdown } from '../../markdown.js';

export function render() {
  renderTrack();
  renderChapNav();
  renderHeader();
  renderFooter();
  renderPanels();
  renderPopups();
  renderUniverseList();
  renderMenuItems();
  applyTransform();
  updateNav();
  saveIndex();
}

export function renderTrack() {
  state.liveNodes.clear();
  const nodes = [];
  if (!state.universeId) {
    nodes.push(slideNode({ key: 'welcome', kind: 'welcome' }));
  } else {
    for (const slice of state.slides) nodes.push(slideNode(slice));
    if (state.slides.length === 0) nodes.push(slideNode({ key: 'empty', kind: 'empty' }));
  }
  dom.track.replaceChildren(...nodes);
  if (!state.universeId) renderNewScreen();
}

export function slideNode(model) {
  const inner = elem('div', { className: 'slide__inner' });
  if (model.kind === 'welcome') inner.append(welcomePanel());
  else if (model.kind === 'empty') inner.append(elem('p', { className: 'hint', text: 'The book is empty. Write below what should happen first.' }));
  else inner.append(exchangeNode(model));
  for (const message of state.errors) inner.append(errorRow(message));
  return elem('section', {
    className: 'slide',
    attrs: { 'data-key': model.key, 'aria-label': navTitle(model) }
  }, inner);
}

export function exchangeNode(model) {
  // A slice holds the book and nothing else: the request that produced it is one link away (`i`).
  const exchange = elem('div', { className: 'exchange' });
  exchange.append(model.kind === 'chapter' ? chapterBubble(model) : activityBubble(model));
  return exchange;
}

export function chapterBubble(model) {
  const bubble = elem('div', { className: 'bubble bubble--ala' },
    elem('div', { className: 'bubble__head' },
      elem('span', { className: 'bubble__head-title', text: `Chapter ${model.number} · ${model.title ?? 'untitled'}` }),
      chapterToolbar(model)
    )
  );
  const cached = state.chapters.get(model.number);
  if (cached?.markdown) {
    const prose = renderMarkdown(cached.markdown);
    prose.setAttribute('lang', state.universe?.language ?? 'en');
    bubble.append(elem('div', {}, prose));
  } else if (cached?.error) {
    bubble.append(elem('p', { className: 'hint', text: `This chapter could not be loaded: ${cached.error}` }));
  } else {
    bubble.append(elem('p', { className: 'hint', text: 'Loading chapter…' }));
  }
  // The console of the run that wrote this chapter is not inline: it is one dialog away, the same
  // one every other run of the book is read in.
  return bubble;
}

/**
 * The actions of one chapter, as a toolbar of icon buttons: what the chapter was asked for, rewriting
 * it, the run that wrote it, what a reader says about the book, a review of it and the reports of the
 * book. Every control is a real button with an accessible name, so the strip is reachable by Tab and
 * activatable with Enter or Space, and the icon only carries the picture.
 */
export function chapterToolbar(model) {
  return elem('div', {
    className: 'bubble__actions toolbar',
    attrs: { role: 'group', 'aria-label': `Chapter ${model.number} actions` }
  },
  model.turnNumber != null
    ? iconButton({ name: 'info', label: 'What you asked for', on: { click: () => openRequest(model) } })
    : null,
  iconButton({
    name: 'rewrite',
    label: `Rewrite chapter ${model.number}`,
    on: { click: () => openRewrite(model.number) }
  }),
  model.turnNumber != null
    ? iconButton({
      name: 'console',
      label: `Show the run that wrote chapter ${model.number}`,
      on: { click: () => openSessions({ turn: model.turnNumber }) }
    })
    : null,
  iconButton({
    name: 'feedback',
    label: `Say what you think of this book, from chapter ${model.number}`,
    on: { click: () => openFeedback({ chapter: model.number }) }
  }),
  iconButton({
    name: 'review',
    label: `Review chapter ${model.number}`,
    on: { click: () => openReview({ chapter: model.number }) }
  }),
  iconButton({ name: 'report', label: 'Reports and reviews', on: { click: () => openReport() } })
  );
}

// What produced the chapter on screen: the request of that chapter's own turn, plus its title.

export function openRequest(model) {
  state.requestChapter = { number: model.number, title: model.title ?? null, turnNumber: model.turnNumber ?? null };
  openPanel('requests');
  renderRequests();
  if (model.turnNumber == null) return;
  loadTurn(model.turnNumber)
    .then((turn) => {
      const request = String(turn?.request ?? '').trim();
      if (!request || state.requestChapter?.turnNumber !== model.turnNumber) return;
      state.requestChapter.request = request;
      renderRequests();
    })
    .catch(() => { /* the panel keeps what it already shows */ });
}

export function renderRequests() {
  const current = state.requestChapter;
  const list = dom['request-list'];
  if (!current) {
    list.replaceChildren(elem('li', { className: 'unilist__empty', text: 'Open a chapter first.' }));
    return;
  }
  const fromTurn = current.turnNumber == null
    ? null
    : (state.turns.get(current.turnNumber)?.request
      ?? state.detail?.turns?.find((turn) => turn.number === current.turnNumber)?.request);
  const request = String(current.request ?? fromTurn ?? '').trim();
  const where = current.title ? `Chapter ${current.number} · ${current.title}` : `Chapter ${current.number}`;
  list.replaceChildren(elem('li', { className: 'req' },
    elem('span', { className: 'req__part', text: where }),
    elem('span', { className: 'req__text', text: request || 'The request for this chapter was not recorded.' })
  ));
}


export function activityBubble(model) {
  const statusLabel = FAILED_STATUSES.has(model.status)
    ? 'stopped'
    : (model.status === 'queued' ? 'waiting' : 'writing…');
  const bubble = elem('div', { className: 'bubble bubble--ala' },
    elem('div', { className: 'bubble__head' },
      elem('span', { className: 'bubble__head-title', text: `Chapter ${model.number} · ${statusLabel}` })
    )
  );
  if (FAILED_STATUSES.has(model.status)) {
    const wrap = elem('div', { className: 'turnfail' },
      elem('p', { className: 'turnfail__message', text: model.error ?? 'This chapter did not finish.' })
    );
    if (model.turnNumber != null) {
      wrap.append(elem('button', {
        className: 'btn',
        text: 'Retry',
        attrs: { type: 'button' },
        on: { click: (event) => retryTurn(model.turnNumber, event.currentTarget) }
      }));
    }
    bubble.append(wrap);
    return bubble;
  }
  const body = elem('div', { className: 'live' });
  bubble.append(body);
  renderActivityBody(body, model);
  const jobId = model.live?.id ?? null;
  if (jobId) state.liveNodes.set(jobId, body);
  if (model.live?.id) state.liveNodes.set(`t${model.turnNumber}`, body);
  return bubble;
}

export function renderActivityBody(body, model) {
  const live = model.live ?? {};
  body.replaceChildren();
  if (model.status === 'queued') {
    const position = live.queuePosition ?? 1;
    body.append(elem('p', { className: 'live__state', text: `Waiting (${position} in queue)` }));
    return;
  }
  body.append(elem('p', { className: 'live__state', text: `Writing chapter ${model.number}…` }));
  body.append(elem('p', { className: 'live__phase' },
    elem('span', { className: 'live__dot', attrs: { 'aria-hidden': 'true' } }),
    elem('span', { text: live.phase ?? 'ALA is working on the chapter' })
  ));
  // The text the agent displays is not rendered here and no control is offered either: the run is
  // watched in the sessions dialog, which the Edition menu and the console control of a chapter open.
}

export function patchActivity() {
  for (const [jobId, body] of state.liveNodes) {
    const slice = state.slides.find((model) => model.live?.id === jobId || `t${model.turnNumber}` === jobId);
    if (slice) renderActivityBody(body, slice);
  }
}

/* --------------------------------------------------------- welcome panel */
