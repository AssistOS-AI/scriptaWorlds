# Metric catalog and proposed operational definitions

Primary source: `private/metricx.docx`, M0057 through M0123. SHA-256: `89789a269b0af16b56fb106bab946f8e7586d030844218d39facb10131a5d9a7`. The source names these twelve metrics but does not supply complete algorithms or calibrated thresholds. Procedures, scales and missing-data rules below are project proposals requiring implementation and evaluation.

## Common result contract

The lexical measures depend on one versioned tokenizer (`scripts/lib/tokenize.mjs`, currently `unicode-letter-run-v2+byte-offsets`): it declares its supported languages, its treatment of numbers, apostrophes, diacritics, Markdown headings, quotations and boilerplate, and preserves exact mappings to the original UTF-8 bytes. A text it cannot segment yields an unavailable metric with that reason, never a zero. Internal repetition and comparison against an external corpus are separate scopes. Corpus source identity is declared, never inferred from bytes: a reference is the candidate's own source version, and therefore excluded, only when it declares the packet's `universe_id` and accepted `version`; identical bytes from a reference that declares nothing stay eligible and are labelled duplicate text; and an unknown identity is reported as unknown.

Every metric has a stable ID, definition version, purpose, scope, required inputs, method, output type, direction or non-ordinal interpretation, evidence IDs, coverage and limitations. Results use `computed`, `judged`, `not_assessable`, `not_applicable` or `error`. A result without a value explains what is missing. Confidence describes the evidence basis; it is not an automatically trustworthy probability because a model emits a decimal.

Store the registry/profile hash, source hashes, selected corpus, tokenizer version, evaluator model and annotation prompt version. Do not compare scores from incompatible profiles without recalculating them. The procedures below use ratios and ordinal annotations for different purposes; they must not be added together without an explicit conversion and calibration.

## CS: Coherence Score

Definition and purpose: assess whether discourse, referents, events and their causal/temporal relations form an intelligible account. M0079 through M0081 discuss entity-based coherence and causal/temporal violations; M0116 connects this to continuity across chapters.

Inputs: accepted text segments, event/referent annotations, structural intent and continuity findings. Proposed method: rate referential clarity, discourse connection, causal support and temporal intelligibility separately on anchored 0 through 4 scales. An experimental CS may be `100 * sum(ratings) / 16` only when all four dimensions are assessable under the same profile. Continuity findings inform the relevant rating; do not also subtract them as independent penalties. Missing dimensions leave the composite unavailable.

Output: a judged diagnostic profile and, only under a declared experimental/calibrated profile, a 0 through 100 score (`100 * sum(ratings) / 16`, implemented in `scripts/lib/rubric.mjs` under the versioned `rubric-anchors.v1` scale). A missing dimension reports the metric as unavailable with the missing dimension named; a bare supplied CS number is classified as unsupported legacy data. Higher means better supported coherence within the reviewed scope. A low result should identify the broken relation and its passages. Limitations: semantic resemblance does not establish causality; deliberate non-linearity or unreliable narration can be coherent. Sampling limits whole-book claims.

## NQS: Narrative Quality Score

Definition and purpose: a composite comparison of narrative quality. M0118 explicitly connects NQS to CS, OI and EAP. It does not define weights or convert EAP into a scalar.

Inputs: compatible CS and OI results, EAP, an explicit emotional intention and a separately judged emotional-fit component. Proposed method: keep NQS disabled by default. A research profile may define `wCS * CS + wOI * OI + wEF * emotional_fit`, with non-negative fixed weights summing to one and all three inputs on a calibrated 0 through 100 scale. Equal weights are an experiment to test, not an endorsed production formula. Save the weights and calibration version. A `production` profile additionally claims calibration support, which is refused until a local `calibration-study.v1` artifact verifies its hashes and its rubric/profile/language/scope bindings; the profile cannot declare that support itself (see `references/calibration.md`).

Output: `not_assessable` until judged complete inputs and a validated profile exist; an unavailable, inapplicable or failed component contributes no number, the reason names exactly which prerequisite is missing, and a valid zero stays a zero. Later an explicitly qualified judged aggregate. Higher means better fit to that profile, not universal literary value. Do not renormalize weights around missing inputs, double-count CAD/CCI, multiply by CAR or infer emotional quality from greater variance. The source's 25% improvement is a proposed research target without a repository baseline.

## CCI: Continuity Control Indicator

Definition and purpose: track consistency of entities, facts, chronology and events across the selected narrative units. M0085 and M0116 motivate long-range continuity control.

Inputs: a declared set of eligible factual/event comparisons, temporal scopes, paired evidence and continuity outcomes. Proposed method: report counts of consistent, contradicted and unresolved comparisons. If all selected comparisons are resolved and their count is positive, an experimental reviewed-claim index is `100 * consistent / resolved`. Count one underlying comparison once; retain linked symptoms separately. If cases remain unresolved, show coverage and possible bounds instead of claiming a complete index.

Output: counts plus a qualified judged index or an unavailable value. The counts are bound to the packet twice over: the authoritative version is the packet's accepted version (`source_version`, with the legacy `version` accepted only as a fallback, a document naming two different versions refused and a stale one refused as `STALE_ANNOTATION`), and the population the counts describe is `scope.chapters_reviewed` when the producer declares it, otherwise the declared chapters, which must be exactly the selection and must lie inside the packet. The counts must partition `eligible_comparisons`: when the result carries its `comparisons` ledger the totals are recomputed from the outcomes and a contradicting total is refused, and without a ledger the unattributed remainder is carried as `unresolved` with `partition.unexamined` naming it — one observed success among a hundred eligible comparisons can never publish complete consistency, and the index is then held back with coverage and bounds. Higher means fewer confirmed inconsistencies among the selected comparisons. Limitations: selection bias and omitted earlier evidence can hide errors; a small clean sample is not global continuity. Confirmed invalid chapter references are integrity findings and can prevent this calculation altogether.

## CAD: Character Attribute Drift

Definition and purpose: detect unsupported changes in a character's properties or behaviour while allowing development. M0086 and M0117 distinguish continuity of identity from change over an arc. M0086 suggests semantic distance between defined and inferred attributes; the proposed first version uses an evidence-labelled change rate because no validated distance model is supplied. Keep that methodological difference explicit in reports.

Inputs: baseline attribute evidence, candidate later changes, chronology, character knowledge and possible catalysts. Proposed method: classify eligible changes as supported, unsupported or unresolved. A provisional unsupported-change rate is `100 * unsupported / resolved_changes` only when the selected change set is non-empty and fully resolved. Break results down by character and attribute kind. Do not use a changing pronoun or changed adjective alone as proof.

Output: evidence-linked changes, counts and a qualified judged percentage. Candidates come from the same chapters the continuity counts describe; a finding whose every cited passage lies outside them is reported, but is not a candidate of this rate, and the exclusion is named in the metric's `detail.excluded_findings`. Repeated symptoms of one defect are one candidate, and symptoms that disagree about their status make the defect contested: it is counted as unresolved with the conflicting statuses named rather than resolved by whichever symptom was read first. Higher means more unsupported drift, unlike CS and CCI. A static character with no change candidates has `not_applicable`, not zero drift. Limits: psychological plausibility is interpretive, identity can be intentionally unstable, and evidence of learning or trauma may lie outside the selected scope.

## EAP: Emotional Arc Profile

Definition and purpose: describe emotional progression across scenes, chapters and the work. M0087 through M0090 and M0121 describe trajectories, tone and intensity rather than a single quality number.

Inputs: ordered/disclosed segments, focal character, evidence and optional intended arc. Proposed method: annotate valence on -2 through 2 and tension/intensity on 0 through 4, with rubric anchors and separate character states where needed. Preserve scene order, uncertainty and transitions. Produce chapter summaries that retain the underlying trajectory and weighting. Story-time and disclosure-time plots can differ in a non-linear book. The received array order is the disclosure order and is retained on every point as `disclosure_index`; the published series is ordered by the declared chronology, so `ordering: "story"` must name a distinct, complete `story_order` for every point (a missing or repeated one is refused) and `ordering: "disclosure"` may record a chronology without obeying it. One point per segment and focalization: a second reading by the same voice is a duplicate and is refused, two focalizations of one segment stay two trajectories. Coverage is the fraction of the *selected* segments the trajectory actually assessed, the omissions and any assessed point outside the selection are named in `detail`, and a trajectory that assesses nothing inside the selection is unavailable rather than a judgement of the selection.

Output: a judged ordered trajectory of segments with focalization, valence, tension, evidence and uncertainty, and no derived scalar. The emotional-fit component NQS needs is judged separately from the trajectory: a record of its own with `status`, `fit` in 0..100, an evaluator, a rationale, cited evidence and the declared intention it is bound to. A bare number is refused, an incomplete record is unavailable with the reason, and NQS never consumes a number from a metric that was not judged. High tension is not automatically good; low intensity can be the purpose of an aftermath, and a low-tension point is reported as a description of the arc (`detail.low_tension_segments`), never as a defect. The shape must be interpreted against this book. Emotional fit for NQS is a separate judgement, not the mean valence or variance of EAP. A model's predicted effect is not measured reader response. Any source-mentioned dataset must be verified for existence, suitability and license before adoption.

## CAR: Compliance Adherence Rate

Definition and purpose: measure adherence to an explicit specification across generated outputs. M0091 through M0098 and M0120 connect this to structural and configured STG constraints.

Inputs: a versioned rule registry, a declared population of outputs and outcomes stored per (rule, output) pair with evidence, so one rule can apply to several chapters. Proposed method: an output passes only when all its applicable hard rules pass; a hard rule that is `not_applicable` for an output does not fail it. Compute `100 * passing_outputs / evaluated_outputs` only when the full declared population has complete outcomes. When unresolved outputs exist — including an applicable check whose outcome was never recorded — report coverage and lower/upper bounds over the declared population, under an explicit aggregation policy (`all_applicable_pass` by default). A `pass` or `fail` without evidence is treated as unresolved rather than counted. An output with no applicable rules is excluded as `not_applicable`, with the exclusion count visible. Optional editorial preferences do not affect CAR.

Output: a computed rate from validated outcomes, or unavailable pending rule resolution. Semantic rule outcomes retain their judged provenance. Higher means greater adherence to the declared rules; it says nothing about whether those rules produce good fiction. For one chapter the output-level result is effectively pass or fail, supplemented by the informative rule matrix. Do not confuse it with a percentage of rules passed or claim legal certification.

## OI: Originality Index

Definition and purpose: assess fresh execution relative to previously observed material. M0102 and M0119 discuss novelty, semantic distance and comparison across scales.

Inputs: candidate prose, book/genre intention, declared internal/external reference scope and semantic annotations. Proposed method: separately rate distinctiveness of perspective, dramatic development and expression on anchored 0 through 4 scales. An experimental 0 through 100 index may use `100 * sum(ratings) / 12` only with complete ratings and an explicit comparison scope. SI/TOP matches provide evidence to inspect; they do not determine the ratings automatically.

Output: a judged profile and optional experimental index (`100 * sum(ratings) / 12`). The annotation must name the `comparison_scope` it was judged against; without it the record is refused rather than scored. A bare supplied number is unsupported legacy data. Higher means more distinctive execution within the observed scope. Without suitable references or grounded annotations, use `not_assessable` or an explicitly narrower internal-repetition assessment. OI is not `100 - SI`; incoherent word salad can have low similarity. The method cannot establish novelty against inaccessible model training data or all literature.

## SI: Similarity Index

Definition and purpose: quantify resemblance between selected texts. M0103 names lexical matching, Jaccard and semantic cosine approaches.

Inputs: a candidate, identified references, tokenizer configuration and comparison scope. Proposed first method: Jaccard of distinct five-token shingles, `|A intersection B| / |A union B|`, for each eligible pair. The five-token size is a pilot configuration requiring calibration. Report top matches with source IDs and distribution; if exposing a maximum, label it as a maximum over a named corpus. Both empty sets or texts too short for the selected method are not assessable.

Output: computed lexical similarity in 0 through 1 plus matched evidence. Higher means more shared shingles under that method. It can reflect quotation, recurring names, genre language or duplication. It is not a moral or literary judgement. Optional semantic SI requires a separately versioned embedding model and calibration; do not mix its values with lexical SI in one unlabeled column.

## NCS: Novelty & Cliché Score

Definition and purpose: distinguish fresh execution from overused expression or narrative machinery. M0104 describes novelty and cliché as related components.

Inputs: prose, recent scene patterns, declared comparison corpus, genre and intentional recurring devices. Proposed method: retain two dimensions. Rate novelty of execution and cliché reliance on anchored 0 through 4 scales with passages and scene-level evidence. A fixed phrase alone is a candidate for inspection, not proof of a cliché. No single combined NCS is enabled until its tradeoffs have been calibrated.

Output: a judged pair of components and examples, each with its own rationale and evidence. No combined scalar is produced before its trade-offs have been calibrated, so `NCS` reports components and no value; a supplied NCS number is unsupported legacy data. Higher novelty suggests more distinctive execution; higher cliché reliance suggests more unearned reuse. A genre convention can be useful, and ritual repetition can gain meaning through context. Limitations: corpus frequency, evaluator taste and cultural familiarity can bias both dimensions. Do not reward random variation or erase a book's chosen formal devices.

## CR: Contamination Rate

Definition and purpose: assess overlap between evaluation data and a model's training data. M0105 concerns validity of evaluation when training has exposed the test material.

Inputs: the relevant training corpus or a documented, appropriate subset, evaluation items, model/data version and overlap criteria. The minimum record is `model_identity`, `corpus` (description plus locally verifiable `files` with hashes), `evaluation_population`, `overlap_criterion`, `access`, `provenance`, `coverage` and the `checked_items`/`matched_items` counts. Proposed method when those inputs actually exist: compute the fraction of the checked evaluation items that meet the declared contamination criterion, with exact evidence and dataset coverage; a declared value is verified against those counts and every referenced file is hashed locally. A partial known training set supports only a bounded lower-evidence claim. Without access, return `not_assessable` and state why.

Output: a qualified computed rate when supportable, normally unavailable for a hosted model's undisclosed training set. An empty dataset declaration is refused, an inaccessible training set is `not_assessable`, and zero is reported only when the declared measurable population was actually checked; a partial subset yields a bounded, limited finding. Higher means more detected contamination under the declared criterion. Comparing a book with a convenient reference library does not measure training contamination. An optional `known_corpus_overlap` diagnostic must remain separately named and cannot stand in for CR.

## TOP: Textual Overlap Percentage

Definition and purpose: show how much candidate text overlaps declared references. M0106 and M0108 connect overlap with source reuse. This initial implementation narrows the method to exact lexical coverage so its output can be inspected.

Inputs: eligible candidate tokens, original byte mappings, named references and documented exclusions. Proposed method: find exact matching runs of at least eight tokens, a pilot setting. Take the union of matched eligible candidate-token positions across all references, then compute `100 * matched_positions / eligible_candidate_tokens`. Count overlapping matches and repeated source hits once per candidate position. Keep the candidate and reference spans of every contributing run, and expose raw and exclusion-adjusted views when exclusions are used. Contiguity is preserved: a run never straddles a gap between two selected ranges.

Output: computed percentage, match spans and denominator. Higher means more direct lexical reuse under this configuration. Empty eligible text is not assessable. This does not establish semantic borrowing, training memorization, plagiarism or copyright compliance. Short matches and paraphrases outside the method remain a stated blind spot.

## AEG: Author Efficiency Gain

Definition and purpose: measure reduction in human time required to produce comparable accepted work. M0109 proposes a 40% reduction as a target.

Inputs: opt-in records for matched unassisted and assisted tasks, active human time including revision, common scope and quality acceptance, interruptions and separate model-wait duration. Proposed method: `100 * (baseline_active_minutes - assisted_active_minutes) / baseline_active_minutes`. The baseline must be positive and the comparison must meet the same acceptance criteria. Record whether a study aggregates paired gains or total time; do not switch after seeing the result.

Output: computed percentage with sample size and study context. Positive means less human time, negative means more: a negative result is a real result and the lower bound is not zero. Whether a study aggregates paired gains or total time is recorded with it, and studies that disagree are not combined. A bare annotated number is unsupported legacy data. Missing timing or incomparable tasks yield `not_assessable`. Server elapsed time is not human effort. A small uncontrolled sample does not support a causal efficiency claim, and the source target is not a measured result.

## Processes, undefined labels and dependency limits

Specification Adherence Analysis and Compliance Validation are evaluation processes and report contents, not two additional scalar metrics. VAD and BCI are mentioned in M0120 without sufficient definitions. Reserve their names and defer implementation until their constructs, inputs, methods and interpretation are supplied and reviewed.

CCI and CAD feed continuity evidence into CS. NQS depends on CS, OI and an explicit emotional-fit interpretation of EAP. SI, TOP and NCS supply inspectable comparison evidence without becoming automatic originality penalties. CAR stays a separate compliance result. AEG measures a workflow study, not a property of a chapter. The eight literary indicators remain visible alongside these metrics so a convenient aggregate does not replace the actual editorial assessment.
