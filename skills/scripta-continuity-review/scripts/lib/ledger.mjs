// The comparison ledger (no external dependencies).
//
// The reviewed comparisons are stored separately from the defect list, because a
// defect list is a list of symptoms and a ledger is a list of decisions. Each
// comparison names its subject, the baseline and later evidence it rests on, its
// temporal scope and one outcome — supported, contradicted or unresolved — and a
// character change additionally names the attribute and its catalyst. Counts are
// derived from these records, never trusted from outside, so repeated symptoms
// of one defect stay one comparison and add no independent penalty.

import { ELIGIBLE_KINDS } from './claims.mjs';

const CATEGORY_KINDS = new Map([
  ['fact', 'fact'],
  ['chronology', 'chronology'],
  ['character_knowledge', 'knowledge'],
  ['character_attribute', 'character_change'],
  ['permanent_rule', 'rule'],
  ['social_rule', 'rule'],
  ['plan', 'plan'],
]);

function comparisonKind(claim) {
  if (!ELIGIBLE_KINDS.has(claim.kind)) return 'editorial';
  return CATEGORY_KINDS.get(claim.category) ?? 'fact';
}

function outcomeOf(group) {
  if (group.some((claim) => claim.status === 'confirmed')) return 'contradicted';
  if (group.some((claim) => claim.status === 'unresolved')) return 'unresolved';
  return 'supported';
}

function evidenceIds(record) {
  const ids = [];
  if (record !== null) {
    for (const item of record.evidence) {
      if (typeof item?.id === 'string') ids.push(item.id);
    }
  }
  return ids;
}

// Group the semantic claims into comparisons: one comparison per comparison id,
// so two symptoms of the same defect share a single outcome.
function buildComparisons(claims) {
  const groups = new Map();
  const order = [];
  for (const claim of claims) {
    if (!ELIGIBLE_KINDS.has(claim.kind)) continue;
    const key = claim.comparison_id;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(claim);
  }

  return order.map((key, index) => {
    const group = groups.get(key);
    const kind = comparisonKind(group[0]);
    const withBaseline = group.find((claim) => claim.baseline !== null) ?? null;
    const withLater = group.find((claim) => claim.later !== null) ?? null;
    const withTemporal = group.find((claim) => claim.temporal_scope !== null) ?? null;
    const comparison = {
      id: `comparison-${String(index + 1).padStart(4, '0')}`,
      subject: group[0].subject,
      kind,
      outcome: outcomeOf(group),
      baseline: withBaseline === null ? null : withBaseline.baseline,
      later: withLater === null ? null : withLater.later,
      temporal_scope: withTemporal === null ? null : withTemporal.temporal_scope.declared,
      limitations: group.find((claim) => claim.limitations !== null)?.limitations ?? null,
      alternative_explanation:
        group.find((claim) => claim.alternative_explanation !== null)?.alternative_explanation ?? null,
      claim_ids: group.map((claim) => claim.id),
      evidence_ids: [...new Set(group.flatMap((claim) => evidenceIds(claim.baseline).concat(evidenceIds(claim.later), claim.evidence.map((item) => item.id))))],
    };
    if (kind === 'character_change') {
      comparison.attribute = group.find((claim) => claim.attribute !== null)?.attribute ?? null;
      comparison.catalyst = group.find((claim) => claim.catalyst !== null)?.catalyst ?? null;
    }
    return comparison;
  });
}

function deriveCounts(comparisons) {
  const counts = { eligible_comparisons: comparisons.length, consistent: 0, contradicted: 0, unresolved: 0 };
  for (const comparison of comparisons) {
    if (comparison.outcome === 'contradicted') counts.contradicted += 1;
    else if (comparison.outcome === 'unresolved') counts.unresolved += 1;
    else counts.consistent += 1;
  }
  return counts;
}

// Coverage of the reviewed population and the index derived from it. The index
// is a single number only when every eligible comparison reached an outcome;
// otherwise the bounds carry the uncertainty and stay inside the metric range.
function deriveIndex({ consistent, contradicted, unresolved, eligible_comparisons: eligible }) {
  const resolved = consistent + contradicted;
  if (eligible === 0) {
    return {
      status: 'not_applicable',
      value: null,
      coverage: null,
      lower_bound: null,
      upper_bound: null,
      reason: 'no eligible comparisons were reviewed',
    };
  }
  const coverage = resolved / eligible;
  if (resolved === 0) {
    return {
      status: 'unresolved',
      value: null,
      coverage: 0,
      lower_bound: 0,
      upper_bound: 100,
      reason: 'no resolved comparisons; the index is withheld',
    };
  }
  if (unresolved > 0) {
    return {
      status: 'unresolved',
      value: null,
      coverage,
      lower_bound: (100 * consistent) / eligible,
      upper_bound: (100 * (consistent + unresolved)) / eligible,
      reason: 'unresolved comparisons present; bounds are reported instead of a single index',
    };
  }
  const value = (100 * consistent) / resolved;
  return { status: 'computed', value, coverage: 1, lower_bound: value, upper_bound: value, reason: null };
}

function deriveCadIndex(comparisons) {
  const changes = comparisons.filter((comparison) => comparison.kind === 'character_change');
  if (changes.length === 0) {
    return {
      status: 'not_applicable',
      value: null,
      coverage: null,
      lower_bound: null,
      upper_bound: null,
      eligible: 0,
      reason: 'no eligible character change comparisons were reviewed',
    };
  }
  const unsupported = changes.filter((change) => change.outcome === 'contradicted').length;
  const supported = changes.filter((change) => change.outcome === 'supported').length;
  const unresolved = changes.filter((change) => change.outcome === 'unresolved').length;
  const resolved = unsupported + supported;
  const eligible = changes.length;
  if (resolved === 0) {
    return {
      status: 'unresolved',
      value: null,
      coverage: 0,
      lower_bound: 0,
      upper_bound: 100,
      eligible,
      reason: 'no resolved character changes; the rate is withheld',
    };
  }
  if (unresolved > 0) {
    return {
      status: 'unresolved',
      value: null,
      coverage: resolved / eligible,
      lower_bound: (100 * unsupported) / eligible,
      upper_bound: (100 * (unsupported + unresolved)) / eligible,
      eligible,
      reason: 'unresolved character changes present; bounds are reported instead of a single rate',
    };
  }
  const value = (100 * unsupported) / resolved;
  return { status: 'computed', value, coverage: 1, lower_bound: value, upper_bound: value, eligible, reason: null };
}

export function buildLedger(claims) {
  const comparisons = buildComparisons(claims);
  const counts = deriveCounts(comparisons);
  const resolved = counts.consistent + counts.contradicted;
  const coverage = counts.eligible_comparisons === 0 ? null : resolved / counts.eligible_comparisons;
  const coverageBounds =
    counts.eligible_comparisons === 0
      ? null
      : {
          lower: resolved / counts.eligible_comparisons,
          upper: (resolved + counts.unresolved) / counts.eligible_comparisons,
        };
  return {
    comparisons,
    counts,
    coverage,
    coverageBounds,
    reviewedClaims: claims.map((claim) => claim.id),
    derived: {
      cci: deriveIndex(counts),
      cad: deriveCadIndex(comparisons),
    },
  };
}
