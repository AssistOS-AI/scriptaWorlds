/**
 * Markdown rendering entry point.
 *
 * A renderer reads the validated assessment bundle and NEVER changes a score,
 * re-judges a metric or introduces a new claim: every fact and score comes from
 * the bundle, so re-rendering the same bundle is byte-identical and makes no
 * new judgement. The five views live in `views.mjs`; the shared helpers in
 * `markdown.mjs`.
 */

import { esc } from './markdown.mjs';
import {
  renderIssues,
  renderJustification,
  renderMetrics,
  renderSpecification,
  renderStg,
} from './views.mjs';

export const VIEW_FILES = [
  '01-stg-compliance.md',
  '02-specification-adherence.md',
  '03-metrics-and-indicators.md',
  '04-score-justification.md',
  '05-detected-issues.md',
];

function renderIndex(bundle) {
  const errors = bundle.execution.errors.length;
  const chapters = bundle.scope.chapters.length ? bundle.scope.chapters.join(', ') : 'none';
  const lines = [
    `# Metrics Report — ${esc(bundle.book.title)}`,
    '',
    `Universe \`${esc(bundle.book.universe_id)}\` · version \`${bundle.version}\` · language ${esc(bundle.book.language)} · ` +
      `assessment \`${bundle.assessment_id}\``,
    '',
    `- Scope: ${esc(bundle.scope.kind)} (chapters ${chapters})`,
    `- Profile: \`${esc(bundle.profile.profile_id)}\``,
    `- Frozen at: ${esc(bundle.created_at)}`,
    `- Status: completed${errors ? ` (${errors} execution error${errors === 1 ? '' : 's'})` : ''}`,
    '',
  ];
  if (bundle.coverage.note) {
    lines.push(`> Coverage: ${esc(bundle.coverage.note)}`, '');
  }
  if (bundle.coverage.omitted_chapters.length > 0) {
    lines.push(
      `> Omitted chapters: ${bundle.coverage.omitted_chapters.join(', ')} — the views below describe only the ` +
        'selection.',
      '',
    );
  }
  lines.push(
    '## Views',
    '',
    '1. [STG Compliance](01-stg-compliance.md)',
    '2. [Specification Adherence](02-specification-adherence.md)',
    '3. [Metrics & Indicators](03-metrics-and-indicators.md)',
    '4. [Score Justification](04-score-justification.md)',
    '5. [Detected Issues](05-detected-issues.md)',
    '',
    'All literary scores are advisory. This index is navigation only and performs no evaluation.',
    '',
  );
  return lines.join('\n');
}

export function renderViews(bundle) {
  return {
    'index.md': renderIndex(bundle),
    '01-stg-compliance.md': renderStg(bundle),
    '02-specification-adherence.md': renderSpecification(bundle),
    '03-metrics-and-indicators.md': renderMetrics(bundle),
    '04-score-justification.md': renderJustification(bundle),
    '05-detected-issues.md': renderIssues(bundle),
  };
}
