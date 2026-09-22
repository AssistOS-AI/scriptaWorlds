/**
 * The five Markdown views.
 *
 *   01 STG compliance reports the general rule set (`source: stg`).
 *   02 specification adherence maps this reader request and brief to observed
 *      fulfilment, the request's own requirements and the declared departures.
 *   03 the metrics and indicators view lists all twelve metrics and all eight
 *      indicators with status, scope, unit and missing reason.
 *   04 the justification view shows components, arithmetic, bounds, coverage
 *      and limits of every result.
 *   05 the issues view prioritizes findings, preserves alternatives and keeps
 *      the passages worth retaining.
 */

import { INDICATOR_IDS, METRIC_IDS } from './registry.mjs';
import {
  esc,
  evidenceMap,
  evidenceText,
  fmtNumber,
  formatDetailValue,
  heading,
  scopeText,
  sortedFindings,
  valueText,
} from './markdown.mjs';

/**
 * The leading section of every view: what was assessed, the intention the text was
 * read against, the recorded strengths, the most consequential supported problems
 * with their passages and bounded revision options, and the honest meaning of an
 * empty findings list. It reads `bundle.review` and adds nothing to it.
 */
export function reviewLines(bundle, { title = 'Review summary', problems = 5 } = {}) {
  const review = bundle.review;
  if (!review) return [];
  const evidence = evidenceMap(bundle);
  const lines = [`## ${title}`, ''];
  lines.push(`**${esc(review.reading_status.replace(/_/g, ' '))}** — ${esc(review.statement)}`, '');
  lines.push(`- Assessed scope: ${esc(scopeText(review.scope))}`);
  const measures = review.assessment.measures;
  lines.push(
    `- Evidence coverage: ${review.assessment.measures.evidence_coverage === null ? 'not measurable' : fmtNumber(measures.evidence_coverage)} ` +
      `of the selected chapters; segment coverage: ${measures.segment_coverage === null ? 'no segment population' : fmtNumber(measures.segment_coverage)}`,
  );
  if (measures.continuity_partition && measures.continuity_partition.complete === false) {
    lines.push(
      `- Continuity population: ${measures.continuity_partition.unexamined} eligible comparisons carry no outcome, so ` +
        'the index is bounded rather than published',
    );
  }
  lines.push(`- Intention: ${esc(review.intention.statement)}`);
  if (review.assessment.unavailable.length > 0) {
    lines.push(
      `- Not available: ${review.assessment.unavailable.map((entry) => `\`${esc(entry.id)}\` (${esc(entry.status)}: ${esc(entry.reason ?? 'no reason recorded')})`).join('; ')}`,
    );
  } else {
    lines.push('- Not available: nothing; every metric carries a result');
  }
  lines.push('');

  lines.push('### Strengths observed', '');
  if (review.strengths.length === 0) {
    lines.push(review.strengths_note ?? 'Nothing was recorded as worth preserving.', '');
  } else {
    for (const strength of review.strengths) {
      lines.push(`- \`${esc(strength.id)}\` — ${esc(strength.statement)}`);
      lines.push(`  - Passages: ${evidenceText(evidence, strength.passages)}`);
    }
    lines.push('');
  }

  lines.push('### Most consequential problems', '');
  if (review.problems.length === 0) {
    lines.push(review.problems_note ?? 'No finding was recorded.', '');
  } else {
    for (const problem of review.problems.slice(0, problems)) {
      lines.push(
        `- \`${esc(problem.id)}\` (${esc(problem.severity)}, ${esc(problem.status)}, from ${esc(problem.origin)}): ` +
          `${esc(problem.statement)}`,
      );
      lines.push(`  - Passages: ${evidenceText(evidence, problem.passages)}`);
      lines.push(`  - Scope: ${esc(problem.relates_to)}`);
      lines.push(`  - Intention: ${esc(problem.intention_link)}`);
      if (problem.alternative_reading) {
        lines.push(`  - Alternative reading (preserved): ${esc(problem.alternative_reading)}`);
      }
      if (problem.revision_options.length === 0) {
        lines.push(`  - Revision: ${esc(problem.revision_note)}`);
      }
      for (const option of problem.revision_options) {
        lines.push(`  - Revision option (${esc(option.from)}): ${esc(option.statement)}`);
        if (option.preserved_in_the_same_scope.length > 0) {
          lines.push(
            `    - Passages recorded as worth preserving in the same scope: ` +
              `${option.preserved_in_the_same_scope.map((id) => `\`${esc(id)}\``).join(', ')}`,
          );
        }
      }
    }
    if (review.problems.length > problems) {
      lines.push(
        `- ${review.problems.length - problems} further observation${review.problems.length - problems === 1 ? '' : 's'} ` +
          'are listed in full in the detected-issues view.',
      );
    }
    lines.push('');
  }
  if (review.departures.length > 0) {
    lines.push('### Deliberate departures', '');
    for (const departure of review.departures) {
      lines.push(`- \`${esc(departure.id)}\` (${esc(departure.status)}): ${esc(departure.statement)}`);
    }
    lines.push('');
  }
  return lines;
}

function coverageLines(bundle) {
  const coverage = bundle.coverage;
  const lines = [];
  lines.push(`- Packet scope: ${esc(coverage.packet_scope)} (chapters ${coverage.packet_chapters.join(', ') || 'none'})`);
  lines.push(`- Selection: ${esc(coverage.selection.kind)} — chapters ${coverage.selection.chapters.join(', ') || 'none'}`);
  if (coverage.selection.segments.length > 0) {
    lines.push(`- Selected segments: ${coverage.selection.segments.map((s) => `\`${esc(s)}\``).join(', ')}`);
  }
  lines.push(`- Omitted chapters: ${coverage.omitted_chapters.join(', ') || 'none declared'}`);
  lines.push(
    `- Context chapters (available to explain a fact, never counted as candidate text): ` +
      `${coverage.context_chapters.join(', ') || 'none'}`,
  );
  if (coverage.note) lines.push(`- Coverage note: ${esc(coverage.note)}`);
  lines.push(
    `- Evidence coverage: ${coverage.evidence.chapters_with_evidence}/${coverage.evidence.selected_chapters} ` +
      `selected chapter${coverage.evidence.selected_chapters === 1 ? '' : 's'} carry a verified evidence item`,
  );
  lines.push(
    `- Continuity input: ${coverage.continuity.applicable ? 'applicable to the selection' : 'not applicable'} — ` +
      `${esc(coverage.continuity.reason || 'covers the selection')}`,
  );
  lines.push(
    `- Tokenizer: version ${coverage.tokenizer.version} (${esc(coverage.tokenizer.method)}), language ` +
      `${esc(coverage.tokenizer.language)}, ${coverage.tokenizer.supported ? 'supported' : 'unsupported'}` +
      `${coverage.tokenizer.supported ? '' : ` — ${esc(coverage.tokenizer.reason)}`}`,
  );
  lines.push(`- Eligible candidate tokens in the selection: ${coverage.tokenizer.eligible_tokens}`);
  return lines;
}

function rulePairTable(evidence, pairs) {
  const lines = ['| rule | output | class | criterion | outcome | evidence |', '| --- | --- | --- | --- | --- | --- |'];
  for (const pair of pairs) {
    lines.push(
      `| \`${esc(pair.rule)}\` | ${esc(pair.output)} | ${esc(pair.classification)} | ${esc(pair.criterion)} | ` +
        `**${esc(pair.outcome)}**${pair.recorded ? '' : ' (no outcome recorded)'} | ${evidenceText(evidence, pair.evidence)} |`,
    );
  }
  return lines;
}

function carContext(bundle) {
  const car = bundle.requirements.car;
  const lines = [];
  lines.push(`- Status: \`${car.status}\``);
  lines.push(`- Value: ${typeof car.value === 'number' ? `${fmtNumber(car.value)} %` : 'held back (see bounds)'}`);
  lines.push(`- Aggregation policy: \`${esc(car.aggregation_policy)}\``);
  lines.push(`- Evaluated outputs: ${car.evaluated_outputs}`);
  lines.push(`- Passing outputs: ${car.passing_outputs}`);
  lines.push(`- Failing outputs: ${car.failing_outputs}`);
  lines.push(`- Unresolved outputs: ${car.unresolved_outputs}`);
  lines.push(`- Not-applicable outputs (no applicable hard rule): ${car.not_applicable_outputs}`);
  lines.push(
    `- Recorded outcomes: ${car.recorded_outcomes}/${car.expected_outcomes} expected applicable checks` +
      (car.outcome_coverage === null ? '' : ` (coverage ${fmtNumber(car.outcome_coverage)})`),
  );
  if (car.coverage !== null) lines.push(`- Coverage: ${fmtNumber(car.coverage)}`);
  if (car.lower_bound !== null) lines.push(`- Bounds: [${fmtNumber(car.lower_bound)} %, ${fmtNumber(car.upper_bound)} %]`);
  if (car.missing_reason) lines.push(`- Note: ${esc(car.missing_reason)}`);
  return lines;
}

/* ------------------------------ 01 STG ------------------------------ */

export function renderStg(bundle) {
  const evidence = evidenceMap(bundle);
  const pairs = bundle.requirements.pairs.filter((pair) => pair.source === 'stg');
  const other = bundle.requirements.pairs.filter((pair) => pair.source !== 'stg');
  const lines = [];
  lines.push(heading(bundle), '# STG Compliance Report', '');
  lines.push(
    'Whether the versioned **general rule set** was satisfied. This view reports the general rules only; the ' +
      'requirements of this request, the brief and the editorial preferences are mapped in the adherence view.',
    '',
  );
  lines.push('## Active rule set', '');
  lines.push(`- Registry version: \`${esc(bundle.requirements.registry_version)}\``);
  lines.push(`- Rules of the general set: ${new Set(pairs.map((pair) => pair.rule)).size}`);
  lines.push(
    `- Applicable checks: ${pairs.length} (${pairs.filter((pair) => pair.classification === 'hard').length} hard, ` +
      `${pairs.filter((pair) => pair.classification === 'soft').length} soft)`,
  );
  lines.push('');
  if (pairs.length === 0) {
    lines.push('No general rule set declared; CAR is `not_applicable`.', '');
  } else {
    lines.push(...rulePairTable(evidence, pairs), '');
  }
  lines.push('## Unresolved checks', '');
  const unresolved = pairs.filter((pair) => pair.outcome === 'unresolved');
  if (unresolved.length === 0) {
    lines.push('None.', '');
  } else {
    for (const pair of unresolved) {
      lines.push(
        `- \`${esc(pair.rule)}\` (output ${esc(pair.output)}): ${esc(pair.reason || 'unresolved')}` +
          (pair.recorded ? '' : ' — no outcome was recorded for this applicable rule'),
      );
    }
    lines.push('');
  }
  lines.push('## Failed checks', '');
  const failed = bundle.requirements.car.failures.filter((failure) => failure.source === 'stg');
  if (failed.length === 0) {
    lines.push('None.', '');
  } else {
    for (const failure of failed) {
      lines.push(
        `- \`${esc(failure.rule)}\` (output ${esc(failure.output)}): ${esc(failure.description)} — evidence ` +
          `${evidenceText(evidence, failure.evidence)}`,
      );
    }
    lines.push('');
  }
  lines.push('## CAR context', '');
  lines.push(...carContext(bundle), '');
  lines.push('## Requirements outside the general set', '');
  if (other.length === 0) {
    lines.push('None declared.', '');
  } else {
    lines.push(
      `${other.length} check${other.length === 1 ? '' : 's'} come from this request (${other.filter((p) => p.source === 'request').length}) ` +
        `or from editorial preferences (${other.filter((p) => p.source === 'editorial').length}); they are reported in the adherence ` +
        'view and never counted as STG compliance or as CAR.',
      '',
    );
  }
  return lines.join('\n');
}

/* ------------------------------ 02 specification ------------------------------ */

export function renderSpecification(bundle) {
  const evidence = evidenceMap(bundle);
  const pairs = bundle.requirements.pairs.filter((pair) => pair.source !== 'stg');
  const findings = sortedFindings(bundle);
  const lines = [];
  lines.push(heading(bundle), '# Specification Adherence Analysis', '');
  lines.push('Whether this request and brief were fulfilled by the observed text.', '');
  lines.push('## Request and brief', '');
  lines.push(
    `- Request: ${bundle.specification.request ? esc(bundle.specification.request) : '(no request recorded)'}`,
  );
  lines.push(`- Brief: ${bundle.specification.brief ? esc(bundle.specification.brief) : '(no brief recorded)'}`);
  lines.push(`- Assessed scope: ${esc(bundle.scope.kind)} — chapters ${bundle.scope.chapters.join(', ') || 'none'}`);
  lines.push(
    `- Declared output population: ` +
      `${bundle.scope.population.length ? bundle.scope.population.map((p) => esc(p)).join(', ') : '(none)'}`,
    '',
  );
  lines.push('## Observed fulfilment', '');
  const car = bundle.requirements.car;
  lines.push(
    `CAR status \`${car.status}\`` + (typeof car.value === 'number' ? ` with value ${fmtNumber(car.value)} %.` : '.'),
  );
  if (car.missing_reason) lines.push(`- ${esc(car.missing_reason)}`);
  lines.push('');
  if (pairs.length === 0) {
    lines.push('No requirement of this request or editorial preference was declared.', '');
  } else {
    lines.push(...rulePairTable(evidence, pairs), '');
  }
  lines.push('## Observed departures recorded as findings', '');
  const specFindings = findings.filter(
    (f) => f.kind === 'contradiction' || f.kind === 'integrity' || f.kind === 'unsupported_change',
  );
  if (specFindings.length === 0) {
    lines.push('No specification-related finding recorded.', '');
  } else {
    for (const finding of specFindings) {
      lines.push(`- \`${esc(finding.id)}\` (${esc(finding.severity)}): ${esc(finding.description)}`);
    }
    lines.push('');
  }
  lines.push('## Deliberate departures', '');
  if (bundle.departures.length === 0) {
    lines.push(
      'None declared. A rule outcome of `fail` or `not_applicable` is an outcome, not a statement of intent, so no ' +
        'departure is inferred from it.',
      '',
    );
  } else {
    lines.push('Declared in the annotations. They are never inferred from a rule outcome.', '');
    for (const departure of bundle.departures) {
      lines.push(`- \`${esc(departure.id)}\` (${esc(departure.status)}): ${esc(departure.description)}`);
      if (departure.rationale) lines.push(`  - Rationale: ${esc(departure.rationale)}`);
      lines.push(`  - Evidence: ${evidenceText(evidence, departure.evidence)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------ 03 metrics ------------------------------ */

export function renderMetrics(bundle) {
  const lines = [];
  lines.push(heading(bundle), '# Metrics & Indicators Report', '');
  lines.push('## Metrics', '');
  lines.push('| id | status | value | scope | unit | coverage | missing reason |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const id of METRIC_IDS) {
    const metric = bundle.metrics[id];
    lines.push(
      `| \`${id}\` | ${esc(metric.status)} | ${valueText(metric)} | ${esc(scopeText(metric.scope))} | ` +
        `${esc(metric.unit)} | ${esc(metric.coverage ?? '—')} | ${esc(metric.missing_reason ?? '')} |`,
    );
  }
  lines.push('');
  lines.push('## Literary indicators', '');
  lines.push('| id | status | category | scope | rationale | evaluator |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const id of INDICATOR_IDS) {
    const indicator = bundle.indicators[id];
    lines.push(
      `| ${esc(id)} | ${esc(indicator.status)} | ${esc(indicator.category ?? '—')} | ` +
        `${esc(scopeText(bundle.scope))} | ${esc(indicator.rationale ?? '')} | ${esc(indicator.evaluator ?? '—')} |`,
    );
  }
  lines.push('');
  lines.push('## Unavailable reasons', '');
  let unavailable = 0;
  for (const id of METRIC_IDS) {
    const metric = bundle.metrics[id];
    if (metric.status === 'not_assessable' || metric.status === 'not_applicable' || metric.status === 'error') {
      unavailable += 1;
      lines.push(`- \`${id}\`: ${esc(metric.missing_reason || metric.status)}`);
    }
  }
  if (unavailable === 0) lines.push('- none: every metric carries a value');
  lines.push('');
  lines.push('## Segments and boundaries', '');
  if (bundle.segments.length === 0) {
    lines.push('No segment annotations supplied; boundaries are whole chapters.', '');
  } else {
    lines.push('| id | kind | chapter | bytes | provenance | labels | members |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const segment of bundle.segments) {
      const range = segment.start === null ? '—' : `[${segment.start},${segment.end})`;
      lines.push(
        `| \`${esc(segment.id)}\` | ${esc(segment.kind)} | ${esc(segment.chapter ?? segment.chapter_span?.join('–'))} | ` +
          `${range} | **${esc(segment.provenance)}** | ${esc(segment.labels.join('; ') || '—')} | ` +
          `${segment.members ? segment.members.map((m) => `\`${esc(m)}\``).join(', ') : '—'} |`,
      );
    }
    lines.push('');
    lines.push(
      `Chronology: disclosure order ${bundle.segment_order.disclosure.map((s) => `\`${esc(s)}\``).join(' → ') || '—'}; ` +
        `story order ${bundle.segment_order.story.map((s) => `\`${esc(s)}\``).join(' → ') || '—'}; ` +
        `differs: ${bundle.segment_order.differs ? 'yes' : 'no'}.`,
      '',
    );
    const inferred = bundle.segments.filter((segment) => segment.provenance === 'inferred');
    if (inferred.length > 0) {
      lines.push(
        `Inferred boundaries (not declared): ${inferred.map((segment) => `\`${esc(segment.id)}\``).join(', ')}.`,
        '',
      );
    }
  }
  lines.push('## Coverage', '');
  lines.push(...coverageLines(bundle), '');
  return lines.join('\n');
}

/* ------------------------------ 04 justification ------------------------------ */

function componentLines(evidence, metric) {
  const lines = [];
  if (!metric.components) return lines;
  lines.push('- Components:');
  for (const [name, component] of Object.entries(metric.components)) {
    lines.push(
      `  - \`${esc(name)}\`: rating ${component.rating}/4${component.evaluator ? ` by ${esc(component.evaluator)}` : ''}` +
        ` — ${esc(component.rationale)}`,
    );
    lines.push(`    - Evidence: ${evidenceText(evidence, component.evidence)}`);
  }
  return lines;
}

function trajectoryLines(evidence, metric) {
  const lines = [];
  if (!Array.isArray(metric.trajectory)) return lines;
  lines.push(`- Trajectory (ordered by ${esc(metric.ordering || 'disclosure')}):`);
  lines.push('  | segment | disclosure | story | focalization | valence | tension | uncertainty | evidence |');
  lines.push('  | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const point of metric.trajectory) {
    lines.push(
      `  | \`${esc(point.segment_id)}\` | ${point.disclosure_index} | ${point.story_order ?? '—'} | ` +
        `${esc(point.focalization ?? '—')} | ${fmtNumber(point.valence)} | ${fmtNumber(point.tension)} | ` +
        `${esc(point.uncertainty)} | ${evidenceText(evidence, point.evidence)} |`,
    );
  }
  return lines;
}

export function renderJustification(bundle) {
  const evidence = evidenceMap(bundle);
  const lines = [];
  lines.push(heading(bundle), '# Score Justification Report', '');
  lines.push(
    `Registry version \`${bundle.provenance.registry_version}\` · tokenizer version ` +
      `${bundle.provenance.tokenizer_version} (${esc(bundle.provenance.tokenizer_method)}) · runtime ` +
      `${esc(bundle.provenance.runtime)}.`,
    '',
  );
  lines.push('## Metric justifications', '');
  for (const id of METRIC_IDS) {
    const metric = bundle.metrics[id];
    lines.push(`### ${id} — ${esc(metric.name)}`, '');
    lines.push(`- Status: \`${metric.status}\``);
    lines.push(`- Value: ${valueText(metric)}`);
    lines.push(`- Value kind: \`${esc(metric.value_kind)}\``);
    lines.push(`- Scope: ${esc(scopeText(metric.scope))}`);
    lines.push(`- Unit and direction: ${esc(metric.unit)} · ${esc(metric.direction)}`);
    lines.push(`- Method: ${esc(metric.method)}`);
    lines.push(...componentLines(evidence, metric));
    lines.push(...trajectoryLines(evidence, metric));
    if (metric.detail && typeof metric.detail === 'object') {
      const entries = Object.entries(metric.detail);
      if (entries.length > 0) {
        lines.push('- Components and arithmetic:');
        for (const [key, value] of entries) lines.push(`  - ${esc(key)}: ${esc(formatDetailValue(value))}`);
      }
    }
    lines.push(
      `- Bounds: ${metric.bounds ? `[${fmtNumber(metric.bounds.lower)}, ${fmtNumber(metric.bounds.upper)}]` : '—'}`,
    );
    lines.push(`- Coverage: ${esc(metric.coverage ?? '—')}`);
    lines.push(`- Limits: ${esc(metric.limits)}`);
    if (metric.qualified !== undefined) {
      lines.push(`- Qualification: ${metric.qualified === true ? 'limited or experimental finding' : metric.qualified}`);
    }
    if (metric.evidence && metric.evidence.length) lines.push(`- Evidence: ${evidenceText(evidence, metric.evidence)}`);
    if (metric.evaluator) lines.push(`- Evaluator: ${esc(metric.evaluator)}`);
    if (metric.rationale) lines.push(`- Rationale: ${esc(metric.rationale)}`);
    if (metric.missing_reason) lines.push(`- Missing: ${esc(metric.missing_reason)}`);
    lines.push('');
  }
  lines.push('## Indicator justifications', '');
  for (const id of INDICATOR_IDS) {
    const indicator = bundle.indicators[id];
    lines.push(`### ${id}`, '');
    lines.push(`- Status: \`${indicator.status}\``);
    lines.push(`- Category: ${esc(indicator.category ?? '—')}`);
    lines.push(`- Scope: ${esc(scopeText(bundle.scope))}`);
    if (indicator.evidence && indicator.evidence.length) {
      lines.push(`- Evidence: ${evidenceText(evidence, indicator.evidence)}`);
    }
    if (indicator.rationale) lines.push(`- Rationale: ${esc(indicator.rationale)}`);
    if (indicator.counterevidence) lines.push(`- Counterevidence: ${esc(indicator.counterevidence)}`);
    if (indicator.intended_effect_fit) lines.push(`- Intended-effect fit: ${esc(indicator.intended_effect_fit)}`);
    if (indicator.evaluator) lines.push(`- Evaluator: ${esc(indicator.evaluator)}`);
    if (indicator.missing_reason) lines.push(`- Missing: ${esc(indicator.missing_reason)}`);
    lines.push('');
  }
  lines.push('## Profile and provenance', '');
  lines.push(`- Profile id: \`${esc(bundle.profile.profile_id)}\` · sha256 \`${bundle.provenance.profile_sha256}\``);
  lines.push(
    `- Profile schema: \`${esc(bundle.profile.schema_version)}\` · aggregation enabled: ` +
      `${bundle.profile.aggregation.enabled} · policy \`${esc(bundle.profile.aggregation.policy)}\``,
  );
  lines.push(
    `- Aggregation weights: ${bundle.profile.aggregation.weights ? esc(JSON.stringify(bundle.profile.aggregation.weights)) : '—'} · ` +
      `emotional-fit procedure: ${esc(bundle.profile.aggregation.emotional_fit?.procedure ?? '—')} · ` +
      `calibration: ${esc(bundle.profile.aggregation.calibration ? JSON.stringify(bundle.profile.aggregation.calibration) : 'none recorded')}`,
  );
  lines.push(`- Rubric profile: \`${esc(bundle.profile.rubric.version)}\` at a 0-${bundle.profile.rubric.scale} anchor scale`);
  lines.push(`- Packet version: \`${bundle.version}\` · captured ${esc(bundle.provenance.packet.captured_at)}`);
  lines.push(`- Selection: ${esc(scopeText(bundle.scope))}`);
  lines.push(
    `- Continuity input: ${bundle.coverage.continuity.applicable ? 'applicable' : esc(bundle.coverage.continuity.reason)}`,
  );
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------ 05 issues ------------------------------ */

export function renderIssues(bundle) {
  const evidence = evidenceMap(bundle);
  const lines = [];
  lines.push(heading(bundle), '# Detected Issues Report', '');
  lines.push(
    'Findings are prioritized by severity; each keeps its alternative explanation and a bounded repair suggestion.',
    '',
  );
  lines.push(...reviewLines(bundle, { title: 'The review in brief' }));
  lines.push('## Findings in full', '');
  const findings = sortedFindings(bundle);
  if (findings.length === 0) {
    lines.push(
      bundle.review
        ? `${esc(bundle.review.problems_note ?? 'No finding was recorded.')} The reading status is ` +
          `\`${esc(bundle.review.reading_status)}\`, which is what an empty list means here.`
        : 'No findings recorded.',
      '',
    );
  }
  for (const finding of findings) {
    lines.push(`## ${esc(finding.id)} — ${esc(finding.kind)}`, '');
    lines.push(
      `- Severity: \`${esc(finding.severity)}\` · certainty: \`${esc(finding.certainty)}\` · status: \`${esc(finding.status)}\``,
    );
    lines.push(`- Description: ${esc(finding.description)}`);
    if (finding.evidence && finding.evidence.length) {
      lines.push(`- Affected passages: ${evidenceText(evidence, finding.evidence)}`);
    }
    if (finding.alternative_explanation) {
      lines.push(`- Alternative explanation (preserved): ${esc(finding.alternative_explanation)}`);
    }
    if (finding.repair_suggestion) lines.push(`- Repair suggestion: ${esc(finding.repair_suggestion)}`);
    lines.push('');
  }
  lines.push('## Passages worth retaining', '');
  const preserved = bundle.preserved_qualities;
  if (preserved.passages.length === 0) {
    lines.push(preserved.reason ? esc(preserved.reason) : 'Nothing was judged worth protecting.', '');
  } else {
    for (const passage of preserved.passages) {
      lines.push(`- \`${esc(passage.id)}\`: ${esc(passage.rationale)}`);
      lines.push(`  - Passages: ${evidenceText(evidence, passage.evidence)}`);
    }
    if (preserved.reason) lines.push('', esc(preserved.reason));
    lines.push('');
  }
  return lines.join('\n');
}
