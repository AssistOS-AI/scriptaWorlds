# assess check-mucsmkir — assess-check-mucsmkir

Assessment `980197ecb80985bfb8a29efd09886ae6` · version `sha256:5109d6185d55e9e68fbcebcb4200082e28123de18ca46bc5e5aed4ba7997f010` · scope book · language en

# Score Justification Report

Registry version `metrics.v1` · tokenizer version 2 (unicode-letter-run-v2+byte-offsets) · runtime v24.9.0.

## Metric justifications

### CS — Coherence Score

- Status: `not_assessable`
- Value: not assessable — no CS annotation supplied
- Value kind: `components`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-100 derived from four anchored 0-4 dimensions · higher_better
- Method: Anchored 0-4 ratings of referential clarity, discourse connection, causal support and temporal intelligibility; composite only when all four dimensions are assessable.
- Components:
- Components and arithmetic:
  - rubric: {"version":"rubric-anchors.v1","scale":4}
  - missing_dimensions: none
- Bounds: —
- Coverage: —
- Limits: Semantic resemblance does not establish causality; deliberate non-linearity or unreliable narration can be coherent.
- Missing: no CS annotation supplied

### NQS — Narrative Quality Score

- Status: `not_assessable`
- Value: not assessable — NQS is disabled by default; enable aggregation with a validated research profile to compute it
- Value kind: `scalar`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-100 · higher_better
- Method: Weighted sum of compatible CS, OI and a separately judged emotional-fit component; disabled by default.
- Components and arithmetic:
  - aggregation_policy: research
  - weights: —
  - emotional_fit_procedure: —
  - scope: —
  - corpus_version: —
  - rubric_version: —
  - calibration: —
  - inputs: {"CS":null,"OI":null,"EMOTIONAL_FIT":null}
- Bounds: —
- Coverage: —
- Limits: Weights are a research experiment, not an endorsed formula; the result fits a profile, not universal literary value.
- Missing: NQS is disabled by default; enable aggregation with a validated research profile to compute it

### CCI — Continuity Control Indicator

- Status: `not_assessable`
- Value: not assessable — no continuity-result.v1 supplied in the annotations bundle
- Value kind: `scalar`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-100 · higher_better
- Method: Count consistent, contradicted and unresolved comparisons; index is 100 * consistent / resolved when fully resolved and positive.
- Bounds: —
- Coverage: —
- Limits: Selection bias and omitted evidence can hide errors; a small clean sample is not global continuity.
- Missing: no continuity-result.v1 supplied in the annotations bundle

### CAD — Character Attribute Drift

- Status: `not_assessable`
- Value: not assessable — no continuity-result.v1 supplied in the annotations bundle
- Value kind: `scalar`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-100 · higher_worse
- Method: Classify eligible changes as supported, unsupported or unresolved; rate is 100 * unsupported / resolved_changes when non-empty and fully resolved.
- Bounds: —
- Coverage: —
- Limits: Psychological plausibility is interpretive; identity can be intentionally unstable.
- Missing: no continuity-result.v1 supplied in the annotations bundle

### EAP — Emotional Arc Profile

- Status: `not_assessable`
- Value: not assessable — no EAP annotation supplied
- Value kind: `trajectory`
- Scope: kind book · chapters 1, 2
- Unit and direction: valence -2..2 and tension 0..4 per ordered segment · non_ordinal
- Method: Annotate valence -2..2 and tension/intensity 0..4 with rubric anchors, preserving scene order and transitions.
- Bounds: —
- Coverage: —
- Limits: High tension is not automatically good; a predicted effect is not measured reader response.
- Missing: no EAP annotation supplied

### CAR — Compliance Adherence Rate

- Status: `not_applicable`
- Value: not applicable — no declared output has an applicable hard rule
- Value kind: `scalar`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-100 · higher_better
- Method: An output passes when all its applicable mandatory rules pass; 100 * passing_outputs / evaluated_outputs over the declared population.
- Components and arithmetic:
  - aggregation_policy: all_applicable_pass
  - registry_version: stg-rules.v1
  - evaluated_outputs: 0
  - passing_outputs: 0
  - failing_outputs: 0
  - unresolved_outputs: 0
  - not_applicable_outputs: 2
  - expected_outcomes: 0
  - recorded_outcomes: 0
  - outcome_coverage: —
  - soft_rules: 0
  - pairs: none
  - failures: none
  - unresolved: none
- Bounds: —
- Coverage: —
- Limits: Says nothing about whether the rules produce good fiction; it is not a legal certification.
- Missing: no declared output has an applicable hard rule

### OI — Originality Index

- Status: `not_assessable`
- Value: not assessable — no OI annotation supplied
- Value kind: `components`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-100 derived from three anchored 0-4 dimensions · higher_better
- Method: Anchored 0-4 ratings of perspective, dramatic development and expression; index with complete ratings and an explicit comparison scope.
- Components:
- Components and arithmetic:
  - rubric: {"version":"rubric-anchors.v1","scale":4}
  - missing_dimensions: none
- Bounds: —
- Coverage: —
- Limits: OI is not 100 - SI; incoherent word salad can have low similarity.
- Missing: no OI annotation supplied

### SI — Similarity Index

- Status: `not_assessable`
- Value: not assessable — no --corpus manifest supplied
- Value kind: `scalar`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-1 · neutral
- Method: Jaccard of distinct 5-token shingles per eligible pair; value is the maximum over the named corpus.
- Bounds: —
- Coverage: —
- Limits: Reflects quotation, recurring names, genre language or duplication; not a moral or literary judgement.
- Missing: no --corpus manifest supplied

### NCS — Novelty & Cliché Score

- Status: `not_assessable`
- Value: not assessable — no NCS annotation supplied
- Value kind: `components`
- Scope: kind book · chapters 1, 2
- Unit and direction: two anchored 0-4 dimensions, no combined score · non_ordinal
- Method: Two dimensions: novelty of execution and cliché reliance, each anchored 0-4 with passages and scene-level evidence.
- Components:
- Components and arithmetic:
  - rubric: {"version":"rubric-anchors.v1","scale":4}
  - missing_dimensions: none
- Bounds: —
- Coverage: —
- Limits: Corpus frequency, evaluator taste and cultural familiarity bias both dimensions.
- Missing: no NCS annotation supplied

### CR — Contamination Rate

- Status: `not_assessable`
- Value: not assessable — no relevant training dataset declared; CR is never reported as zero without one
- Value kind: `scalar`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-100 · higher_worse
- Method: Fraction of eligible evaluation items meeting the declared contamination criterion, with exact evidence and dataset coverage.
- Bounds: —
- Coverage: —
- Limits: Normally unavailable for a hosted model's undisclosed training set; a reference library is not training data.
- Missing: no relevant training dataset declared; CR is never reported as zero without one

### TOP — Textual Overlap Percentage

- Status: `not_assessable`
- Value: not assessable — no --corpus manifest supplied
- Value kind: `scalar`
- Scope: kind book · chapters 1, 2
- Unit and direction: 0-100 · neutral
- Method: Union of exact matching runs of at least 8 tokens across references; 100 * matched_positions / eligible_tokens.
- Bounds: —
- Coverage: —
- Limits: Does not establish semantic borrowing, training memorization, plagiarism or copyright compliance.
- Missing: no --corpus manifest supplied

### AEG — Author Efficiency Gain

- Status: `not_assessable`
- Value: not assessable — no opt-in AEG timing annotation supplied
- Value kind: `scalar`
- Scope: kind book · chapters 1, 2
- Unit and direction: %, negative when the assisted task took longer than its baseline · higher_better
- Method: 100 * (baseline_active_minutes - assisted_active_minutes) / baseline_active_minutes over opt-in matched records; a positive baseline is required and a negative result is a real result.
- Bounds: —
- Coverage: —
- Limits: Server elapsed time is not human effort; a small uncontrolled sample is not causal evidence.
- Missing: no opt-in AEG timing annotation supplied

## Indicator justifications

### narrative_coherence

- Status: `not_assessable`
- Category: —
- Scope: kind book · chapters 1, 2
- Missing: no indicator annotation supplied

### thematic_depth

- Status: `not_assessable`
- Category: —
- Scope: kind book · chapters 1, 2
- Missing: no indicator annotation supplied

### character_complexity

- Status: `not_assessable`
- Category: —
- Scope: kind book · chapters 1, 2
- Missing: no indicator annotation supplied

### originality

- Status: `not_assessable`
- Category: —
- Scope: kind book · chapters 1, 2
- Missing: no indicator annotation supplied

### stylistic_quality

- Status: `not_assessable`
- Category: —
- Scope: kind book · chapters 1, 2
- Missing: no indicator annotation supplied

### emotional_impact

- Status: `not_assessable`
- Category: —
- Scope: kind book · chapters 1, 2
- Missing: no indicator annotation supplied

### interpretive_openness

- Status: `not_assessable`
- Category: —
- Scope: kind book · chapters 1, 2
- Missing: no indicator annotation supplied

### cultural_value

- Status: `not_assessable`
- Category: —
- Scope: kind book · chapters 1, 2
- Missing: a newly generated unpublished book lacks the reception evidence required for cultural_value

## Profile and provenance

- Profile id: `check-assessments` · sha256 `41b4be007fa235ed4a2ac2e66e6f5a4431c64d40af51b4333f81d81831e2ec68`
- Profile schema: `profile.v1` · aggregation enabled: false · policy `research`
- Aggregation weights: — · emotional-fit procedure: — · calibration: none recorded
- Rubric profile: `rubric-anchors.v1` at a 0-4 anchor scale
- Packet version: `sha256:5109d6185d55e9e68fbcebcb4200082e28123de18ca46bc5e5aed4ba7997f010` · captured 2026-09-22T14:52:37.396Z
- Selection: kind book · chapters 1, 2
- Continuity input: no continuity-result.v1 supplied in the annotations bundle
