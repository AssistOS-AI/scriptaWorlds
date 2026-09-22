/**
 * `annotations.v1` normalization: the semantic inputs that cannot be computed
 * are validated as structured records before they reach the bundle.
 *
 * Every accepted record keeps its provenance (evaluator, rationale) and every
 * evidence reference is verified against the packet bytes by the collector.
 * Containers are validated before they are iterated.
 */

import { fail, isNonNegativeInteger, isPlainObject } from './errors.mjs';
import { verifyEvidenceItem } from './evidence.mjs';
import { INDICATORS, INDICATOR_IDS, METRIC_IDS, RESERVED_METRIC_IDS } from './registry.mjs';

const CONTINUITY_SCHEMA_VERSION = 'continuity-result.v1';
export const DEPARTURE_STATUSES = ['deliberate', 'unresolved', 'accepted'];

export function normalizeAnnMetrics(raw) {
  const out = {};
  if (raw === undefined || raw === null) return out;
  if (!isPlainObject(raw)) fail('annotations.metrics must be an object', 'INVALID_ANNOTATIONS');
  for (const key of Object.keys(raw)) {
    if (RESERVED_METRIC_IDS.includes(key)) {
      fail(`metric ${JSON.stringify(key)} is reserved and not implemented`, 'RESERVED_METRIC');
    }
    if (!METRIC_IDS.includes(key)) fail(`undeclared metric id ${JSON.stringify(key)}`, 'UNKNOWN_METRIC');
    out[key] = raw[key];
  }
  return out;
}

function readChapterList(raw, label, key) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((entry) => !isNonNegativeInteger(entry))) {
    fail(`${label} must be an array of non-negative integers`, 'INVALID_ANNOTATIONS');
  }
  return [...raw].sort((a, b) => a - b);
}

function readEvidenceRefs(raw, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${label} must be an array`, 'INVALID_ANNOTATIONS');
  return raw;
}

/**
 * Resolve a finding's evidence: each entry is either a full evidence item
 * (verified against the packet bytes and registered here) or the id of an item
 * the annotations document already declared.
 */
function resolveFindingEvidence(raw, label, collector) {
  const ids = [];
  for (const item of readEvidenceRefs(raw, label)) {
    if (typeof item === 'string') {
      if (item.length === 0) fail(`${label} contains an empty evidence id`, 'INVALID_ANNOTATIONS');
      if (!collector.byId.has(item)) {
        fail(`${label} references evidence id ${JSON.stringify(item)}, which no evidence item declares`, 'UNKNOWN_EVIDENCE');
      }
      ids.push(item);
      continue;
    }
    if (!isPlainObject(item)) {
      fail(`${label} entries must be evidence items or declared evidence ids`, 'INVALID_ANNOTATIONS');
    }
    collector.add(item);
    ids.push(item.id);
  }
  return ids;
}

/**
 * A supplied `continuity-result.v1`. `counts` and `findings` are the inputs this
 * skill consumes; the declared coverage (`scope.chapters`, or a top-level
 * `chapters`) says which chapters the counts describe, so a result that covers
 * chapters outside the selection is reported as inapplicable rather than
 * mis-attributed.
 */
export function normalizeContinuity(cont) {
  if (!isPlainObject(cont)) fail('annotations.continuity must be an object', 'INVALID_ANNOTATIONS');
  if (cont.schema_version !== CONTINUITY_SCHEMA_VERSION) {
    fail(`annotations.continuity.schema_version must be "${CONTINUITY_SCHEMA_VERSION}"`, 'SCHEMA_VERSION');
  }
  const counts = cont.counts;
  if (!isPlainObject(counts)) fail('continuity counts must be an object', 'INVALID_ANNOTATIONS');
  for (const key of ['eligible_comparisons', 'consistent', 'contradicted', 'unresolved']) {
    if (!isNonNegativeInteger(counts[key])) {
      fail(`continuity counts.${key} must be a non-negative integer`, 'INVALID_ANNOTATIONS');
    }
  }
  if (!Array.isArray(cont.findings)) fail('continuity findings must be an array', 'INVALID_ANNOTATIONS');
  const resolvedAndPending = counts.consistent + counts.contradicted + counts.unresolved;
  if (resolvedAndPending > counts.eligible_comparisons) {
    fail(
      `continuity counts are inconsistent: consistent + contradicted + unresolved = ${resolvedAndPending} exceeds ` +
        `eligible_comparisons = ${counts.eligible_comparisons}; the totals cannot be attributed to this ledger`,
      'INVALID_ANNOTATIONS',
    );
  }

  const scope = isPlainObject(cont.scope) ? cont.scope : null;
  const chapters =
    readChapterList(scope ? scope.chapters : undefined, 'continuity scope.chapters') ??
    readChapterList(cont.chapters, 'continuity chapters');
  return {
    counts,
    findings: cont.findings,
    version: typeof cont.version === 'string' ? cont.version : null,
    source_version: typeof cont.source_version === 'string' ? cont.source_version : null,
    chapters,
    coverage_note: scope && typeof scope.coverage_note === 'string' ? scope.coverage_note : null,
    omitted: scope ? readChapterList(scope.omitted, 'continuity scope.omitted') ?? [] : [],
  };
}

/** Verify and register evidence items, deduplicating by id. */
export function createEvidenceCollector(files) {
  const byPath = new Map(files.map((file) => [file.path, file.buffer]));
  const byId = new Map();
  const list = [];
  const resolveBytes = (path) => {
    const bytes = byPath.get(path);
    if (bytes === undefined) fail(`evidence references unknown file ${JSON.stringify(path)}`, 'UNKNOWN_FILE');
    return bytes;
  };
  const add = (item) => {
    const result = verifyEvidenceItem(item, resolveBytes(item.file));
    if (!result.ok) {
      fail(`evidence item ${JSON.stringify(item.id)} is invalid: ${result.errors.join('; ')}`, 'INVALID_EVIDENCE');
    }
    const existing = byId.get(item.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(result.item)) {
        fail(`duplicate evidence id ${JSON.stringify(item.id)} with conflicting content`, 'DUPLICATE_ID');
      }
      return item.id;
    }
    byId.set(item.id, result.item);
    list.push(result.item);
    return item.id;
  };
  const addAll = (items) => {
    for (const item of items) add(item);
  };
  return { byId, list, add, addAll };
}

export function normalizeIndicators(raw) {
  const out = {};
  const seen = new Set();
  for (const ind of raw ?? []) {
    if (!isPlainObject(ind)) fail('indicator must be an object', 'INVALID_INDICATOR');
    const id = ind.id;
    if (!INDICATOR_IDS.includes(id)) fail(`unknown indicator id ${JSON.stringify(id)}`, 'UNKNOWN_INDICATOR');
    if (seen.has(id)) fail(`duplicate indicator id ${JSON.stringify(id)}`, 'DUPLICATE_ID');
    seen.add(id);
    if (!['judged', 'not_assessable', 'not_applicable'].includes(ind.status)) {
      fail(`indicator ${id} has unknown status ${JSON.stringify(ind.status)}`, 'INVALID_INDICATOR');
    }
    const evidence = ind.evidence === undefined ? [] : ind.evidence;
    if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== 'string')) {
      fail(`indicator ${id} evidence must be an array of string ids`, 'INVALID_INDICATOR');
    }
    if (ind.status === 'judged') {
      if (typeof ind.rationale !== 'string' || ind.rationale.length === 0) {
        fail(`judged indicator ${id} must carry a rationale`, 'INVALID_INDICATOR');
      }
      if (evidence.length === 0) {
        fail(`judged indicator ${id} must cite at least one evidence item`, 'INVALID_INDICATOR');
      }
      if (typeof ind.evaluator !== 'string' || ind.evaluator.length === 0) {
        fail(`judged indicator ${id} must name its evaluator`, 'INVALID_INDICATOR');
      }
    }
    const strOrNull = (value, field) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string') fail(`indicator ${id}.${field} must be a string or null`, 'INVALID_INDICATOR');
      return value;
    };
    const category = strOrNull(ind.category, 'category');
    if (category !== null && !INDICATORS[id].categories.includes(category)) {
      fail(
        `indicator ${id} category ${JSON.stringify(category)} is not one of its source categories ` +
          `(${INDICATORS[id].categories.join('|')})`,
        'INVALID_INDICATOR',
      );
    }
    if (ind.status === 'judged' && category === null) {
      fail(`judged indicator ${id} must record one of its categories (${INDICATORS[id].categories.join('|')})`, 'INVALID_INDICATOR');
    }
    out[id] = {
      id,
      status: ind.status,
      category,
      evidence,
      rationale: strOrNull(ind.rationale, 'rationale'),
      counterevidence: strOrNull(ind.counterevidence, 'counterevidence'),
      intended_effect_fit: strOrNull(ind.intended_effect_fit, 'intended_effect_fit'),
      evaluator: strOrNull(ind.evaluator, 'evaluator'),
      missing_reason: strOrNull(ind.missing_reason, 'missing_reason'),
    };
  }
  for (const id of INDICATOR_IDS) {
    if (!out[id]) {
      const reason =
        id === 'cultural_value'
          ? 'a newly generated unpublished book lacks the reception evidence required for cultural_value'
          : 'no indicator annotation supplied';
      out[id] = {
        id, status: 'not_assessable', category: null, evidence: [],
        rationale: null, counterevidence: null, intended_effect_fit: null,
        evaluator: null, missing_reason: reason,
      };
    }
  }
  return out;
}

/**
 * A confirmed contradiction or unsupported change must show the comparison it
 * rests on: a temporal pair of baseline and later evidence ids, both drawn from
 * the finding's own evidence. Missing or invalid support prevents the finding
 * from entering the confirmed comparison counts.
 */
function readTemporal(raw, label, evidenceIds) {
  if (raw === undefined || raw === null) {
    fail(
      `${label} must declare temporal context as { baseline: [ids], later: [ids] } before it can be confirmed`,
      'INVALID_FINDING',
    );
  }
  if (!isPlainObject(raw)) fail(`${label}.temporal must be an object`, 'INVALID_FINDING');
  const read = (key) => {
    const list = raw[key];
    if (!Array.isArray(list) || list.length === 0 || list.some((id) => typeof id !== 'string' || id.length === 0)) {
      fail(`${label}.temporal.${key} must be a non-empty array of evidence ids`, 'INVALID_FINDING');
    }
    for (const id of list) {
      if (!evidenceIds.includes(id)) {
        fail(`${label}.temporal.${key} cites ${JSON.stringify(id)}, which is not among the finding's evidence`, 'INVALID_FINDING');
      }
    }
    return [...list];
  };
  const baseline = read('baseline');
  const later = read('later');
  const overlap = baseline.filter((id) => later.includes(id));
  if (overlap.length > 0) {
    fail(`${label}.temporal must separate baseline from later evidence; ${overlap.join(', ')} appears in both`, 'INVALID_FINDING');
  }
  return { baseline, later };
}

export function normalizeFindings(rawFindings, collector) {
  const out = [];
  const seen = new Set();
  for (const finding of rawFindings ?? []) {
    if (!isPlainObject(finding)) fail('finding must be an object', 'INVALID_FINDING');
    if (typeof finding.id !== 'string' || finding.id.length === 0) {
      fail('finding must have a non-empty string id', 'INVALID_FINDING');
    }
    if (seen.has(finding.id)) fail(`duplicate finding id ${JSON.stringify(finding.id)}`, 'DUPLICATE_ID');
    seen.add(finding.id);
    if (!['integrity', 'contradiction', 'unsupported_change', 'future_reference', 'editorial'].includes(finding.kind)) {
      fail(`finding ${finding.id} has unknown kind ${JSON.stringify(finding.kind)}`, 'INVALID_FINDING');
    }
    if (!['major', 'local', 'editorial'].includes(finding.severity)) {
      fail(`finding ${finding.id} has unknown severity ${JSON.stringify(finding.severity)}`, 'INVALID_FINDING');
    }
    if (!['deterministic', 'tentative'].includes(finding.certainty)) {
      fail(`finding ${finding.id} has unknown certainty ${JSON.stringify(finding.certainty)}`, 'INVALID_FINDING');
    }
    if (!['confirmed', 'unresolved', 'dismissed'].includes(finding.status)) {
      fail(`finding ${finding.id} has unknown status ${JSON.stringify(finding.status)}`, 'INVALID_FINDING');
    }
    if (typeof finding.description !== 'string' || finding.description.length === 0) {
      fail(`finding ${finding.id} must have a description`, 'INVALID_FINDING');
    }
    const evidenceIds = resolveFindingEvidence(finding.evidence, `finding ${finding.id} evidence`, collector);
    const needsPair = finding.kind === 'contradiction' || finding.kind === 'unsupported_change';
    if (finding.status === 'confirmed') {
      if (evidenceIds.length === 0) {
        fail(
          `finding ${finding.id} is confirmed without evidence; a confirmed claim must show the passage it rests on`,
          'INVALID_EVIDENCE',
        );
      }
      if (needsPair) {
        readTemporal(finding.temporal, `finding ${finding.id}`, evidenceIds);
      }
    } else if (finding.temporal !== undefined && finding.temporal !== null) {
      readTemporal(finding.temporal, `finding ${finding.id}`, evidenceIds);
    }
    if (finding.status === 'unresolved' && typeof finding.alternative_explanation === 'string' && finding.alternative_explanation.length === 0) {
      fail(`finding ${finding.id} records an empty alternative explanation`, 'INVALID_FINDING');
    }
    if (finding.defect_id !== undefined && finding.defect_id !== null) {
      if (typeof finding.defect_id !== 'string' || finding.defect_id.length === 0) {
        fail(`finding ${finding.id} defect_id must be a non-empty string when present`, 'INVALID_FINDING');
      }
    }
    out.push({
      id: finding.id,
      kind: finding.kind,
      severity: finding.severity,
      certainty: finding.certainty,
      status: finding.status,
      description: finding.description,
      defect_id: typeof finding.defect_id === 'string' ? finding.defect_id : null,
      evidence: evidenceIds,
      temporal: finding.temporal === undefined || finding.temporal === null
        ? null
        : {
            baseline: [...finding.temporal.baseline],
            later: [...finding.temporal.later],
          },
      alternative_explanation: finding.alternative_explanation === undefined ? null : finding.alternative_explanation,
      repair_suggestion: finding.repair_suggestion === undefined ? null : finding.repair_suggestion,
    });
  }
  return out;
}

export function normalizePreserved(raw) {
  if (raw === undefined || raw === null) {
    return { passages: [], reason: 'no preserved-qualities annotations supplied; nothing was judged worth protecting' };
  }
  if (!isPlainObject(raw)) fail('preserved_qualities must be an object', 'INVALID_ANNOTATIONS');
  const passages = raw.passages === undefined ? [] : raw.passages;
  if (!Array.isArray(passages)) fail('preserved_qualities.passages must be an array', 'INVALID_ANNOTATIONS');
  const out = [];
  const seen = new Set();
  for (const passage of passages) {
    if (!isPlainObject(passage)) fail('preserved passage must be an object', 'INVALID_ANNOTATIONS');
    if (typeof passage.id !== 'string' || passage.id.length === 0) {
      fail('preserved passage must have a non-empty id', 'INVALID_ANNOTATIONS');
    }
    if (seen.has(passage.id)) fail(`duplicate preserved passage id ${JSON.stringify(passage.id)}`, 'DUPLICATE_ID');
    seen.add(passage.id);
    const evidence = passage.evidence === undefined ? [] : passage.evidence;
    if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== 'string')) {
      fail(`preserved passage ${passage.id} evidence must be an array of string ids`, 'INVALID_ANNOTATIONS');
    }
    if (typeof passage.rationale !== 'string' || passage.rationale.length === 0) {
      fail(`preserved passage ${passage.id} must have a rationale`, 'INVALID_ANNOTATIONS');
    }
    out.push({ id: passage.id, evidence, rationale: passage.rationale });
  }
  const reason = typeof raw.reason === 'string' ? raw.reason : null;
  return { passages: out, reason };
}

/**
 * Deliberate departures must be declared. Nothing in the rule outcomes may be
 * turned into a departure: a `fail` or a `not_applicable` is an outcome, not a
 * statement of intent.
 */
export function normalizeDepartures(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('annotations.departures must be an array', 'INVALID_ANNOTATIONS');
  const out = [];
  const seen = new Set();
  for (const departure of raw) {
    if (!isPlainObject(departure)) fail('departure must be an object', 'INVALID_ANNOTATIONS');
    if (typeof departure.id !== 'string' || departure.id.length === 0) {
      fail('departure must have a non-empty id', 'INVALID_ANNOTATIONS');
    }
    if (seen.has(departure.id)) fail(`duplicate departure id ${JSON.stringify(departure.id)}`, 'DUPLICATE_ID');
    seen.add(departure.id);
    if (!DEPARTURE_STATUSES.includes(departure.status)) {
      fail(
        `departure ${departure.id} status must be one of ${DEPARTURE_STATUSES.join('|')}`,
        'INVALID_ANNOTATIONS',
      );
    }
    if (typeof departure.description !== 'string' || departure.description.length === 0) {
      fail(`departure ${departure.id} must have a description`, 'INVALID_ANNOTATIONS');
    }
    const evidence = departure.evidence === undefined ? [] : departure.evidence;
    if (!Array.isArray(evidence) || evidence.some((e) => typeof e !== 'string')) {
      fail(`departure ${departure.id} evidence must be an array of string ids`, 'INVALID_ANNOTATIONS');
    }
    out.push({
      id: departure.id,
      status: departure.status,
      description: departure.description,
      rationale: typeof departure.rationale === 'string' ? departure.rationale : null,
      evidence,
    });
  }
  return out;
}
