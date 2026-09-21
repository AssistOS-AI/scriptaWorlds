/**
 * scriptaWorlds — Errors shown inside the thread.
 */
import { dom, elem, state } from './state.js';

export function showError(message) {
  const text = String(message ?? '').trim();
  if (!text) return;
  if (state.errors[state.errors.length - 1] === text) return;
  state.errors.push(text);
  if (state.errors.length > 5) state.errors = state.errors.slice(-5);
  const row = errorRow(text);
  const host = currentInner();
  if (host) {
    host.append(row);
    row.scrollIntoView({ block: 'nearest' });
  }
}

export function errorRow(message) {
  return elem('p', { className: 'errorrow', attrs: { role: 'status' } },
    elem('span', { className: 'errorrow__text', text: message }),
    elem('button', {
      className: 'errorrow__close',
      text: 'Dismiss',
      attrs: { type: 'button' },
      on: {
        click: (event) => {
          state.errors = state.errors.filter((entry) => entry !== message);
          event.currentTarget.closest('.errorrow')?.remove();
        }
      }
    })
  );
}

export function currentInner() {
  const node = dom.track.children[state.index];
  return node?.firstElementChild ?? node ?? null;
}

/* ------------------------------------------------------------- loading */
