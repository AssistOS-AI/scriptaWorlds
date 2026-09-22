/**
 * scriptaWorlds — One row of the run list, shared by the review panel and the report panel.
 *
 * A run is read the same way wherever it is listed: its phase, its state, the version it was frozen
 * against, whether a later accepted version has made it historical, and what the host recorded when it
 * failed. The two panels differ only in the actions they offer, which the caller passes in.
 */
import { RUN_FAILED_STATUSES, RUN_LIVE_STATUSES, elem } from '../state.js';

export function statusLabel(status) {
  return String(status ?? 'unknown').replace(/_/g, ' ');
}

export function statusBadge(status) {
  return elem('span', { className: `badge badge--${status ?? 'unknown'}`, text: statusLabel(status) });
}

export function historicalBadge() {
  return elem('span', { className: 'badge badge--historical', text: 'historical' });
}

export function phaseLabel(phase) {
  return phase === 'continuity' ? 'continuity' : 'metrics';
}

export function triggerLabel(run) {
  if (run?.trigger === 'arc') return run.arc_id ? `arc ${run.arc_id}` : 'arc';
  return 'requested';
}

export function scopeText(scope) {
  if (!scope) return '—';
  if (scope.kind === 'book') return 'the whole book';
  const chapters = Array.isArray(scope.chapters) ? scope.chapters : [];
  if (chapters.length) return `${chapters.length === 1 ? 'chapter' : 'chapters'} ${chapters.join(', ')}`;
  return String(scope.kind);
}

export function versionText(version) {
  const text = String(version ?? '');
  return text.startsWith('sha256:') ? `sha256:${text.slice(7, 15)}…` : (text || '—');
}

export function stamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * The state of one run as the reader needs it: a badge, the recorded failure reason when there is one,
 * and the actions that apply. `actions` are `{ label, onClick, className }` descriptors.
 */
export function runRow(run, { current = false, onOpen = null, actions = [] } = {}) {
  const head = elem('div', { className: 'runrow__head' },
    elem('span', { className: 'runrow__phase', text: phaseLabel(run.phase) }),
    statusBadge(run.status),
    run.historical ? historicalBadge() : null,
    run.status === 'done' ? elem('span', { className: 'runrow__note', text: 'frozen version' }) : null
  );
  const line = elem('p', { className: 'runrow__meta' },
    elem('span', { text: stamp(run.created_at) || 'not dated' }),
    elem('span', { text: '·' }),
    elem('span', { text: scopeText(run.requested_scope ?? run.scope) }),
    elem('span', { text: '·' }),
    elem('span', { text: triggerLabel(run) }),
    elem('span', { text: '·' }),
    elem('span', { text: versionText(run.version) })
  );
  const row = elem('li', {
    className: `runrow${current ? ' runrow--current' : ''}`,
    attrs: { 'data-run': run.run_id, ...(current ? { 'aria-current': 'true' } : {}) }
  }, head, line);
  if (run.status !== 'done' && run.error) {
    row.append(elem('p', { className: 'runrow__error', text: run.error }));
  }
  const controls = [];
  if (onOpen) {
    const readable = run.status === 'done' && Array.isArray(run.outputs) && run.outputs.length > 0;
    controls.push(elem('button', {
      className: 'btn btn--small',
      text: readable ? 'Open report' : 'Show run',
      attrs: { type: 'button' },
      on: { click: () => onOpen(run) }
    }));
  }
  for (const action of actions) {
    controls.push(elem('button', {
      className: action.className ?? 'btn btn--small',
      text: action.label,
      attrs: { type: 'button' },
      on: { click: action.onClick }
    }));
  }
  if (RUN_LIVE_STATUSES.has(run.status)) {
    row.append(elem('p', { className: 'runrow__note', text: 'the review is running outside the book; this list follows it' }));
  } else if (RUN_FAILED_STATUSES.has(run.status) && run.log?.stderr) {
    row.append(elem('details', { className: 'runrow__log' },
      elem('summary', { text: 'What the phase printed' }),
      elem('pre', { className: 'runrow__pre', text: String(run.log.stderr).slice(-4000) })
    ));
  }
  if (controls.length) row.append(elem('div', { className: 'runrow__actions' }, ...controls));
  return row;
}
