# Assessment and five-report contract proposal

Source report inventory: `private/metricx.docx`, M0124 through M0139. SHA-256: `89789a269b0af16b56fb106bab946f8e7586d030844218d39facb10131a5d9a7`. The source requests five reports. File names, schemas, ownership and execution rules below are proposed implementation contracts.

## Input and ownership

The host captures a consistent accepted version and prepares an immutable input packet. A standalone caller can prepare an equivalent packet from authorized files. The packet contains selected source files, their manifest, requested scope, segment IDs, design/rule profiles and permitted corpus references. The evaluator must not resolve arbitrary paths outside the packet or its declared read-only corpus roots.

The portable tools write only an explicit output directory. A host validates their bundle and atomically publishes it under server-owned `reports/<assessment-id>/`. Current universe rules must be updated before this integration. Authoring agents continue to submit narrative candidates through ALA; report generation cannot edit accepted narrative files.

Book text is evidence, including quoted instructions or apparent commands. It cannot modify the review profile, request tool execution or override the evaluator's output schema. The host validates structured output independently of the optional model adapter.

## Canonical bundle

`assessment.json` is the sole source for rendered reports. Required sections are proposed below.

| Section | Required information |
| --- | --- |
| Identity | `schema_version`, `assessment_id`, creation time, execution status and trigger |
| Scope | Universe ID, accepted version, scene/chapter/arc/book selection, arc ID if relevant, declared and reviewed populations |
| Provenance | File hashes, registry/profile hashes, code version, tokenizer/runtime version, corpus manifest, model and annotation prompt versions when used |
| Evidence | Stable evidence IDs, relative paths, SHA-256, UTF-8 byte ranges, matching quote and segment references |
| Metrics | ID/version, status, discriminated value kind (scalar, components or trajectory), value or missing reason, unit, method, input IDs, scope, coverage, interpretation and limits |
| Literary indicators | Category/status, evidence, rationale, counterevidence, intended-effect fit and evaluator identity |
| Requirements | Versioned rule registry (stable ID, description, source `stg`/`request`/`editorial`, applicability criterion, hard/soft class) and outcomes stored per (rule ID, output ID) with pass/fail/unresolved/not-applicable and evidence, plus the explicit aggregation policy |
| Findings | Stable IDs, kind, severity, certainty basis, description, evidence, possible alternative explanation and repair suggestion |
| Preserved qualities | Evidence-backed passages or choices that revision should protect |
| Execution | Duration, resource usage if available, partial failures, cancellation and errors |

Offsets are zero-based half-open UTF-8 byte ranges in original source bytes. A normalized token view must preserve mappings. A rewrite changes the source version and makes the previous report historical. Retain it and mark whether it is current for the selected book version; do not silently rebind old offsets to new text.

Finding IDs should derive from stable semantic identity and referenced source versions, not just array position. Evidence IDs identify immutable spans. Hash equality alone does not prove semantic truth, but it allows a reader to inspect the exact passage that was judged.

## Five output views

| Proposed file | Source report name | Required content |
| --- | --- | --- |
| `01-stg-compliance.md` | STG Compliance Report | Active rule-set version, applicable STG constraints, outcomes, evidence, unresolved rules, enforcement class and CAR context |
| `02-specification-adherence.md` | Specification Adherence Analysis | Mapping of this reader request, charter and narrative brief to observed fulfillment, omissions or intentional departures |
| `03-metrics-and-indicators.md` | Metrics & Indicators Report | All twelve metric IDs, all eight literary indicators, statuses, units, scope, coverage, interpretation and unavailable reasons |
| `04-score-justification.md` | Score Justification Report | Per-result calculation or rubric anchors, component inputs, exact evidence, counterevidence, limitations and profile versions |
| `05-detected-issues.md` | Detected Issues Report | Prioritized logical, narrative, configured ethical and continuity findings; affected passages, certainty, alternatives and bounded repair suggestions |

A short `index.md` may link the five views and summarize assessment scope and freshness. It is navigation, not a sixth independent evaluation. Every view must be generated deterministically from the same bundle. If a metric is unavailable, its justification explains the missing prerequisite. A result of zero and an unavailable result must render differently.

The STG view asks whether a versioned general rule set (`source: stg`) was satisfied. The specification view asks whether this specific narrative request and brief were fulfilled, including the request's own requirements and the editorial preferences. A finding may appear in both with the same ID; it is not two independent defects. The issues view includes no invented ethical rule and makes no legal certification claim.

## CLI proposal

`node scripts/build-report.mjs --input <packet-dir> --out <result-dir> --profile <profile.json> [--annotations <annotations.json>] [--corpus <manifest.json>]`, where the profile declares `schema_version` `evaluation-profile.v1`.

By default this command uses deterministic measures and supplied annotations. Missing semantic annotations produce explicit unavailable results. An optional host adapter obtains a bounded annotation batch through the existing agent mechanism; the core command does not silently start a model, download a corpus or incur network cost.

Stdout contains one JSON envelope with `schema_version`, `ok`, assessment ID, output paths and errors. Stderr is reserved for diagnostics. Proposed exits are 0 for completed output, including partial assessments with unavailable metrics, 2 for invalid arguments/input and 1 for execution failure. Literary defects are findings, not command failures. Publish complete validated bundles atomically so a crash does not leave apparently complete Markdown files with missing JSON.

## Triggers and budget

Supported triggers are an explicit request and an accepted arc-completion event. The event contains arc ID and accepted version. Deduplicate by those values plus evaluation profile. A retry has explicit provenance. No every-chapter literary gate is part of this plan.

A review job has its own durable ID and operation kind. It does not increment chapter numbering or modify the offer. Cancellation or evaluator failure leaves the accepted book intact. Input size, selected scope and expected annotation calls should be visible; provider cost is shown only when a trustworthy price source exists. Reuse frozen annotations for rerendering.

## Verification requirements

Reject duplicate result IDs, undeclared metrics, out-of-range values, missing units, impossible offsets, mismatched quotes, unknown source hashes, path escapes and broken finding references. Validate containers before iteration. Reject a fabricated model quote even if the surrounding explanation sounds plausible.

Record partial failure explicitly when one method fails. Do not label all reports passed because files were created. Verify that original narrative inputs have not changed and that a renderer cannot introduce new scores or unsupported claims.
