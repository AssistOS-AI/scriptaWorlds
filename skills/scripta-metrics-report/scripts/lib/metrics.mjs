/**
 * Metric result builders: the twelve metric objects assembled from registry
 * defaults plus either deterministic summaries (`computed`) or validated
 * annotation records (`judged`).
 *
 * Every metric object carries a discriminated `value_kind` so a generic
 * renderer never assumes a numeric value: `scalar` metrics hold their
 * measurement in `value`; component metrics hold anchored `components` in
 * `components` (with `value` only as an experimental scalar the rubric profile
 * defines); `trajectory` metrics hold an ordered `trajectory`. Missing
 * prerequisites produce `not_assessable` with an explicit reason, and a
 * supplied number that cannot be justified is classified as unsupported legacy
 * data rather than becoming a score.
 */

import { fail, isPlainObject } from './errors.mjs';
import { DEFINITION_VERSION, METRICS, REGISTRY_VERSION } from './registry.mjs';

export function baseMetric(id, scope) {
  const reg = METRICS[id];
  return {
    id,
    name: reg.name,
    definition_version: DEFINITION_VERSION,
    registry_version: REGISTRY_VERSION,
    value_kind: reg.value_kind ?? 'scalar',
    status: 'not_assessable',
    value: null,
    components: null,
    trajectory: null,
    unit: reg.unit,
    direction: reg.direction,
    purpose: reg.purpose,
    method: reg.method,
    scope: scope ?? null,
    evidence: [],
    coverage: null,
    bounds: null,
    limits: reg.limitations,
    missing_reason: null,
    evaluator: null,
    rationale: null,
    detail: null,
  };
}

/** Copy the optional provenance fields a judged annotation may carry. */
export function applyJudgedFields(m, ann, id) {
  if (ann.method !== undefined) m.method = ann.method;
  if (ann.unit !== undefined) m.unit = ann.unit;
  if (ann.evidence !== undefined) {
    if (!Array.isArray(ann.evidence) || ann.evidence.some((e) => typeof e !== 'string')) {
      fail(`annotations.metrics.${id}.evidence must be an array of string ids`, 'INVALID_ANNOTATIONS');
    }
    m.evidence = ann.evidence;
  }
  if (ann.coverage !== undefined) m.coverage = ann.coverage;
  if (ann.missing_reason !== undefined) m.missing_reason = ann.missing_reason;
  if (ann.evaluator !== undefined) {
    if (ann.evaluator !== null && typeof ann.evaluator !== 'string') {
      fail(`annotations.metrics.${id}.evaluator must be a string or null`, 'INVALID_ANNOTATIONS');
    }
    m.evaluator = ann.evaluator;
  }
  if (ann.rationale !== undefined) {
    if (ann.rationale !== null && typeof ann.rationale !== 'string') {
      fail(`annotations.metrics.${id}.rationale must be a string or null`, 'INVALID_ANNOTATIONS');
    }
    m.rationale = ann.rationale;
  }
}

export function metricFromSummary(id, summary, scope) {
  const m = baseMetric(id, scope);
  m.status = summary.status;
  m.value = summary.value;
  m.coverage = summary.coverage === undefined ? null : summary.coverage;
  m.missing_reason = summary.missing_reason ?? null;
  if (summary.lower_bound !== undefined && summary.lower_bound !== null) {
    m.bounds = { lower: summary.lower_bound, upper: summary.upper_bound ?? null };
  }
  if (summary.detail !== undefined && summary.detail !== null) {
    m.detail = summary.detail;
  } else {
    const detail = {};
    for (const [key, value] of Object.entries(summary)) {
      if (!['status', 'value', 'coverage', 'missing_reason', 'detail', 'lower_bound', 'upper_bound'].includes(key)) {
        detail[key] = value;
      }
    }
    m.detail = detail;
  }
  if (summary.qualified !== undefined) m.qualified = summary.qualified;
  return m;
}

/**
 * The continuity index. `meta` carries what the consumer must be able to read
 * next to the number: the population partition of the result (`partition`), how
 * its counts were obtained (`countsSource`) and the totals it declared when they
 * differ from the ones used (`declaredCounts`). A population that was not
 * attributable in full never publishes a single index: the unattributed
 * comparisons are unresolved, so the bounds carry them and coverage says how
 * much of the population reached an outcome.
 */
function computeCci(counts, meta = {}) {
  const { eligible_comparisons, consistent, contradicted, unresolved } = counts;
  const detail = { eligible_comparisons, consistent, contradicted, unresolved, resolved: consistent + contradicted };
  if (meta.partition) detail.partition = meta.partition;
  if (meta.countsSource) detail.counts_source = meta.countsSource;
  if (meta.declaredCounts) detail.declared_counts = meta.declaredCounts;
  if (eligible_comparisons === 0) {
    return { status: 'not_applicable', value: null, coverage: null, missing_reason: 'no eligible continuity comparisons', detail };
  }
  const resolved = consistent + contradicted;
  if (resolved === 0) {
    return { status: 'computed', value: null, coverage: 0, missing_reason: 'no resolved comparisons; index held back', detail };
  }
  if (unresolved > 0) {
    const lower = (100 * consistent) / eligible_comparisons;
    const upper = (100 * (consistent + unresolved)) / eligible_comparisons;
    return {
      status: 'computed', value: null, coverage: resolved / eligible_comparisons,
      lower_bound: lower, upper_bound: upper,
      missing_reason: 'unresolved comparisons present; bounds reported instead of a single index',
      detail: { ...detail, lower_bound: lower, upper_bound: upper },
    };
  }
  return { status: 'computed', value: (100 * consistent) / resolved, coverage: 1, missing_reason: null, detail };
}

/**
 * The unsupported-character-change rate over the counted population. Repeated
 * symptoms of one underlying defect are one candidate, and a defect whose
 * symptoms disagree about their status is contested: it is counted as
 * unresolved with the conflicting statuses named, never resolved by whichever
 * symptom happened to be read first.
 *
 * `meta` records the population the candidates were drawn from
 * (`populationChapters`) and the findings that were left out of it
 * (`excludedFindings`), so the rate can be read against the population it
 * describes.
 */
function computeCad(findings, meta = {}) {
  const changes = findings.filter((f) => f.kind === 'unsupported_change');
  const byDefect = new Map();
  for (const change of changes) {
    const key = change.defect_id ?? change.id;
    if (!byDefect.has(key)) byDefect.set(key, []);
    byDefect.get(key).push(change);
  }
  const linkedSymptoms = [];
  const conflictingDefects = [];
  const candidates = [];
  for (const [defect, members] of byDefect) {
    const statuses = [...new Set(members.map((member) => member.status))];
    const ids = members.map((member) => member.id);
    if (members.length > 1) linkedSymptoms.push(...ids.slice(1));
    if (statuses.length > 1) {
      conflictingDefects.push({ defect, findings: ids, statuses });
      candidates.push({ ...members[0], defect_id: defect, status: 'unresolved' });
      continue;
    }
    candidates.push(members[0]);
  }
  const unsupported = candidates.filter((f) => f.status === 'confirmed').length;
  const supported = candidates.filter((f) => f.status === 'dismissed').length;
  const unresolvedChanges = candidates.filter((f) => f.status === 'unresolved').length;
  const resolvedChanges = unsupported + supported;
  const detail = {
    change_candidates: candidates.length,
    unsupported,
    supported,
    unresolved_changes: unresolvedChanges,
    resolved_changes: resolvedChanges,
    linked_symptoms: linkedSymptoms,
    conflicting_defects: conflictingDefects,
    population_chapters: meta.populationChapters ?? null,
    excluded_findings: meta.excludedFindings ?? [],
  };
  if (candidates.length === 0) {
    return { status: 'not_applicable', value: null, coverage: null, missing_reason: 'no character change candidates', detail };
  }
  if (resolvedChanges === 0) {
    return { status: 'computed', value: null, coverage: 0, missing_reason: 'no resolved change candidates; rate held back', detail };
  }
  if (unresolvedChanges > 0) {
    const lower = (100 * unsupported) / candidates.length;
    const upper = (100 * (unsupported + unresolvedChanges)) / candidates.length;
    return {
      status: 'computed', value: null, coverage: resolvedChanges / candidates.length,
      lower_bound: lower, upper_bound: upper,
      missing_reason: 'unresolved change candidates present; bounds reported instead of a single rate',
      detail: { ...detail, lower_bound: lower, upper_bound: upper },
    };
  }
  return {
    status: 'computed',
    value: (100 * unsupported) / resolvedChanges,
    coverage: 1,
    missing_reason: null,
    detail,
  };
}

/**
 * Assemble all twelve metric objects. `ctx.assessed` holds the metrics built by
 * their own modules (rubric components, EAP trajectory, AEG, CR, NQS); the rest
 * come from the deterministic summaries or from a missing-prerequisite reason.
 */
export function buildMetrics(ctx) {
  const scope = ctx.scope;
  const { assessed } = ctx;
  const noContinuity = ctx.continuityReason ?? 'no continuity-result.v1 supplied in the annotations bundle';
  const noCorpus = ctx.corpusReason ?? 'no --corpus manifest supplied';
  const metrics = {};
  metrics.CS = assessed.CS;
  metrics.NQS = ctx.nqs;
  metrics.CCI = ctx.cci ? metricFromSummary('CCI', ctx.cci, scope) : baseMetricMissing('CCI', scope, noContinuity);
  metrics.CAD = ctx.cad ? metricFromSummary('CAD', ctx.cad, scope) : baseMetricMissing('CAD', scope, noContinuity);
  metrics.EAP = assessed.EAP;
  metrics.CAR = metricFromSummary('CAR', ctx.car, scope);
  metrics.OI = assessed.OI;
  metrics.SI = ctx.si ? metricFromSummary('SI', ctx.si, scope) : baseMetricMissing('SI', scope, noCorpus);
  metrics.NCS = assessed.NCS;
  metrics.CR = assessed.CR;
  metrics.TOP = ctx.top ? metricFromSummary('TOP', ctx.top, scope) : baseMetricMissing('TOP', scope, noCorpus);
  metrics.AEG = assessed.AEG;
  return metrics;
}

/** A metric with no value because a deterministic prerequisite is missing. */
function baseMetricMissing(id, scope, reason) {
  const m = baseMetric(id, scope);
  m.missing_reason = reason;
  return m;
}

export { computeCci, computeCad };
