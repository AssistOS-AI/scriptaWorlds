# Calibration and evidence of improvement

This is a proposed evaluation protocol. It operationalizes the guide's contextual account of literary construction and the metrics document's comparison goals. Guide SHA-256: `8ee4ad1ceca60b68b1d56c5a66600b11ea61aaf166571313f3ba52ba8d2ccb20`. Metrics SHA-256: `89789a269b0af16b56fb106bab946f8e7586d030844218d39facb10131a5d9a7`. No benchmark results or calibrated thresholds exist in this planning folder.

## Separate three kinds of verification

Deterministic tests establish implementation properties such as exact overlap, byte offsets, valid JSON and no input mutation. Controlled semantic fixtures test whether an evaluator distinguishes a specific defect from a justified exception. Human literary comparison examines whether the writing improves for readers. Passing the first kind does not establish the third.

## Build the initial corpus

Create original or otherwise authorized short examples. Start with at least 24 paired semantic cases split between development and held-out evaluation. Include English and Romanian, straightforward and non-linear chronology, quiet and tense scenes, simple and elaborate registers, justified and unsupported character change, purposeful and empty repetition, reliable and unreliable narration. This is a practical starting sample, not a statistically sufficient universal benchmark.

For each pair, preserve most text and change one causal or stylistic feature. Record expected evidence, accepted alternative readings and the exact source change. Do not label every experimental form as the corrupted half. Add negative cases where a tempting allegation is wrong, such as a valve that was visibly reset between scenes.

Build separate deterministic fixtures with known token counts and overlaps. Keep their expected values independently calculated. Include multilingual byte offsets, short and empty texts, repeated matches, corpus self-exclusion and missing timing baselines.

## Human annotation

Use at least two independent readers for the pilot if available, with the book intention and rubric but without the generation-method label. Capture category, evidence, severity and uncertainty before discussion. Retain disagreements; do not rewrite the gold data to match the automated judge. If only one reader is available, state that limitation and do not claim inter-rater reliability.

For ordinal indicators, report agreement and a suitable ordinal agreement statistic with sample counts. For continuity findings, match predicted and labelled defects by evidence and underlying claim, then report precision/recall and false positives. Assess selective coverage: a reviewer can appear accurate by returning unavailable on every difficult case.

## Compare authoring workflows

Use the same initial premise, language, model configuration, chapter budget and reader-intervention sequence for baseline ALA and the proposed creation workflow. Include several books or arcs rather than only the reviewed Hesper sample. Randomize presentation order and ask readers which version they prefer and why, including agency, continuity, voice, emotional specificity and preserved intent.

Retain complete prompts and relevant context manifests. The reviewed book repeatedly received the same Rusk intervention. A comparison that gives the new system more varied prompts cannot attribute all improvement to the new skills. Compare equal prompt conditions first; test improved offer design separately.

Use multiple runs when generation is stochastic and report their spread. Save output hashes and profile versions. Do not turn an anecdotal preference into a 25% NQS claim or a general statement about the model.

## Thresholds and aggregates

Keep initial reports descriptive. Tune rubrics on development examples, freeze the version, then evaluate on held-out examples. Choose any future alert threshold from observed false-positive/false-negative tradeoffs and the intended use. Literary scores remain advisory under the user's decision regardless of the threshold.

Before enabling NQS, test whether its weighting changes align with human preferences and whether one duplicated flaw dominates several components. Test whether low SI rewards incoherent variation. Examine language/genre-specific failures rather than hiding them in a global average. Keep EAP as a profile and validate any separate emotional-fit annotation.

## Operational cost and reproducibility

Record deterministic execution duration, annotation calls, actual provider usage when available and input coverage. Test report replay from stored annotations without a model. Pin registry, tokenizer/runtime and corpus versions so lexical results can be reproduced. Model judgement may vary across calls even with the same requested settings; saved annotations make the reported result auditable, not the provider deterministic.

AEG needs a separate controlled timing study. Include revision and review work in active human time, retain comparable quality acceptance and do not substitute model latency. Missing opt-in human data leaves AEG unavailable.

## Completion evidence for the implementation session

Store the fixture inventory, split, consent or rights basis for non-original material, human labels, disagreements, configuration, raw results and a concise result interpretation. Identify which methods remain experimental or unsupported in a language. The five report types can ship with honest unavailable entries while research measures mature.

Use the benchmark to detect regressions after prompt or model changes. Do not automatically revise the benchmark's expected labels just because a new judge disagrees.
