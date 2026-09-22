/**
 * NQS: a reproducible, optional aggregate (C18).
 *
 * NQS is derived from the saved components — the CS scalar, the OI scalar and a
 * separately judged emotional-fit component — under an explicit aggregation
 * profile that declares its version, non-negative weights summing to one, the
 * emotional-fit procedure and intention, the scope, the corpus and rubric
 * versions and a calibration identity. A free-standing annotated NQS never
 * overrides those components, a missing input is never redistributed over the
 * others, and an incompatible or uncalibrated profile stays unavailable: a
 * production profile is enabled only after the calibration study supplies its
 * evidence, which no code change can substitute for.
 */

import { fail, isPlainObject } from './errors.mjs';

export const NQS_REQUIRES = ['CS', 'OI', 'EMOTIONAL_FIT'];
export const NQS_PROFILE_VERSION = 'nqs-profile.v1';
export const NQS_POLICIES = ['research', 'production'];
const EPSILON = 1e-9;

/** Parse `profile.aggregation`; `enabled` is the only required field. */
export function parseAggregation(raw) {
  if (!isPlainObject(raw)) fail('profile.aggregation must be an object', 'INVALID_PROFILE');
  if (typeof raw.enabled !== 'boolean') fail('profile.aggregation.enabled must be a boolean', 'INVALID_PROFILE');
  const profileVersion = raw.profile_version === undefined ? NQS_PROFILE_VERSION : raw.profile_version;
  const policy = raw.policy === undefined ? 'research' : raw.policy;
  if (!NQS_POLICIES.includes(policy)) {
    fail(`profile.aggregation.policy must be one of ${NQS_POLICIES.join('|')}`, 'INVALID_PROFILE');
  }
  const aggregation = {
    enabled: raw.enabled,
    profile_version: profileVersion,
    policy,
    weights: null,
    emotional_fit: null,
    scope: typeof raw.scope === 'string' && raw.scope.length > 0 ? raw.scope : null,
    corpus_version: typeof raw.corpus_version === 'string' ? raw.corpus_version : null,
    rubric_version: typeof raw.rubric_version === 'string' ? raw.rubric_version : null,
    calibration: isPlainObject(raw.calibration) ? raw.calibration : null,
  };
  if (!raw.enabled) return aggregation;

  if (profileVersion !== NQS_PROFILE_VERSION) {
    fail(
      `unsupported profile.aggregation.profile_version ${JSON.stringify(profileVersion)}; ` +
        `expected ${JSON.stringify(NQS_PROFILE_VERSION)}`,
      'SCHEMA_VERSION',
    );
  }
  if (!isPlainObject(raw.weights)) {
    fail('an enabled profile.aggregation must declare weights for cs, oi and emotional_fit', 'INVALID_PROFILE');
  }
  const weights = {};
  let total = 0;
  for (const key of ['cs', 'oi', 'emotional_fit']) {
    const value = raw.weights[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(`profile.aggregation.weights.${key} must be a non-negative number`, 'INVALID_PROFILE');
    }
    weights[key] = value;
    total += value;
  }
  if (Math.abs(total - 1) > EPSILON) {
    fail(
      `profile.aggregation.weights must sum to 1 (got ${total}); a missing input is never redistributed over the ` +
        'remaining weights',
      'INVALID_PROFILE',
    );
  }
  aggregation.weights = weights;
  if (!isPlainObject(raw.emotional_fit) || typeof raw.emotional_fit.procedure !== 'string' || raw.emotional_fit.procedure.length === 0) {
    fail('an enabled profile.aggregation must declare its emotional_fit.procedure', 'INVALID_PROFILE');
  }
  aggregation.emotional_fit = {
    procedure: raw.emotional_fit.procedure,
    intent: typeof raw.emotional_fit.intent === 'string' ? raw.emotional_fit.intent : null,
  };
  return aggregation;
}

/**
 * graph: { metricId: [dependency ids] }. Dependencies not present in the graph
 * are treated as leaf inputs. Returns { ok, errors }.
 */
export function validateDependencyGraph(graph) {
  if (graph === undefined || graph === null || typeof graph !== 'object' || Array.isArray(graph)) {
    fail('dependency graph must be an object mapping metric ids to dependency lists', 'INVALID_GRAPH');
  }
  const errors = [];
  const nodes = Object.keys(graph);
  const visited = new Set();
  const active = new Set();
  const stack = [];

  const visit = (node) => {
    if (visited.has(node)) return;
    if (active.has(node)) {
      const cycleStart = stack.indexOf(node);
      errors.push(`dependency cycle detected: ${[...stack.slice(cycleStart), node].join(' -> ')}`);
      return;
    }
    active.add(node);
    stack.push(node);
    const deps = graph[node];
    if (!Array.isArray(deps)) {
      errors.push(`dependencies for ${node} must be an array`);
    } else {
      for (const dep of deps) {
        if (typeof dep !== 'string') {
          errors.push(`dependency of ${node} must be a string`);
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(graph, dep)) visit(dep);
      }
    }
    stack.pop();
    active.delete(node);
    visited.add(node);
  };

  for (const node of nodes) visit(node);
  return { ok: errors.length === 0, errors };
}

/**
 * values: { CS: number|null, OI: number|null, EMOTIONAL_FIT: number|null }.
 * Returns { status: 'not_assessable'|'eligible', missing, reason }.
 */
export function checkNqs({ enabled, values }) {
  if (!enabled) {
    return {
      status: 'not_assessable',
      missing: [],
      reason: 'NQS is disabled by default; enable aggregation with a validated research profile to compute it',
    };
  }
  const missing = NQS_REQUIRES.filter((key) => typeof values[key] !== 'number' || values[key] === null);
  if (missing.length > 0) {
    return {
      status: 'not_assessable',
      missing,
      reason: `missing required inputs ${missing.join(', ')}; weights are never redistributed around missing inputs`,
    };
  }
  return { status: 'eligible', missing: [], reason: null };
}

function calibrationProblem(aggregation) {
  const calibration = aggregation.calibration;
  if (!calibration) return 'no calibration study is recorded';
  if (typeof calibration.study_id !== 'string' || calibration.study_id.length === 0) {
    return 'the calibration record names no study';
  }
  if (calibration.held_out !== true) return `study ${calibration.study_id} has no held-out evidence`;
  if (!Array.isArray(calibration.evidence) || calibration.evidence.length === 0) {
    return `study ${calibration.study_id} records no evidence`;
  }
  return null;
}

/**
 * Build NQS from the saved components. `values` are the CS/OI scalars (null when
 * the metric could not be scored) and the separately judged emotional fit.
 */
export function buildNqs({ aggregation, values, scope, baseMetricFor, annotatedValue }) {
  const m = baseMetricFor('NQS', scope);
  m.value_kind = 'scalar';
  const enabled = aggregation ? aggregation.enabled : false;
  const check = checkNqs({ enabled, values });
  m.detail = {
    aggregation_policy: aggregation ? aggregation.policy : null,
    weights: aggregation ? aggregation.weights : null,
    emotional_fit_procedure: aggregation && aggregation.emotional_fit ? aggregation.emotional_fit.procedure : null,
    scope: aggregation ? aggregation.scope : null,
    corpus_version: aggregation ? aggregation.corpus_version : null,
    rubric_version: aggregation ? aggregation.rubric_version : null,
    calibration: aggregation ? aggregation.calibration : null,
    inputs: values,
  };
  if (typeof annotatedValue === 'number') {
    m.detail.annotated_value_ignored = annotatedValue;
    m.detail.note = 'a free-standing annotated NQS never overrides the saved components';
  }
  if (check.status === 'not_assessable') {
    m.missing_reason = check.reason;
    if (check.missing.length > 0) m.detail.missing = check.missing;
    return m;
  }
  const profileVersion = aggregation.profile_version;
  if (profileVersion !== NQS_PROFILE_VERSION) {
    m.missing_reason =
      `incompatible aggregation profile ${JSON.stringify(profileVersion)}; NQS remains unavailable until the ` +
      `components and the profile agree on ${NQS_PROFILE_VERSION}`;
    return m;
  }
  if (!aggregation.emotional_fit || !aggregation.emotional_fit.intent) {
    m.missing_reason =
      'the aggregation profile declares no emotional intention; emotional fit cannot be interpreted without it';
    return m;
  }
  if (aggregation.policy === 'production') {
    const problem = calibrationProblem(aggregation);
    if (problem) {
      m.missing_reason =
        `a production NQS profile requires calibration evidence (${problem}); the result stays unavailable until ` +
        'the calibration study supplies it';
      return m;
    }
  }
  const weights = aggregation.weights;
  m.status = 'computed';
  m.value =
    100 *
    ((weights.cs * values.CS) / 100 + (weights.oi * values.OI) / 100 + (weights.emotional_fit * values.EMOTIONAL_FIT) / 100);
  m.coverage = 1;
  m.qualified = aggregation.policy === 'research';
  m.detail.arithmetic =
    `100 * (${weights.cs} * ${values.CS} + ${weights.oi} * ${values.OI} + ` +
    `${weights.emotional_fit} * ${values.EMOTIONAL_FIT}) / 100 = ${m.value}`;
  m.detail.note =
    aggregation.policy === 'research'
      ? 'research profile: a weighted experiment, not an endorsed or validated formula'
      : 'production profile with recorded calibration evidence';
  m.limits =
    `${m.limits} NQS fits this declared profile, not universal literary value; a duplicate flaw in two components ` +
    'still counts in both.';
  return m;
}
