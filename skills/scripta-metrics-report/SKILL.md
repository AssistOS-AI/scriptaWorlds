---
name: scripta-metrics-report
description: Produce evidence-backed narrative metrics and five readable evaluation reports for an accepted scene, chapter, arc or book, keeping literary scores advisory. Defaults to deterministic measures plus supplied annotations; never starts a model, downloads a corpus or hits the network.
---

# Scripta Metrics Report

Produce evidence-backed narrative metrics and five readable evaluation reports for a
frozen, accepted scene, chapter, arc or book. The command measures what it can measure
deterministically and records explicit `not_assessable` results for everything it cannot.
It never fabricates a score, never starts a model, never downloads a corpus and never
hits the network.

Literary scores are **advisory**. A report informs a revision choice; it does not rewrite
the book, change canon, or block publication.

## CLI

```
node scripts/build-report.mjs --input <packet-dir> --out <result-dir> --profile <profile.json> \
  [--annotations <annotations.json>] [--corpus <manifest.json>] [--study-root <dir>] \
  [--allow-test-only-studies] [--trigger <request|arc>] [--arc-id <id>]
```

- `--input` — a validated `assessment-input.v2` packet directory (manifest + referenced files).
- `--out` — the result directory. A new or empty directory is accepted; the whole bundle is
  staged in a sibling directory, inventory-verified and published with one `rename`, so a
  reader sees either the previous complete result or the new one. A non-empty destination
  and a destination that equals, contains, nests under or symlink-aliases an input are
  refused before anything is written.
- `--profile` — the evaluation configuration (`evaluation-profile.v1`; older documents that
  declare `assessment-profile.v1` or `profile.v1` still load) with the scope, the optional
  rubric and aggregation profile.
- `--annotations` — optional `annotations.v1` bundle with semantic judgements, indicators,
  the rule registry and its outcomes, an optional embedded `continuity-result.v1`, an
  optional `timing-study.v1` block, findings, departures and preserved qualities.
- `--corpus` — optional `corpus.v1` manifest. The corpus is read only from this explicit file;
  it is never downloaded. Without it, SI and TOP are `not_assessable`.
- `--study-root` — the local directory the profile's calibration artifacts resolve against.
  It is required as soon as `profile.aggregation.calibration` names a study, and a declared
  root that is not a readable directory is refused before anything is read.
- `--allow-test-only-studies` — the explicit opt-in that lets a study declaring
  `test_only: true` back a production claim. Without it such a study is refused as support;
  with it the computed NQS states that its support is a test-only study and is labelled a
  limited finding. It never changes the bindings, hashes or existence checks.
- `--trigger` — the event that caused the run: `request` (the default, an explicit reader
  request) or `arc` (an accepted arc-completion event). The host maps its own
  `requested`/`arc` vocabulary onto these values and passes the flag on every run.
- `--arc-id` — the arc identifier, required with `--trigger arc` and refused with any other
  trigger. It becomes the `arc_id` of `trigger_ref` in the bundle.

Output on stdout is exactly ONE JSON envelope:

```json
{
  "schema_version": "assessment-result.v1",
  "ok": true,
  "assessment_id": "<stable hex>",
  "output_dir": "/abs/result-dir",
  "outputs": ["assessment.json", "index.md", "01-stg-compliance.md", "..."],
  "errors": []
}
```

Exit codes: `0` completed (unavailable metrics are results, not failures),
`2` invalid input/arguments/schema/contract violation (nothing is written),
`1` execution failure. A refusal names a machine-readable `code`; the codes are shared with
the other packet consumers (see below). A missing `--out` is a usage error.

Inside the published `assessment.json`, the identity block carries the event that produced
the report: `trigger` is `request` or `arc`, and `trigger_ref` is `{ "kind": "request" }` or
`{ "kind": "arc", "arc_id": "<id>" }`; `index.md` states the same event on one line under
`Trigger`, so a reader of a stored report can tell an explicit request from an accepted
arc-completion event without consulting the host's run record.

## Synthetic literary case library

`fixtures/literary-cases/` holds 24 paired short texts — twelve Romanian and twelve English —
written for this repository as teaching and regression material, with `index.json` as their
machine-checkable inventory. Each pair changes exactly one literary feature, keeps the rest of
the text, and anchors its expected evidence at real UTF-8 byte offsets in both halves; the
cases also record their intention, the distinction under test, acceptable alternative readings
and an explicit synthetic provenance. A declared subset is reserved for prompt-regression
checks, and the library is never described as an independent human benchmark. The
`model-agreement.json` record currently reports `status: "unperformed"`, because no evaluator
has been run against the library; its figures may only be added from a real recorded run.

```sh
node scripts/validate-cases.mjs [--fixtures <literary-cases-dir>]
```

The command validates every case, prints one JSON envelope with the counts, the language split,
the reserved subset and the agreement status, and exits `2` with one `{ file, message }`
problem per defect when a case is malformed, changes more than one feature or carries an
unanchored quote. `references/literary-cases.md` explains the library for a reader who has
never seen it.

## Inputs

### `assessment-input.v2` packet

A directory with `manifest.json` plus the referenced files at their relative paths. The
manifest declares `universe_id`, the content `version` of the accepted book, `captured_at`,
`book`, the declared `scope` and one entry per file with `path`, `sha256`, `bytes`, `role`
and `artifact_id`. Every declared path is validated against traversal, absolute paths and
symlink escape through real paths; every file is checked as UTF-8; every `sha256` and
`bytes` count is recomputed; the `version` is recomputed from the chapter, offer, canon,
threads and atlas entries (`docs/contracts.md` §8.2) and compared with the declared one.
`scope.kind` is `complete`, `partial` or `textual_only`: a partial packet declares the
chapters it omits in `scope.omitted`, and a textual-only packet carries prose alone, in
which case the continuity-dependent metrics report that no continuity input was available.

Refusals use the shared vocabulary of `docs/contracts.md` §8.3 and exit `2` without writing
anything: `MISSING_CONTEXT`, `MISSING_MANIFEST`, `BAD_JSON`, `INVALID_MANIFEST`,
`SCHEMA_VERSION`, `PATH_ESCAPE`, `DUPLICATE_PATH`, `DUPLICATE_ARTIFACT_ID`,
`DUPLICATE_CHAPTER`, `MISSING_FILE`, `BYTE_MISMATCH`, `HASH_MISMATCH`, `VERSION_MISMATCH`,
`ROLE_UNDECLARED`, `INVALID_ENCODING`, `SCOPE_INCOMPLETE`, `SCOPE_INCONSISTENT`.

### `evaluation-profile.v1`

```json
{
  "schema_version": "evaluation-profile.v1",
  "profile_id": "my-profile",
  "scope": { "kind": "chapter", "chapters": [1, 2], "context_chapters": [3] },
  "rubric": { "version": "rubric-anchors.v1", "scale": 4 },
  "aggregation": { "enabled": false }
}
```

`scope.kind` is `scene | chapter | arc | book`. A scene scope names `scope.segments`, an arc
scope names `scope.arcs` whose membership must resolve to accepted scenes; neither falls
back to every chapter. `scope.context_chapters` names chapters that are available to explain
a fact and are never counted as candidate text. A book scope requires a complete packet.
Chapter selections are resolved against the packet inventory before any measurement, so a
duplicate, nonexistent or invalid chapter identifier is a contract violation.

`rubric` is optional and defaults to the anchored 0–4 scale of `rubric-anchors.v1`.
`aggregation` gates NQS and is off by default; an enabled profile must declare
`weights` for `cs`, `oi` and `emotional_fit` that sum to one, an `emotional_fit.procedure`,
a `scope`, the corpus and rubric versions and, for a `production` policy, a `calibration`
record naming the study artifact the claim rests on:

```json
"calibration": { "study": "c34-pilot.json", "study_id": "c34-pilot" }
```

`calibration.study` resolves against `--study-root`; `study_id` is optional and must match
the document. Any other field — notably `held_out` or an inline `evidence` list — is refused
as `INVALID_PROFILE`, because a profile cannot declare its own support. The study document
itself is a `calibration-study.v1` record, published in `schema/study.v1.json` and verified
locally: the artifact exists, its bytes hash to the declared sha256, and its `bindings`
(`rubric_version`, `profile_version`, `language`, `scope`) equal the profile being computed
and the accepted book's language. A missing artifact, a hash mismatch, a missing binding or a
contradicted binding leaves NQS `not_assessable` with that reason — never zero, and without
blocking the other metrics. A study declaring `test_only: true` is refused as production
support unless `--allow-test-only-studies` is passed, and the computed metric then says its
support is a test-only study. `tests/calibration.test.mjs` drives every one of these paths.

### `annotations.v1`

Optional semantic input. Every claim is a structured record with a stable id, its evidence
ids, an evaluator, a rationale and, where relevant, an alternative explanation and an
uncertainty note. An annotation set may declare `source_version` (the accepted version it was
judged against); a stale one is refused with `STALE_ANNOTATION` instead of being attributed
to this version. Contents:

- `evidence` — `evidence.v1` items, each `{ id, file, sha256, start, end, quote }` with
  zero-based half-open UTF-8 byte offsets; the file hash, the code-point boundaries and the
  exact quote are all re-verified, so a fabricated quote is refused.
- `segments` — scene/sequence/chapter records with validated byte ranges, chapter membership
  and a `declared` or `inferred` provenance, plus arcs that select scenes.
- `metrics` — judged annotations:
  - `CS` — `dimensions` `referential_clarity`, `discourse_connection`, `causal_support`,
    `temporal_intelligibility`, each `{ rating 0-4, rationale, evidence }`; the experimental
    scalar is `100 * sum(ratings) / (scale * 4)` and exists only when all four are assessable.
  - `OI` — `dimensions` `perspective`, `dramatic_development`, `expression` plus a declared
    `comparison_scope`; scalar `100 * sum(ratings) / (scale * 3)`.
  - `NCS` — the two dimensions `novelty` and `cliche_reliance`, each with its own rationale
    and evidence; there is no combined NCS scalar before calibration.
  - `EAP` — an ordered `trajectory` of `{ segment_id, focalization, valence [-2,2],
    tension [0,4], evidence, uncertainty }` plus a separate `emotional_fit` judgement; a
    series that mixes story time and disclosure time must declare `ordering`.
  - `CR` — a `training_dataset` record (see below).
  - A bare numeric `value` for CS, OI, NCS, EAP, CR or AEG is **unsupported legacy data**:
    it is reported as such and never becomes a score.
- `timing` — an opt-in `timing-study.v1` block for AEG: matched tasks with `task_id`,
  `scope`, `aggregation` (`paired_gains` or `total_time`), a `baseline` and an `assisted`
  side (`active_minutes`, `revision_minutes`, `interruptions`, `accepted`, `criterion`,
  `model_wait_minutes`) and an optional `server_elapsed_minutes` kept out of the formula.
- `indicators` — the eight literary indicators, validated against their source categories.
- `requirements` — the versioned rule registry (`registry_version`, `rules`, `outcomes`,
  `aggregation_policy`); see below.
- `continuity` — a `continuity-result.v1` object. Its counts must reconcile
  (`consistent + contradicted + unresolved <= eligible_comparisons`) and its scope must match
  the selection, otherwise its counts are reported as inapplicable instead of mis-attributed.
- `findings` — semantic findings; a confirmed contradiction or unsupported change needs at
  least one evidence item and a `temporal` baseline/later pair, and an unresolved reading
  keeps its limitations and alternative explanation.
- `departures` — declared deliberate departures. A `fail` or `not_applicable` outcome never
  implies one.
- `preserved_qualities` — evidence-backed passages and choices revision should protect.

### `corpus.v1`

```json
{
  "schema_version": "corpus.v1",
  "references": [
    { "id": "ref1", "path": "reference.txt", "sha256": "<64 hex>", "language": "en",
      "provenance": "where it came from", "permitted_use": "comparison", "exclusions": [] }
  ]
}
```

Paths resolve relative to the manifest and are validated against traversal and symlink
escape; every hash is recomputed. A reference whose bytes are the candidate's own source
version is excluded (`same_source_version`); genuine duplicate text in another reference
stays eligible and is flagged. `permitted_use: none` or `prohibited` excludes a reference.

## Metrics

Twelve metric IDs, each with a definition version, purpose, method, direction, unit,
limitations and a discriminated `value_kind`:

| id | value kind | direction | meaning |
| --- | --- | --- | --- |
| `CS` | components | higher_better | Coherence Score: four anchored dimensions, optional experimental scalar |
| `NQS` | scalar | higher_better | Narrative Quality Score (disabled by default, never redistributed) |
| `CCI` | scalar | higher_better | Continuity Control Indicator (from the continuity ledger) |
| `CAD` | scalar | higher_worse | Character Attribute Drift (one candidate per underlying defect) |
| `EAP` | trajectory | non_ordinal | Emotional Arc Profile: ordered segments, valence and tension |
| `CAR` | scalar | higher_better | Compliance Adherence Rate over the declared output population |
| `OI` | components | higher_better | Originality Index: three anchored dimensions and a comparison scope |
| `SI` | scalar | neutral | Similarity Index (0..1, maximum over the named corpus) |
| `NCS` | components | non_ordinal | Novelty & Cliché Score: two dimensions, no combined scalar |
| `CR` | scalar | higher_worse | Contamination Rate (needs a verifiable training-dataset record) |
| `TOP` | scalar | neutral | Textual Overlap Percentage (union of exact runs, 100 × matched / eligible) |
| `AEG` | scalar | higher_better | Author Efficiency Gain (opt-in timing, negative results allowed) |

`VAD` and `BCI` are reserved names without a sufficient definition; they are never
implemented as values.

Result statuses: `computed`, `judged`, `not_assessable`, `not_applicable`, `error`.

### What is computed vs. judged

- **Computed** (deterministic): `SI` and `TOP` (when `--corpus` is supplied), `CAR` (from the
  rule registry and its outcomes), `CCI` and `CAD` (from an embedded `continuity-result.v1`,
  consumed once and never double-counted as a separate penalty), `CR` (from the checked and
  matched counts of a verified dataset record), `AEG` (from comparable opt-in timing records),
  `NQS` (from its saved components under the declared aggregation profile).
- **Judged** (from annotations, else `not_assessable`): `CS`, `OI`, `NCS`, `EAP`. A missing
  component never silently produces a full score, and `cultural_value` is `not_assessable`
  for a new book.

A zero value and an unavailable value render differently: `0` is a measurement;
`not_assessable` is an honest missing prerequisite, rendered with its reason. A component
profile retains its ratios, an EAP trajectory keeps its order and uncertainty, and neither
is flattened into an invented number.

### CAR and the rule registry

`requirements` declares a versioned registry and records outcomes by the pair
`(rule id, output id)`, so one rule applies to several chapters without duplicating its
definition:

```json
{
  "registry_version": "stg-rules.v1",
  "aggregation_policy": "all_applicable_pass",
  "rules": [
    { "id": "stg-structure-1", "description": "Every chapter opens with a level-one title.",
      "source": "stg", "classification": "hard", "criterion": "every declared output",
      "applies_to": "all" }
  ],
  "outcomes": [
    { "rule": "stg-structure-1", "output": 1, "outcome": "pass", "evidence": ["ev1"] }
  ]
}
```

`source` separates the general rule set (`stg`) from this request's requirements (`request`)
and editorial preferences (`editorial`). Every expected applicable pair is evaluated: an
outcome that was never recorded stays unresolved and reduces coverage, a `pass`/`fail`
without evidence is downgraded to unresolved, and a hard rule that is `not_applicable` never
fails its output. A definitively failed output stays failed even when another of its checks
is unresolved, and the CAR value is held back with bounds whenever an evaluated output is
unresolved. Optional preferences do not affect CAR.

### CR and its dataset record

`CR` requires the minimum training-dataset record — `model_identity`, an available `corpus`
or documented subset with locally verifiable `files` (`path` + `sha256`), the
`evaluation_population`, the `overlap_criterion`, `access`, `provenance`, `coverage` and the
`checked_items`/`matched_items` counts. The rate is computed from the counts and a declared
`value`, if any, is only verified against them. An inaccessible training set, or a
population from which nothing was actually checked, is `not_assessable`; a partial known
subset produces a qualified, bounded finding. Every referenced file is read locally and
hashed; nothing is downloaded, and a reference library remains a separate
`known_corpus_overlap` diagnostic.

## Five views plus index

Generated deterministically from one validated `assessment.json` bundle:

| file | content |
| --- | --- |
| `01-stg-compliance.md` | the general rule set (`stg`), its outcomes, unresolved and failed checks, the CAR context and the counts of request/editorial rules kept out of it |
| `02-specification-adherence.md` | this request and brief mapped to the observed fulfilment, the request's own requirements, editorial preferences and declared departures |
| `03-metrics-and-indicators.md` | all twelve metrics and eight indicators with status, scope, unit and missing reason, plus segments, boundaries, chronology and coverage |
| `04-score-justification.md` | per-result method, components, trajectory, arithmetic, bounds, coverage, qualification and limits, plus the profile and provenance |
| `05-detected-issues.md` | prioritized findings with affected passages, alternatives and repairs, and the passages worth retaining |

`index.md` is navigation only, not a sixth evaluation. A renderer reads the bundle and never
changes a score or re-judges: re-rendering a stored bundle is byte-identical. Text supplied
by an author (quotes, rationales, requests) is escaped so it can never break a table cell, a
code span, a link, raw HTML or a heading.

## Literary indicators

Eight stable ids: `narrative_coherence`, `thematic_depth`, `character_complexity`,
`originality`, `stylistic_quality`, `emotional_impact`, `interpretive_openness`,
`cultural_value`. Each records a status, a category from its own source list or an
unavailable reason, evidence, rationale, counterevidence, intended-effect fit and evaluator.

## Layout

```
scripts/build-report.mjs      CLI entry point and argument/input validation
scripts/validate-cases.mjs    CLI that validates the synthetic literary case library
scripts/lib/errors.mjs        exit codes, CliError, path, hash and UTF-8 helpers
scripts/lib/input.mjs         assessment-input.v2 loading and validation (§8.2, §8.3)
scripts/lib/workspace.mjs     output separation on real paths and atomic publication
scripts/lib/evidence.mjs      evidence.v1 verification on byte and quote level
scripts/lib/cases.mjs         literary-case vocabulary, quote anchoring and case rules
scripts/lib/case-library.mjs  index, regression subset and model-agreement validation
scripts/lib/segments.mjs      scene, sequence, chapter and arc boundaries
scripts/lib/selection.mjs     scope resolution against the accepted inventory
scripts/lib/candidate.mjs     selected byte ranges to contiguous candidate units
scripts/lib/tokenize.mjs      versioned UTF-8 tokenizer with byte mappings
scripts/lib/corpus.mjs        corpus.v1 loading and verification
scripts/lib/overlap.mjs       SI (shingle Jaccard) and TOP (matched-position union)
scripts/lib/lexical.mjs       corpus comparison orchestration and TOP evidence
scripts/lib/rules.mjs         rule registry, outcomes and CAR
scripts/lib/registry.mjs      metric and indicator registry with value kinds
scripts/lib/rubric.mjs        component metrics (CS, OI, NCS) and the EAP trajectory
scripts/lib/timing.mjs        AEG from opt-in timing-study.v1 records
scripts/lib/contamination.mjs CR from a verifiable training-dataset record
scripts/lib/aggregate.mjs     NQS profile, dependency graph and component aggregation
scripts/lib/study.mjs         calibration-study.v1 verification for the production policy
scripts/lib/annotations.mjs   semantic annotation validation and normalization
scripts/lib/metrics.mjs       metric result builders and CCI/CAD arithmetic
scripts/lib/assemble.mjs      bundle assembly (provenance, coverage, evidence)
scripts/lib/markdown.mjs      escaping and shared rendering helpers
scripts/lib/views.mjs         the five view renderers
scripts/lib/render.mjs        index plus the renderViews entry point
schema/                       the published vocabularies: annotations.v1 and the study format
fixtures/literary-cases/      index, paired cases and the model-agreement record
fixtures/calibration/         the synthetic test-only study that proves the verified path
tests/                        node --test suites and their fixtures
```

No npm dependencies: Node.js ≥ 20 built-in modules only.
