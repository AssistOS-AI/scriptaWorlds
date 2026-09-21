/**
 * scriptaWorlds — The Edition menu rows.
 */
import { openExploration, submitRequest } from '../actions.js';
import { api } from '../api.js';
import { closePopup } from '../overlays.js';
import { EXPORT_REQUEST, LIVE_STATUSES, dom, elem, state } from '../state.js';

export function exportsOf(format) {
  const files = state.detail?.exports ?? [];
  return files.filter((file) => file.format === format).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

export function activeExportJob() {
  for (const job of state.live.values()) {
    if (job.kind === 'export' && LIVE_STATUSES.has(job.status)) return job;
  }
  return null;
}

export function renderMenuItems() {
  const items = [];
  const universe = state.universe;
  if (universe) {
    for (const format of ['pdf', 'docx']) {
      const file = exportsOf(format);
      const label = `Download ${format.toUpperCase()}`;
      items.push(file
        ? elem('a', {
          className: 'menuitem',
          text: label,
          attrs: { href: file.url ?? `/api/files/${universe.id}/${encodeURIComponent(file.name)}`, download: file.name }
        })
        : elem('span', {
          className: 'menuitem menuitem--off',
          attrs: { 'aria-disabled': 'true', title: 'The printed edition has not been generated yet.' }
        },
        elem('span', { text: label }),
        elem('span', { className: 'menuitem__note', text: 'not yet' })
        ));
    }
    const exportJob = activeExportJob();
    if (exportJob) {
      items.push(elem('span', { className: 'menuitem menuitem--off', attrs: { 'aria-disabled': 'true' } },
        elem('span', { text: 'Generate edition' }),
        elem('span', { className: 'menuitem__note', text: exportJob.status === 'queued' ? 'queued' : 'working' })
      ));
    } else {
      items.push(elem('button', {
        className: 'menuitem',
        text: 'Generate edition',
        attrs: { type: 'button' },
        on: {
          click: () => {
            closePopup();
            submitRequest(EXPORT_REQUEST, { kind: 'export', format: 'both', stay: true });
          }
        }
      }));
    }
    items.push(elem('hr', { className: 'menu__sep' }));
  }
  items.push(elem('button', {
    className: 'menuitem',
    text: 'New universe',
    attrs: { type: 'button' },
    on: {
      click: () => {
        closePopup();
        openExploration();
      }
    }
  }));
  dom['menu-items'].replaceChildren(...items);
}

// The exploration panel: nothing is created until the reader presses "Find a story".
