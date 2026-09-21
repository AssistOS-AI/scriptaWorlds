/**
 * scriptaWorlds — The bottom card: ALA voice, teaser, options and the input.
 */
import { renderNotice } from './header.js';
import { dom, elem, state } from '../state.js';

export function fillInput(text) {
  dom.input.value = text;
  dom.input.focus();
  autosize();
}

// The one line under the field: what the server refused, or what is missing before Send.
export function setComposerError(message) {
  state.composerError = message ?? null;
  renderComposerError();
}

export function renderComposerError() {
  const line = dom['composer-error'];
  if (!line) return;
  line.textContent = state.composerError ?? '';
  line.hidden = !state.composerError;
}

/* --------------------------------------------------------- universes list */

export function renderFooter() {
  renderComposerError();
  const model = state.universeId ? state.slides[state.index] ?? null : null;
  const offer = model?.kind === 'chapter' ? model.offer : null;
  const voice = dom['ala-voice'];
  const area = dom['ala-offer'];
  const nodes = [];
  const items = [];
  const teaser = offer?.teaser ?? '';
  if (teaser) {
    voice.hidden = false;
    if (voice.dataset.teaser !== teaser) {
      voice.dataset.teaser = teaser;
      state.voiceExpanded = false;
    }
    renderTeaser(teaser);
  } else {
    voice.hidden = true;
    voice.textContent = '';
    delete voice.dataset.teaser;
    state.voiceExpanded = false;
  }
  // The options are compact links: they copy their promise into the field, they never send.
  const options = (offer?.options ?? []).slice(0, 3);
  for (const option of options) {
    if (!option?.prompt) continue;
    items.push(elem('li', {}, elem('button', {
      className: 'offer__link',
      text: option.label,
      attrs: { type: 'button' },
      on: { click: () => fillInput(option.prompt) }
    })));
  }
  if (!options.length && model?.kind === 'chapter') {
    const idea = (state.ideas.get(state.universeId) ?? [])[0] ?? null;
    if (idea) {
      nodes.push(elem('p', { className: 'ala__hint', text: 'ALA has not suggested a next step yet — here is a thread it could pick up:' }));
      items.push(elem('li', {}, elem('button', {
        className: 'offer__link',
        text: idea.label,
        attrs: { type: 'button' },
        on: { click: () => fillInput(idea.prompt) }
      })));
    }
  }
  if (items.length) nodes.push(elem('ul', { className: 'offer__list' }, items));
  area.replaceChildren(...nodes);
  dom.input.placeholder = state.universeId ? 'Write what should happen next…' : 'Pick a universe or start a new one…';
  renderNotice();
}

// ALA's teaser: two lines at most, with a tiny inline indicator only when something is cut off.

export function renderTeaser(teaser) {
  const voice = dom['ala-voice'];
  const line = parseFloat(getComputedStyle(voice).lineHeight) || 26;
  const limit = line * 2 + 2;
  const measure = (candidate, withButton) => {
    voice.textContent = candidate;
    if (withButton) voice.append(' ', teaserToggle(false));
    return voice.scrollHeight;
  };
  const full = measure(teaser, false);
  if (full <= limit) return; // nothing to expand: no indicator at all
  if (state.voiceExpanded) {
    measure(teaser, false);
    voice.append(' ', teaserToggle(true));
    return;
  }
  const words = teaser.split(/\s+/);
  let low = 4;
  let high = words.length;
  let best = words.slice(0, 6).join(' ');
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = `${words.slice(0, mid).join(' ')}…`;
    if (measure(candidate, true) <= limit) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  measure(best, false);
  voice.append(' ', teaserToggle(false));
}

export function teaserToggle(expanded) {
  return elem('button', {
    className: 'ala__more',
    text: expanded ? 'less' : 'more',
    attrs: { type: 'button' },
    on: {
      click: () => {
        state.voiceExpanded = !state.voiceExpanded;
        renderFooter();
      }
    }
  });
}

/* -------------------------------------------------------- SSE / live */

// The handle in the top right corner: dragging up makes the field taller (the composer is at
// the bottom, so this is the only direction with room).
export function bindInputResize() {
  const handle = document.getElementById('input-handle');
  const input = dom.input;
  if (!handle || !input) return;
  const stop = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', stop);
  };
  const onMove = (event) => {
    const next = Math.max(startHeight - (event.clientY - startY), MIN_HEIGHT);
    input.style.height = `${next}px`;
    input.style.overflowY = input.scrollHeight > input.clientHeight + 1 ? 'auto' : 'hidden';
  };
  let startY = 0;
  let startHeight = 0;
  handle.addEventListener('mousedown', (event) => {
    event.preventDefault();
    dragged = true;
    startY = event.clientY;
    startHeight = input.getBoundingClientRect().height;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  });
}

const MIN_HEIGHT = 44;
let dragged = false; // true once the reader pulled the handle: that height is theirs to keep

export function autosize() {
  const input = dom.input;
  const style = getComputedStyle(input);
  const line = parseFloat(style.lineHeight) || 24;
  const chrome = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0) + 2;
  const max = Math.min(Math.round(line * 7 + chrome), Math.round(window.innerHeight * 0.4));
  const height = input.getBoundingClientRect().height;
  input.style.height = '0px';
  const wanted = input.scrollHeight;
  const auto = Math.min(wanted, max);
  // A height the reader dragged is theirs: automatic growth only ever adds, never shrinks it.
  const next = dragged ? Math.max(auto, Math.round(height)) : auto;
  input.style.height = `${next}px`;
  input.style.overflowY = input.scrollHeight > input.clientHeight + 1 ? 'auto' : 'hidden';
}
