/**
 * Shared rendering helpers for the Markdown views.
 *
 * A renderer reads the validated bundle and NEVER changes a score, re-judges a
 * metric or introduces a claim. Text supplied by an author (quotes, rationales,
 * requests) is escaped so it can never break a table cell, an inline code span,
 * a link, raw HTML or a heading. A zero value and an unavailable value are
 * rendered differently, and a component or trajectory value is never shown as
 * though it were a scalar.
 */

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/^(\s*)(#{1,6})(\s)/gm, '$1\\$2$3')
    .replace(/\|/g, '\\|')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

export function fmtNumber(value, digits = 3) {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return Number(value.toFixed(digits)).toString();
}

/** Distinct rendering of a scalar, a component profile, a trajectory and an unavailable result. */
export function valueText(metric) {
  const { status, value, unit, value_kind: kind, missing_reason: reason } = metric;
  if (status === 'computed' || status === 'judged') {
    if (kind === 'components') {
      const names = metric.components ? Object.keys(metric.components) : [];
      const derived =
        typeof value === 'number'
          ? `experimental scalar ${fmtNumber(value)} (${esc(unit)})`
          : 'no combined scalar';
      return `${names.length} component${names.length === 1 ? '' : 's'} (${names.join(', ') || 'none'}); ${derived}`;
    }
    if (kind === 'trajectory') {
      const points = Array.isArray(metric.trajectory) ? metric.trajectory.length : 0;
      return `trajectory of ${points} ordered segment${points === 1 ? '' : 's'} (${esc(unit)})`;
    }
    if (typeof value === 'number') return `${fmtNumber(value)} ${unit}`;
    return status;
  }
  if (status === 'error') return `error — ${esc(reason || 'no reason recorded')}`;
  const label = String(status).replace(/_/g, ' ');
  return reason ? `${label} — ${esc(reason)}` : label;
}

export function evidenceMap(bundle) {
  return new Map(bundle.evidence.map((item) => [item.id, item]));
}

export function evidenceText(evidenceById, ids) {
  if (!ids || ids.length === 0) return '—';
  const parts = [];
  for (const id of ids) {
    const item = evidenceById.get(id);
    if (!item) {
      parts.push(`\`${esc(id)}\` (missing)`);
      continue;
    }
    parts.push(`\`${esc(id)}\` \`${esc(item.file)}\` [${item.start},${item.end}): "${esc(item.quote)}"`);
  }
  return parts.join('<br>');
}

export function scopeText(scope) {
  if (!scope) return '—';
  const parts = [`kind ${scope.kind}`];
  if (scope.chapters && scope.chapters.length) parts.push(`chapters ${scope.chapters.join(', ')}`);
  if (scope.segments && scope.segments.length) {
    parts.push(`segments ${scope.segments.map((s) => `\`${esc(s)}\``).join(', ')}`);
  }
  return parts.join(' · ');
}

export function formatDetailValue(value) {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value
      .map((entry) => (entry !== null && typeof entry === 'object' ? JSON.stringify(entry) : String(entry)))
      .join('<br>');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function heading(bundle) {
  return [
    `# ${esc(bundle.book.title)} — ${esc(bundle.book.universe_id)}`,
    '',
    `Assessment \`${bundle.assessment_id}\` · version \`${bundle.version}\` · scope ${esc(bundle.scope.kind)} · ` +
      `language ${esc(bundle.book.language)}`,
    '',
  ].join('\n');
}

const severityOrder = { major: 0, local: 1, editorial: 2 };

export function sortedFindings(bundle) {
  return [...bundle.findings].sort((a, b) => {
    const severity = (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
    if (severity !== 0) return severity;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
