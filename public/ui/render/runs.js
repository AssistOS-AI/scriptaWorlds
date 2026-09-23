/**
 * scriptaWorlds — One row of the run list, shared by the review panel and the report panel.
 *
 * A run is read the same way wherever it is listed: its phase, its state, the version it was frozen
 * against, whether a later accepted version has made it historical, and what the host recorded when it
 * failed. The two panels differ only in the actions they offer, which the caller passes in.
 */
import { elem } from '../state.js';

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

