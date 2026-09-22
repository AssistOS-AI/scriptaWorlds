/**
 * Stable registry: the twelve named metrics and the eight literary indicators.
 *
 * VAD and BCI are reserved names (mentioned in the source document without a
 * sufficient definition); they are deliberately NOT implemented as values and
 * are rejected if they appear as an annotation metric id.
 */

export const RESULT_STATUSES = ['computed', 'judged', 'not_assessable', 'not_applicable', 'error'];

/**
 * Discriminated output type of a metric's `value` field (C16):
 *   `scalar`     — `value` is the measurement and `unit` names its scale;
 *   `components` — `value` is null, or a scalar derived from the components
 *                  under a versioned rubric profile; `components` carries the
 *                  anchored component records;
 *   `trajectory` — `value` is null and `trajectory` carries the ordered series.
 * A generic renderer must not assume every `value` is numeric.
 */
export const VALUE_KINDS = ['scalar', 'components', 'trajectory'];

export const REGISTRY_VERSION = 'metrics.v1';
export const DEFINITION_VERSION = '1.0';

/** Anchored component definitions of the judged rubric metrics (C17). */
export const COMPONENT_SPECS = {
  CS: {
    metric: 'CS',
    input_key: 'dimensions',
    components: ['referential_clarity', 'discourse_connection', 'causal_support', 'temporal_intelligibility'],
  },
  OI: {
    metric: 'OI',
    input_key: 'dimensions',
    components: ['perspective', 'dramatic_development', 'expression'],
    requires_comparison_scope: true,
  },
  NCS: {
    metric: 'NCS',
    input_key: 'dimensions',
    components: ['novelty', 'cliche_reliance'],
    pair_only: true,
  },
};

/** Anchored rating scale shared by the component rubric. */
export const ANCHOR_SCALE = 4;

export const METRIC_IDS = [
  'CS',
  'NQS',
  'CCI',
  'CAD',
  'EAP',
  'CAR',
  'OI',
  'SI',
  'NCS',
  'CR',
  'TOP',
  'AEG',
];

export const RESERVED_METRIC_IDS = ['VAD', 'BCI'];

export const INDICATOR_IDS = [
  'narrative_coherence',
  'thematic_depth',
  'character_complexity',
  'originality',
  'stylistic_quality',
  'emotional_impact',
  'interpretive_openness',
  'cultural_value',
];

const DIRECTION = {
  higher_better: 'higher_better',
  higher_worse: 'higher_worse',
  non_ordinal: 'non_ordinal',
  neutral: 'neutral',
};

function metric(id, fields) {
  return {
    id,
    definition_version: DEFINITION_VERSION,
    registry_version: REGISTRY_VERSION,
    value_kind: 'scalar',
    ...fields,
  };
}

export const METRICS = {
  CS: metric('CS', {
    name: 'Coherence Score',
    purpose: 'Assess whether discourse, referents, events and causal/temporal relations form an intelligible account.',
    method: 'Anchored 0-4 ratings of referential clarity, discourse connection, causal support and temporal intelligibility; composite only when all four dimensions are assessable.',
    direction: DIRECTION.higher_better,
    value_kind: 'components',
    unit: '0-100 derived from four anchored 0-4 dimensions',
    range: [0, 100],
    inputs: ['accepted text segments', 'event/referent annotations', 'structural intent', 'continuity findings'],
    limitations: 'Semantic resemblance does not establish causality; deliberate non-linearity or unreliable narration can be coherent.',
  }),
  NQS: metric('NQS', {
    name: 'Narrative Quality Score',
    purpose: 'A composite comparison of narrative quality against an explicit profile.',
    method: 'Weighted sum of compatible CS, OI and a separately judged emotional-fit component; disabled by default.',
    direction: DIRECTION.higher_better,
    unit: '0-100',
    range: [0, 100],
    inputs: ['CS', 'OI', 'EAP emotional-fit judgement'],
    limitations: 'Weights are a research experiment, not an endorsed formula; the result fits a profile, not universal literary value.',
  }),
  CCI: metric('CCI', {
    name: 'Continuity Control Indicator',
    purpose: 'Track consistency of entities, facts, chronology and events across the selected narrative units.',
    method: 'Count consistent, contradicted and unresolved comparisons; index is 100 * consistent / resolved when fully resolved and positive.',
    direction: DIRECTION.higher_better,
    unit: '0-100',
    range: [0, 100],
    inputs: ['declared comparisons', 'temporal scopes', 'paired evidence', 'continuity outcomes'],
    limitations: 'Selection bias and omitted evidence can hide errors; a small clean sample is not global continuity.',
  }),
  CAD: metric('CAD', {
    name: 'Character Attribute Drift',
    purpose: 'Detect unsupported changes in character properties or behaviour while allowing development.',
    method: 'Classify eligible changes as supported, unsupported or unresolved; rate is 100 * unsupported / resolved_changes when non-empty and fully resolved.',
    direction: DIRECTION.higher_worse,
    unit: '0-100',
    range: [0, 100],
    inputs: ['baseline attribute evidence', 'candidate later changes', 'chronology', 'character knowledge'],
    limitations: 'Psychological plausibility is interpretive; identity can be intentionally unstable.',
  }),
  EAP: metric('EAP', {
    name: 'Emotional Arc Profile',
    purpose: 'Describe emotional progression across scenes, chapters and the work.',
    method: 'Annotate valence -2..2 and tension/intensity 0..4 with rubric anchors, preserving scene order and transitions.',
    direction: DIRECTION.non_ordinal,
    value_kind: 'trajectory',
    unit: 'valence -2..2 and tension 0..4 per ordered segment',
    range: null,
    axes: { valence: [-2, 2], tension: [0, 4] },
    inputs: ['ordered segments', 'focal character', 'evidence', 'optional intended arc'],
    limitations: 'High tension is not automatically good; a predicted effect is not measured reader response.',
  }),
  CAR: metric('CAR', {
    name: 'Compliance Adherence Rate',
    purpose: 'Measure adherence to an explicit specification across generated outputs.',
    method: 'An output passes when all its applicable mandatory rules pass; 100 * passing_outputs / evaluated_outputs over the declared population.',
    direction: DIRECTION.higher_better,
    unit: '0-100',
    range: [0, 100],
    inputs: ['versioned applicable mandatory rules', 'declared output population', 'per-rule outcomes with evidence'],
    limitations: 'Says nothing about whether the rules produce good fiction; it is not a legal certification.',
  }),
  OI: metric('OI', {
    name: 'Originality Index',
    purpose: 'Assess fresh execution relative to previously observed material.',
    method: 'Anchored 0-4 ratings of perspective, dramatic development and expression; index with complete ratings and an explicit comparison scope.',
    direction: DIRECTION.higher_better,
    value_kind: 'components',
    unit: '0-100 derived from three anchored 0-4 dimensions',
    range: [0, 100],
    inputs: ['candidate prose', 'genre intention', 'declared reference scope', 'semantic annotations'],
    limitations: 'OI is not 100 - SI; incoherent word salad can have low similarity.',
  }),
  SI: metric('SI', {
    name: 'Similarity Index',
    purpose: 'Quantify resemblance between selected texts.',
    method: 'Jaccard of distinct 5-token shingles per eligible pair; value is the maximum over the named corpus.',
    direction: DIRECTION.neutral,
    unit: '0-1',
    range: [0, 1],
    inputs: ['candidate tokens', 'identified references', 'tokenizer configuration'],
    limitations: 'Reflects quotation, recurring names, genre language or duplication; not a moral or literary judgement.',
  }),
  NCS: metric('NCS', {
    name: 'Novelty & Cliché Score',
    purpose: 'Distinguish fresh execution from overused expression or narrative machinery.',
    method: 'Two dimensions: novelty of execution and cliché reliance, each anchored 0-4 with passages and scene-level evidence.',
    direction: DIRECTION.non_ordinal,
    value_kind: 'components',
    unit: 'two anchored 0-4 dimensions, no combined score',
    range: null,
    component_scale: [0, 4],
    inputs: ['prose', 'recent scene patterns', 'declared comparison corpus', 'genre conventions'],
    limitations: 'Corpus frequency, evaluator taste and cultural familiarity bias both dimensions.',
  }),
  CR: metric('CR', {
    name: 'Contamination Rate',
    purpose: 'Assess overlap between evaluation data and a model\'s training data.',
    method: 'Fraction of eligible evaluation items meeting the declared contamination criterion, with exact evidence and dataset coverage.',
    direction: DIRECTION.higher_worse,
    unit: '0-100',
    range: [0, 100],
    inputs: ['relevant training corpus', 'evaluation items', 'model/data version', 'overlap criteria'],
    limitations: 'Normally unavailable for a hosted model\'s undisclosed training set; a reference library is not training data.',
  }),
  TOP: metric('TOP', {
    name: 'Textual Overlap Percentage',
    purpose: 'Show how much candidate text overlaps declared references.',
    method: 'Union of exact matching runs of at least 8 tokens across references; 100 * matched_positions / eligible_tokens.',
    direction: DIRECTION.neutral,
    unit: '0-100',
    range: [0, 100],
    inputs: ['eligible candidate tokens', 'byte mappings', 'named references'],
    limitations: 'Does not establish semantic borrowing, training memorization, plagiarism or copyright compliance.',
  }),
  AEG: metric('AEG', {
    name: 'Author Efficiency Gain',
    purpose: 'Measure reduction in human time required to produce comparable accepted work.',
    method: '100 * (baseline_active_minutes - assisted_active_minutes) / baseline_active_minutes over opt-in matched records; a positive baseline is required and a negative result is a real result.',
    direction: DIRECTION.higher_better,
    unit: '%, negative when the assisted task took longer than its baseline',
    range: [-100, 100],
    inputs: ['matched unassisted and assisted timing records', 'quality acceptance', 'interruption records'],
    limitations: 'Server elapsed time is not human effort; a small uncontrolled sample is not causal evidence.',
  }),
};

export const INDICATORS = {
  narrative_coherence: {
    id: 'narrative_coherence',
    name: 'Narrative coherence',
    categories: ['Low', 'Medium', 'High'],
  },
  thematic_depth: {
    id: 'thematic_depth',
    name: 'Thematic depth',
    categories: ['Superficial', 'Moderate', 'Profound'],
  },
  character_complexity: {
    id: 'character_complexity',
    name: 'Character complexity',
    categories: ['Simple', 'Moderate', 'Complex'],
  },
  originality: {
    id: 'originality',
    name: 'Originality',
    categories: ['Low', 'Partial', 'High'],
  },
  stylistic_quality: {
    id: 'stylistic_quality',
    name: 'Stylistic quality',
    categories: ['Poor', 'Acceptable', 'Excellent'],
  },
  emotional_impact: {
    id: 'emotional_impact',
    name: 'Emotional impact',
    categories: ['Weak', 'Moderate', 'Strong'],
  },
  interpretive_openness: {
    id: 'interpretive_openness',
    name: 'Interpretive openness',
    categories: ['Closed', 'Partially open', 'Open'],
  },
  cultural_value: {
    id: 'cultural_value',
    name: 'Cultural value',
    categories: ['Local', 'Regional', 'Universal'],
  },
};

export function isMetricId(id) {
  return METRIC_IDS.includes(id);
}

export function isReservedMetricId(id) {
  return RESERVED_METRIC_IDS.includes(id);
}
