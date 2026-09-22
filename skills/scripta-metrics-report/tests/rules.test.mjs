import test from 'node:test';
import assert from 'node:assert/strict';

import { computeCar, parseRuleSet, rulesOfSource } from '../scripts/lib/rules.mjs';
import {
  createEvidenceCollector,
  normalizeAnnMetrics,
  normalizeContinuity,
  normalizeFindings,
  normalizeIndicators,
  normalizePreserved,
} from '../scripts/lib/annotations.mjs';
import { sha256 } from './helpers.mjs';

const OUTPUTS = [1, 2];

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

function ruleSet(rules, outcomes, policy) {
  const raw = { registry_version: 'stg-rules.v1', rules, outcomes };
  if (policy) raw.aggregation_policy = policy;
  const parsed = parseRuleSet(raw);
  return { parsed, car: computeCar(parsed, OUTPUTS) };
}

function rule(id, overrides = {}) {
  return {
    id,
    description: `rule ${id}`,
    source: 'stg',
    classification: 'hard',
    criterion: 'every declared output',
    applies_to: 'all',
    ...overrides,
  };
}

function outcome(ruleId, output, value, evidence = ['ev1'], extra = {}) {
  return { rule: ruleId, output, outcome: value, evidence, ...extra };
}

/* ------------------------------ rule registry and CAR (C21) ------------------------------ */

test('CAR is 100 when every output passes, and one rule can apply to several outputs', () => {
  const { car } = ruleSet(
    [rule('stg-1')],
    [outcome('stg-1', 1, 'pass'), outcome('stg-1', 2, 'pass')],
  );
  assert.equal(car.status, 'computed');
  assert.equal(car.value, 100);
  assert.equal(car.evaluated_outputs, 2);
  assert.equal(car.passing_outputs, 2);
  assert.equal(car.expected_outcomes, 2, 'the same definition is applied to both outputs');
  assert.equal(car.recorded_outcomes, 2);
  assert.equal(car.outcome_coverage, 1);
  assert.equal(car.aggregation_policy, 'all_applicable_pass');
});

test('a mandatory rule that is not applicable does not fail its output', () => {
  const { car } = ruleSet(
    [rule('stg-1'), rule('stg-2', { applies_to: [1] })],
    [outcome('stg-1', 1, 'pass'), outcome('stg-2', 1, 'not_applicable'), outcome('stg-1', 2, 'pass')],
  );
  assert.equal(car.value, 100);
  assert.equal(car.failing_outputs, 0);
  assert.equal(car.not_applicable_outputs, 0, 'output 1 still has one applicable hard rule');
});

test('an output whose only hard rules are not applicable is excluded and counted', () => {
  const { car } = ruleSet(
    [rule('stg-1', { applies_to: [2] })],
    [outcome('stg-1', 2, 'pass')],
  );
  assert.equal(car.not_applicable_outputs, 1);
  assert.equal(car.evaluated_outputs, 1);
  assert.equal(car.value, 100);
});

test('CAR is not_applicable when no output has an applicable hard rule', () => {
  const { car } = ruleSet([rule('stg-1', { applies_to: [99] })], []);
  assert.equal(car.status, 'not_applicable');
  assert.equal(car.value, null);
  assert.equal(car.missing_reason, 'no declared output has an applicable hard rule');
});

test('an omitted required outcome reduces coverage and holds the value back with bounds', () => {
  const { car } = ruleSet([rule('stg-1')], [outcome('stg-1', 1, 'pass')]);
  assert.equal(car.expected_outcomes, 2);
  assert.equal(car.recorded_outcomes, 1);
  assert.equal(car.outcome_coverage, 0.5);
  assert.equal(car.unresolved_outputs, 1);
  assert.equal(car.value, null);
  assert.equal(car.coverage, 0.5);
  assert.deepEqual([car.lower_bound, car.upper_bound], [50, 100]);
  assert.ok(car.missing_reason.includes('unresolved check'), car.missing_reason);
  assert.equal(car.unresolved[0].rule, 'stg-1');
  assert.equal(car.unresolved[0].output, 2);
  assert.equal(car.unresolved[0].recorded, false);
  assert.ok(car.unresolved[0].reason.includes('no outcome recorded'));
});

test('a pass or fail without evidence stays unresolved instead of disappearing', () => {
  const { car } = ruleSet([rule('stg-1')], [outcome('stg-1', 1, 'pass', []), outcome('stg-1', 2, 'pass')]);
  const first = car.pairs.find((pair) => pair.output === 1);
  assert.equal(first.recorded_outcome, 'pass');
  assert.equal(first.outcome, 'unresolved');
  assert.ok(first.reason.includes('no evidence supplied'), first.reason);
  assert.equal(car.unresolved_outputs, 1);
  assert.equal(car.failures.length, 0, 'no failure may be reported without evidence');
});

test('a definitively failed output stays failed even with another unresolved check', () => {
  const { car } = ruleSet(
    [rule('stg-1'), rule('stg-2')],
    [
      { rule: 'stg-1', output: 1, outcome: 'fail', evidence: ['ev2'] },
      { rule: 'stg-2', output: 1, outcome: 'unresolved', evidence: [], reason: 'the passage could not be inspected' },
      outcome('stg-1', 2, 'pass'),
      outcome('stg-2', 2, 'pass'),
    ],
  );
  assert.equal(car.failing_outputs, 1);
  assert.equal(car.unresolved_outputs, 0);
  assert.equal(car.value, 50);
  assert.equal(car.coverage, 1);
  assert.equal(car.failures.length, 1);
  const failure = car.failures[0];
  assert.equal(failure.rule, 'stg-1');
  assert.equal(failure.output, 1);
  assert.equal(failure.description, 'rule stg-1');
  assert.equal(failure.source, 'stg');
  assert.deepEqual(failure.evidence, ['ev2']);
});

test('the aggregation policy is explicit: unresolved checks hold a value back only under all_applicable_pass', () => {
  const lenient = ruleSet(
    [rule('stg-1'), rule('stg-2')],
    [outcome('stg-1', 1, 'pass'), { rule: 'stg-2', output: 1, outcome: 'unresolved', evidence: [], reason: 'pending' }, outcome('stg-1', 2, 'pass'), outcome('stg-2', 2, 'pass')],
    'no_applicable_fail',
  );
  assert.equal(lenient.car.aggregation_policy, 'no_applicable_fail');
  assert.equal(lenient.car.value, 100);
  assert.equal(lenient.car.unresolved.length, 1, 'the unresolved check is still reported');
});

test('soft rules never affect CAR and their source is preserved', () => {
  const { car } = ruleSet(
    [
      rule('stg-1'),
      rule('ed-1', { source: 'editorial', classification: 'soft' }),
      rule('req-1', { source: 'request', applies_to: [1] }),
    ],
    [outcome('stg-1', 1, 'pass'), outcome('ed-1', 1, 'fail', ['ev9']), outcome('req-1', 1, 'pass'), outcome('stg-1', 2, 'pass')],
  );
  assert.equal(car.value, 100);
  assert.equal(car.soft_rules, 1);
  assert.equal(car.pairs.filter((pair) => pair.source === 'editorial').length, 2);
  assert.equal(car.pairs.filter((pair) => pair.source === 'request').length, 1);
  assert.deepEqual(rulesOfSource(parseRuleSet({ registry_version: 'stg-rules.v1', rules: [rule('stg-1'), rule('ed-1', { source: 'editorial' })], outcomes: [] }).rules, 'stg').map((r) => r.id), ['stg-1']);
});

test('rule definitions and outcomes are validated before use', () => {
  assertCode(() => parseRuleSet({ registry_version: 'stg-rules.v0', rules: [rule('a')], outcomes: [] }), 'SCHEMA_VERSION');
  assertCode(() => parseRuleSet({ rules: [rule('a'), rule('a')], outcomes: [] }), 'DUPLICATE_ID');
  assertCode(() => parseRuleSet({ rules: [rule('a', { source: 'guess' })], outcomes: [] }), 'INVALID_RULES');
  assertCode(() => parseRuleSet({ rules: [rule('a', { classification: 'nice-to-have' })], outcomes: [] }), 'INVALID_RULES');
  assertCode(() => parseRuleSet({ rules: [rule('a', { applies_to: [] })], outcomes: [] }), 'INVALID_RULES');
  assertCode(() => parseRuleSet({ rules: [rule('a'), rule('b')], outcomes: [], aggregation_policy: 'whatever' }), 'INVALID_RULES');
  assertCode(() => parseRuleSet({ rules: [{ ...rule('a'), description: '' }], outcomes: [] }), 'INVALID_RULES');
  assertCode(() => ruleSet([rule('a')], [outcome('missing', 1, 'pass')]), 'UNKNOWN_RULE');
  assertCode(
    () => ruleSet([rule('a')], [outcome('a', 1, 'pass'), outcome('a', 1, 'pass')]),
    'DUPLICATE_ID',
  );
  assertCode(
    () => ruleSet([rule('a', { applies_to: [1] })], [outcome('a', 2, 'pass')]),
    'INVALID_RULES',
  );
  assertCode(() => ruleSet([rule('a')], [outcome('a', 'nope', 'pass')]), 'INVALID_RULES');
  assertCode(() => ruleSet([rule('a')], [{ rule: 'a', output: 1, outcome: 'maybe', evidence: ['ev1'] }]), 'INVALID_RULES');
});

test('no rule set declared means CAR is not applicable, not a perfect score', () => {
  const parsed = parseRuleSet(undefined);
  assert.deepEqual(parsed.rules, []);
  const car = computeCar(parsed, OUTPUTS);
  assert.equal(car.status, 'not_applicable');
  assert.equal(car.value, null);
});

/* ------------------------------ semantic annotations (C13) ------------------------------ */

const FILES = [
  { path: 'chapters/0001.md', role: 'chapter', chapter: 1, sha256: sha256(Buffer.from('the sea at dawn', 'utf8')), bytes: 15, buffer: Buffer.from('the sea at dawn', 'utf8') },
];

function collector() {
  return createEvidenceCollector(FILES);
}

function evidenceItem(overrides = {}) {
  return {
    id: 'ev1',
    file: 'chapters/0001.md',
    sha256: FILES[0].sha256,
    start: 4,
    end: 7,
    quote: 'sea',
    ...overrides,
  };
}

function finding(overrides = {}) {
  return {
    id: 'f1',
    kind: 'contradiction',
    severity: 'local',
    certainty: 'deterministic',
    status: 'confirmed',
    description: 'the light changes between two mentions',
    evidence: [evidenceItem(), evidenceItem({ id: 'ev2', start: 8, end: 15, quote: 'at dawn' })],
    temporal: { baseline: ['ev1'], later: ['ev2'] },
    ...overrides,
  };
}

test('a confirmed contradiction needs evidence and a temporal baseline/later pair', () => {
  assertCode(() => normalizeFindings([finding({ evidence: [] })], collector()), 'INVALID_EVIDENCE');
  assertCode(() => normalizeFindings([finding({ temporal: undefined })], collector()), 'INVALID_FINDING');
  assertCode(
    () => normalizeFindings([finding({ evidence: [evidenceItem()], temporal: { baseline: ['ev1'], later: ['ev2'] } })], collector()),
    'INVALID_FINDING',
  );
  assertCode(() => normalizeFindings([finding({ temporal: { baseline: ['ev1'], later: ['ev1'] } })], collector()), 'INVALID_FINDING');
  const ok = normalizeFindings(
    [
      finding({
        evidence: [evidenceItem(), evidenceItem({ id: 'ev2', start: 8, end: 15, quote: 'at dawn' })],
        temporal: { baseline: ['ev1'], later: ['ev2'] },
      }),
    ],
    collector(),
  );
  assert.deepEqual(ok[0].temporal, { baseline: ['ev1'], later: ['ev2'] });
  assert.deepEqual(ok[0].evidence, ['ev1', 'ev2']);
});

test('findings are validated: ids, enums, container types and fabricated quotes', () => {
  assertCode(() => normalizeFindings([finding(), finding()], collector()), 'DUPLICATE_ID');
  assertCode(() => normalizeFindings([finding({ kind: 'banana' })], collector()), 'INVALID_FINDING');
  assertCode(() => normalizeFindings([finding({ severity: 'total' })], collector()), 'INVALID_FINDING');
  assertCode(() => normalizeFindings([finding({ certainty: 'certain' })], collector()), 'INVALID_FINDING');
  assertCode(() => normalizeFindings([finding({ status: 'probably' })], collector()), 'INVALID_FINDING');
  assertCode(() => normalizeFindings([finding({ description: '' })], collector()), 'INVALID_FINDING');
  assertCode(() => normalizeFindings([finding({ evidence: 'ev1' })], collector()), 'INVALID_ANNOTATIONS');
  assertCode(
    () => normalizeFindings([finding({ evidence: [evidenceItem({ quote: 'fabricated quote' })] })], collector()),
    'INVALID_EVIDENCE',
  );
  assertCode(() => normalizeFindings([finding({ evidence: ['ev9'] })], collector()), 'UNKNOWN_EVIDENCE');
  assertCode(
    () => normalizeFindings([finding({ evidence: [evidenceItem()], temporal: undefined })], collector()),
    'INVALID_FINDING',
  );
});

test('an unresolved reading and its alternative explanation are preserved', () => {
  const findings = normalizeFindings(
    [
      finding({
        status: 'unresolved',
        temporal: undefined,
        alternative_explanation: 'The narrator may be unreliable here.',
        repair_suggestion: null,
      }),
    ],
    collector(),
  );
  assert.equal(findings[0].status, 'unresolved');
  assert.equal(findings[0].alternative_explanation, 'The narrator may be unreliable here.');
  assert.equal(findings[0].temporal, null);
});

test('indicators are validated against their declared categories', () => {
  const ok = normalizeIndicators([
    { id: 'narrative_coherence', status: 'judged', category: 'High', evidence: ['ev1'], rationale: 'recoverable', evaluator: 'human-1' },
  ]);
  assert.equal(ok.narrative_coherence.status, 'judged');
  assert.equal(ok.thematic_depth.status, 'not_assessable');
  assertCode(() => normalizeIndicators([{ id: 'narrative_coherence', status: 'judged', category: 'banana', evidence: ['ev1'], rationale: 'x', evaluator: 'h' }]), 'INVALID_INDICATOR');
  assertCode(() => normalizeIndicators([{ id: 'narrative_coherence', status: 'judged', evidence: ['ev1'], rationale: 'x', evaluator: 'h' }]), 'INVALID_INDICATOR');
  assertCode(() => normalizeIndicators([{ id: 'narrative_coherence', status: 'judged', category: 'High', evidence: [], rationale: 'x', evaluator: 'h' }]), 'INVALID_INDICATOR');
  assertCode(() => normalizeIndicators([{ id: 'narrative_coherence', status: 'judged', category: 'High', evidence: ['ev1'], evaluator: 'h' }]), 'INVALID_INDICATOR');
  assertCode(() => normalizeIndicators([{ id: 'narrative_coherence', status: 'judged', category: 'High', evidence: ['ev1'], rationale: 'x' }]), 'INVALID_INDICATOR');
  assertCode(() => normalizeIndicators([{ id: 'banana', status: 'judged' }]), 'UNKNOWN_INDICATOR');
  assertCode(
    () =>
      normalizeIndicators([
        { id: 'originality', status: 'judged', category: 'High', evidence: ['ev1'], rationale: 'x', evaluator: 'h' },
        { id: 'originality', status: 'judged', category: 'Low', evidence: ['ev1'], rationale: 'x', evaluator: 'h' },
      ]),
    'DUPLICATE_ID',
  );
  assertCode(() => normalizeIndicators('nope'), 'INVALID_INDICATOR');
});

test('metric annotation containers, ids and reserved names are validated before use', () => {
  assertCode(() => normalizeAnnMetrics('nope'), 'INVALID_ANNOTATIONS');
  assertCode(() => normalizeAnnMetrics({ banana: {} }), 'UNKNOWN_METRIC');
  assertCode(() => normalizeAnnMetrics({ VAD: { value: 5 } }), 'RESERVED_METRIC');
  assertCode(() => normalizeAnnMetrics({ BCI: { value: 5 } }), 'RESERVED_METRIC');
  assert.deepEqual(Object.keys(normalizeAnnMetrics({ CS: {} })), ['CS']);
  assert.deepEqual(normalizeAnnMetrics(undefined), {});
});

test('a continuity result with inconsistent totals or malformed containers is refused', () => {
  const base = {
    schema_version: 'continuity-result.v1',
    version: 'continuity-result.v1',
    counts: { eligible_comparisons: 1, consistent: 8, contradicted: 0, unresolved: 0 },
    findings: [],
  };
  assertCode(() => normalizeContinuity(base), 'INVALID_ANNOTATIONS');
  assertCode(() => normalizeContinuity({ ...base, counts: { eligible_comparisons: 1, consistent: 1 } }), 'INVALID_ANNOTATIONS');
  assertCode(() => normalizeContinuity({ ...base, schema_version: 'continuity-result.v2' }), 'SCHEMA_VERSION');
  assertCode(() => normalizeContinuity({ ...base, counts: { eligible_comparisons: 1, consistent: 1, contradicted: 0, unresolved: 0 }, findings: {} }), 'INVALID_ANNOTATIONS');
  assertCode(() => normalizeContinuity('nope'), 'INVALID_ANNOTATIONS');
  const ok = normalizeContinuity({
    schema_version: 'continuity-result.v1',
    version: 'continuity-result.v1',
    source_version: 'sha256:' + 'a'.repeat(64),
    counts: { eligible_comparisons: 2, consistent: 1, contradicted: 1, unresolved: 0 },
    scope: { chapters: [1], omitted: [], coverage_note: 'chapter 1 only' },
    findings: [],
  });
  assert.deepEqual(ok.chapters, [1]);
  assert.equal(ok.coverage_note, 'chapter 1 only');
  assert.equal(ok.source_version, 'sha256:' + 'a'.repeat(64));
});

test('preserved qualities require an id, a rationale and evidence ids', () => {
  const ok = normalizePreserved({ passages: [{ id: 'p1', evidence: ['ev1'], rationale: 'the image earns its place' }] });
  assert.equal(ok.passages[0].rationale, 'the image earns its place');
  assert.equal(normalizePreserved(undefined).passages.length, 0);
  assertCode(() => normalizePreserved({ passages: [{ id: 'p1', evidence: ['ev1'] }] }), 'INVALID_ANNOTATIONS');
  assertCode(() => normalizePreserved({ passages: [{ evidence: ['ev1'], rationale: 'x' }] }), 'INVALID_ANNOTATIONS');
  assertCode(() => normalizePreserved({ passages: [{ id: 'p1', evidence: [1], rationale: 'x' }] }), 'INVALID_ANNOTATIONS');
});
