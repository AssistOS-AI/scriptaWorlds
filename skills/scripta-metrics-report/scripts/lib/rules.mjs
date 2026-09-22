/**
 * Rule definitions, applicability and observed outcomes (C21), plus CAR.
 *
 * Definitions and outcomes are separate:
 *
 *   - a **rule registry** with stable ids, a description, its source
 *     (`stg` general rule set, `request` this reader request's requirements or
 *     `editorial` preferences), a hard/soft classification and its
 *     applicability criterion and output list;
 *   - **outcomes** keyed by the pair (rule id, output id), so one rule applies
 *     to several chapters without duplicating its definition.
 *
 * Every expected applicable pair is evaluated: a pair with no recorded outcome
 * is unresolved rather than absent, so the coverage of the assessment stays
 * visible. A `pass` or `fail` without evidence is downgraded to unresolved
 * instead of disappearing. A hard rule that is `not_applicable` for an output
 * does not fail that output. CAR uses hard rules only and is computed under an
 * explicit aggregation policy; a definitively failed output stays failed even
 * when another of its checks is unresolved, and the value is held back with
 * bounds whenever any evaluated output is unresolved.
 */

import { fail, isPlainObject } from './errors.mjs';

export const RULE_REGISTRY_VERSION = 'stg-rules.v1';
export const RULE_SOURCES = ['stg', 'request', 'editorial'];
export const RULE_CLASSES = ['hard', 'soft'];
export const RULE_OUTCOMES = ['pass', 'fail', 'unresolved', 'not_applicable'];
export const AGGREGATION_POLICIES = ['all_applicable_pass', 'no_applicable_fail'];
const DEFAULT_POLICY = 'all_applicable_pass';

function outputKey(value) {
  return String(value);
}

function readOutputRef(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail(`${label} must be a string or number output identifier`, 'INVALID_RULES');
  }
  if (typeof value === 'string' && value.length === 0) fail(`${label} must not be empty`, 'INVALID_RULES');
  return value;
}

function parseDefinitions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('requirements.rules must be a non-empty array of rule definitions', 'INVALID_RULES');
  }
  const seen = new Set();
  const rules = [];
  for (const rule of raw) {
    if (!isPlainObject(rule)) fail('requirements.rules contains a non-object entry', 'INVALID_RULES');
    if (typeof rule.id !== 'string' || rule.id.length === 0) {
      fail('a rule definition must have a non-empty string id', 'INVALID_RULES');
    }
    if (seen.has(rule.id)) fail(`duplicate rule id ${JSON.stringify(rule.id)} in the registry`, 'DUPLICATE_ID');
    seen.add(rule.id);
    if (typeof rule.description !== 'string' || rule.description.length === 0) {
      fail(`rule ${JSON.stringify(rule.id)} must carry a description of what it requires`, 'INVALID_RULES');
    }
    if (!RULE_SOURCES.includes(rule.source)) {
      fail(
        `rule ${JSON.stringify(rule.id)}.source must be one of ${RULE_SOURCES.join('|')} ` +
          '(stg: the general rule set, request: this request\'s requirements, editorial: preferences)',
        'INVALID_RULES',
      );
    }
    const classification = rule.classification ?? 'hard';
    if (!RULE_CLASSES.includes(classification)) {
      fail(`rule ${JSON.stringify(rule.id)}.classification must be one of ${RULE_CLASSES.join('|')}`, 'INVALID_RULES');
    }
    if (typeof rule.criterion !== 'string' || rule.criterion.length === 0) {
      fail(`rule ${JSON.stringify(rule.id)} must state its applicability criterion`, 'INVALID_RULES');
    }
    let appliesTo;
    if (rule.applies_to === 'all') {
      appliesTo = 'all';
    } else if (Array.isArray(rule.applies_to) && rule.applies_to.length > 0) {
      appliesTo = rule.applies_to.map((value) => readOutputRef(value, `rule ${rule.id}.applies_to`));
    } else {
      fail(`rule ${JSON.stringify(rule.id)}.applies_to must be "all" or a non-empty list of outputs`, 'INVALID_RULES');
    }
    rules.push({
      id: rule.id,
      description: rule.description,
      source: rule.source,
      classification,
      criterion: rule.criterion,
      applies_to: appliesTo,
      evidence_required: rule.evidence_required !== false,
    });
  }
  return rules;
}

function parseOutcomes(raw, rules, population) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('requirements.outcomes must be an array', 'INVALID_RULES');
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const populationKeys = new Set(population.map(outputKey));
  const seen = new Set();
  const outcomes = [];
  for (const outcome of raw) {
    if (!isPlainObject(outcome)) fail('requirements.outcomes contains a non-object entry', 'INVALID_RULES');
    if (typeof outcome.rule !== 'string' || outcome.rule.length === 0) {
      fail('an outcome must name the rule it records', 'INVALID_RULES');
    }
    const rule = byId.get(outcome.rule);
    if (!rule) {
      fail(`outcome names unknown rule ${JSON.stringify(outcome.rule)}; no failure may come from an unconfigured rule`, 'UNKNOWN_RULE');
    }
    const output = readOutputRef(outcome.output, `outcome of rule ${rule.id}`);
    if (!populationKeys.has(outputKey(output))) {
      fail(
        `outcome of rule ${JSON.stringify(rule.id)} names output ${output}, which is outside the declared population ` +
          `(${population.join(', ') || 'none'})`,
        'INVALID_RULES',
      );
    }
    if (rule.applies_to !== 'all' && !rule.applies_to.map(outputKey).includes(outputKey(output))) {
      fail(
        `outcome of rule ${JSON.stringify(rule.id)} names output ${output}, which the rule does not apply to`,
        'INVALID_RULES',
      );
    }
    const key = `${rule.id}\u0000${outputKey(output)}`;
    if (seen.has(key)) {
      fail(`duplicate outcome for rule ${JSON.stringify(rule.id)} and output ${output}`, 'DUPLICATE_ID');
    }
    seen.add(key);
    if (!RULE_OUTCOMES.includes(outcome.outcome)) {
      fail(
        `outcome of rule ${JSON.stringify(rule.id)} for output ${output} must be one of ${RULE_OUTCOMES.join('|')}`,
        'INVALID_RULES',
      );
    }
    const evidence = outcome.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.some((id) => typeof id !== 'string' || id.length === 0)) {
      fail(`outcome of rule ${JSON.stringify(rule.id)} evidence must be an array of evidence ids`, 'INVALID_RULES');
    }
    let resolved = outcome.outcome;
    let reason = typeof outcome.reason === 'string' && outcome.reason.length > 0 ? outcome.reason : null;
    if ((resolved === 'pass' || resolved === 'fail') && rule.evidence_required && evidence.length === 0) {
      resolved = 'unresolved';
      reason = 'no evidence supplied for the recorded outcome';
    }
    outcomes.push({
      rule: rule.id,
      output,
      outcome: resolved,
      recorded_outcome: outcome.outcome,
      evidence: [...evidence],
      reason,
      recorded: true,
    });
  }
  return outcomes;
}

/**
 * Parse `annotations.requirements` (or a bare array of outcomes for a ruleless
 * legacy document is rejected) into a rule set with its expected pairs.
 */
export function parseRuleSet(raw) {
  if (raw === undefined || raw === null) {
    return {
      registry_version: RULE_REGISTRY_VERSION,
      aggregation_policy: DEFAULT_POLICY,
      rules: [],
      outcomes: [],
      problems: [],
    };
  }
  if (!isPlainObject(raw)) fail('annotations.requirements must be an object', 'INVALID_RULES');
  const registryVersion = raw.registry_version === undefined ? RULE_REGISTRY_VERSION : raw.registry_version;
  if (registryVersion !== RULE_REGISTRY_VERSION) {
    fail(
      `unsupported requirements.registry_version ${JSON.stringify(registryVersion)}; ` +
        `expected ${JSON.stringify(RULE_REGISTRY_VERSION)}`,
      'SCHEMA_VERSION',
    );
  }
  const policy = raw.aggregation_policy === undefined ? DEFAULT_POLICY : raw.aggregation_policy;
  if (!AGGREGATION_POLICIES.includes(policy)) {
    fail(
      `requirements.aggregation_policy must be one of ${AGGREGATION_POLICIES.join('|')}`,
      'INVALID_RULES',
    );
  }
  const rules = parseDefinitions(raw.rules);
  if (raw.outcomes !== undefined && !Array.isArray(raw.outcomes)) {
    fail('requirements.outcomes must be an array', 'INVALID_RULES');
  }
  return { registry_version: registryVersion, aggregation_policy: policy, rules, outcomes: raw.outcomes ?? [], raw };
}

/**
 * Evaluate every expected applicable pair against the recorded outcomes and
 * compute CAR over the declared output population.
 */
export function computeCar(ruleSet, population) {
  const { rules, aggregation_policy: policy } = ruleSet;
  const populationKeys = population.map(outputKey);
  const outcomes = parseOutcomes(ruleSet.outcomes, rules, population);
  const recordedByKey = new Map(outcomes.map((outcome) => [`${outcome.rule}\u0000${outputKey(outcome.output)}`, outcome]));

  const expected = [];
  for (const rule of rules) {
    for (const output of population) {
      const applies =
        rule.applies_to === 'all' || rule.applies_to.map(outputKey).includes(outputKey(output));
      if (!applies) continue;
      const key = `${rule.id}\u0000${outputKey(output)}`;
      expected.push({ rule, output, outcome: recordedByKey.get(key) ?? {
        rule: rule.id,
        output,
        outcome: 'unresolved',
        recorded_outcome: null,
        evidence: [],
        reason: 'no outcome recorded for this applicable rule',
        recorded: false,
      } });
    }
  }

  const evaluated = [];
  let passing = 0;
  let failing = 0;
  let unresolvedOutputs = 0;
  let notApplicable = 0;
  const failures = [];
  const unresolved = [];
  for (const output of population) {
    const pairs = expected.filter((pair) => outputKey(pair.output) === outputKey(output) && pair.rule.classification === 'hard');
    const applicable = pairs.filter((pair) => pair.outcome.outcome !== 'not_applicable');
    if (applicable.length === 0) {
      notApplicable += 1;
      continue;
    }
    evaluated.push(output);
    const failed = applicable.filter((pair) => pair.outcome.outcome === 'fail');
    const pending = applicable.filter((pair) => pair.outcome.outcome === 'unresolved');
    for (const pair of failed) {
      failures.push({
        rule: pair.rule.id,
        output: pair.output,
        description: pair.rule.description,
        source: pair.rule.source,
        classification: pair.rule.classification,
        criterion: pair.rule.criterion,
        evidence: pair.outcome.evidence,
      });
    }
    for (const pair of pending) {
      unresolved.push({
        rule: pair.rule.id,
        output: pair.output,
        description: pair.rule.description,
        source: pair.rule.source,
        criterion: pair.rule.criterion,
        recorded: pair.outcome.recorded,
        reason: pair.outcome.reason,
        evidence: pair.outcome.evidence,
      });
    }
    if (failed.length > 0) {
      failing += 1;
    } else if (pending.length > 0 && policy === 'all_applicable_pass') {
      unresolvedOutputs += 1;
    } else {
      passing += 1;
    }
  }

  const evaluatedCount = evaluated.length;
  const recordedExpected = expected.filter((pair) => pair.outcome.recorded).length;
  const base = {
    aggregation_policy: policy,
    registry_version: ruleSet.registry_version,
    evaluated_outputs: evaluatedCount,
    passing_outputs: passing,
    failing_outputs: failing,
    unresolved_outputs: unresolvedOutputs,
    not_applicable_outputs: notApplicable,
    expected_outcomes: expected.length,
    recorded_outcomes: recordedExpected,
    outcome_coverage: expected.length === 0 ? null : recordedExpected / expected.length,
    soft_rules: rules.filter((rule) => rule.classification === 'soft').length,
    pairs: expected.map((pair) => ({
      rule: pair.rule.id,
      output: pair.output,
      description: pair.rule.description,
      source: pair.rule.source,
      classification: pair.rule.classification,
      criterion: pair.rule.criterion,
      outcome: pair.outcome.outcome,
      recorded_outcome: pair.outcome.recorded_outcome,
      recorded: pair.outcome.recorded,
      evidence: pair.outcome.evidence,
      reason: pair.outcome.reason,
    })),
    failures,
    unresolved,
  };

  if (evaluatedCount === 0) {
    return {
      ...base,
      status: 'not_applicable',
      value: null,
      coverage: null,
      lower_bound: null,
      upper_bound: null,
      missing_reason: 'no declared output has an applicable hard rule',
    };
  }
  if (unresolvedOutputs > 0) {
    return {
      ...base,
      status: 'computed',
      value: null,
      coverage: (passing + failing) / evaluatedCount,
      lower_bound: (100 * passing) / evaluatedCount,
      upper_bound: (100 * (passing + unresolvedOutputs)) / evaluatedCount,
      missing_reason:
        `${unresolvedOutputs} output(s) have an unresolved check; the value is held back and its bounds are ` +
        `reported under the "${policy}" aggregation policy`,
    };
  }
  return {
    ...base,
    status: 'computed',
    value: (100 * passing) / evaluatedCount,
    coverage: 1,
    lower_bound: null,
    upper_bound: null,
    missing_reason: null,
  };
}

/** Rules of one source, for the two compliance views. */
export function rulesOfSource(rules, source) {
  return rules.filter((rule) => rule.source === source);
}
