---
name: scripta-continuity-review
description: Review a frozen assessment-input.v2 packet for continuity defects, deriving its consistency indicators from a versioned comparison ledger, using immutable source evidence and never editing the story.
---

# Continuity review

Reviews a frozen assessment packet for continuity defects and emits a
`continuity-result.v1` envelope. It never edits chapters, canon, threads, atlas,
permanent rules or design plans. It is chosen only for validation/design phases,
never during chapter writing.

Two kinds of review run in one pass:

1. **Deterministic integrity checks** (no model) — packet shape and hashes,
   chapter numbering, field-specific chapter references, state containers, and
   the chapter references of a design blueprint.
2. **Annotation-driven semantic review** — consumes an optional `annotations.v1`
   file whose judgements were declared by a reviewer, re-verifies every evidence
   item against the frozen packet, and derives the comparison ledger from them.

Read [state-and-evidence.md](references/state-and-evidence.md) to distinguish
facts, beliefs, plans and source evidence. Follow
[review-protocol.md](references/review-protocol.md) when assessing a suspected
contradiction.

## CLI

```bash
node scripts/review-continuity.mjs --input <packet-dir> --out <result-dir> [--annotations <annotations.json>]
```

- `--input` — an `assessment-input.v2` packet directory (see below).
- `--out` — the result directory of one run. It may not exist yet; missing
  parents are created. An existing non-empty directory is refused, because every
  run owns its result directory and an accepted result is never overwritten file
  by file.
- `--annotations` — optional `annotations.v1` file with semantic judgements.

Stdout is exactly one JSON line (the result envelope). Stderr carries human
diagnostics only. The published file `continuity-result.json` inside `--out` is
the same envelope, pretty-printed for reading. The packet and every supplied
input file stay byte-identical.

### Publication

The whole bundle is assembled in a fresh sibling staging directory
(`<out>.staging-<12 hex>`), its inventory and bytes are verified there, and one
`rename` publishes it. A reader therefore sees either the previous complete
result or the new complete result, never a mixture, and a failure leaves `--out`
untouched. A run killed between staging and publication leaves no artifact that
could be mistaken for a result: the next run for the same destination removes
staging leftovers of that naming scheme before it starts.

`--out` must be really separate from every input. The decision uses the real path
of the nearest existing ancestor, so an equal path, a nested path, a symlink
alias and a not-yet-existing child beneath a symlink are all refused before a
single byte is written, and the destination is rechecked once the staging
directory exists.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Review completed. Findings and unsettled comparisons are result data, not failure. |
| `2` | Invalid arguments, input, packet, annotations or result directory. Nothing is written to `--out`. |
| `1` | Execution failure (unexpected I/O, failed publication). The envelope reports the error and names no bundle. |

### Refusal codes

Every refusal is `CODE: message`, so a host can act on it without parsing a
sentence. The packet codes are shared by every consumer of the packet contract
(`docs/contracts.md` §8.3): `MISSING_CONTEXT`, `MISSING_MANIFEST`, `BAD_JSON`,
`INVALID_MANIFEST`, `SCHEMA_VERSION`, `PATH_ESCAPE`, `DUPLICATE_PATH`,
`DUPLICATE_ARTIFACT_ID`, `DUPLICATE_CHAPTER`, `MISSING_FILE`, `BYTE_MISMATCH`,
`HASH_MISMATCH`, `VERSION_MISMATCH`, `ROLE_UNDECLARED`, `INVALID_ENCODING`,
`SCOPE_INCOMPLETE`, `SCOPE_INCONSISTENT`. This skill adds `USAGE` for its command
line, `OUTPUT_INSIDE_INPUT` and `OUTPUT_CONTAINS_INPUT` for the input/output
separation, `MISSING_ANNOTATIONS`, `INVALID_ANNOTATIONS`, `DUPLICATE_ID` and
`INVALID_EVIDENCE` for the semantic annotations, and `IO_ERROR` or
`INCOMPLETE_BUNDLE` when publication itself fails.

## Packet contract (`assessment-input.v2`)

`manifest.json` declares `schema_version`, `universe_id`, the content `version`
of the accepted book, `captured_at`, `book` (with `last_accepted_chapter`), the
declared `scope` and a `files` array. Each file entry has a relative
forward-slash `path`, a 64-hex `sha256`, a byte count, a `role` (`chapter` |
`offer` | `canon` | `threads` | `atlas` | `meta` | `design` | `profile` |
`annotations` | `corpus` | `rules` | `timing`) and an `artifact_id`. Every file
must exist inside the packet, be valid UTF-8, match its declared byte count and
SHA-256, and stay inside the packet directory after symlinks are resolved. The
loader recomputes the §8.2 identity from the chapter, offer, canon, threads and
atlas entries and refuses a manifest that claims a different one.

`scope.kind` is `complete`, `partial` or `textual_only`. `complete` requires
every chapter from 1 to `last_accepted_chapter`, the `canon`, `threads` and
`atlas` roles, and no declared omission. `partial` names the chapters it
contains and declares the rest in `scope.omitted`; a declared omission is honest
and is disclosed in every coverage note, while an undeclared interior gap is
`SCOPE_INCONSISTENT`. `textual_only` carries chapter prose and no state
container, and the result then states that no continuity context was available
instead of implying a clean book.

## Deterministic checks

Each produces a finding with `certainty: "deterministic"` and
`status: "confirmed"`, citing evidence in the offending file. Evidence is built
from the byte spans of the parsed document, so a key that repeats across objects
cites the object that actually offends, and every window ends on a UTF-8
code-point boundary.

- Duplicate active chapter numbers — two files claiming the same `NNNN`,
  including a chapter-numbered file the manifest classified under another role.
- A chapter file numbered beyond `last_accepted_chapter`; a state file entry
  whose `asked_chapter`, `created_chapter`, `closed_chapter` or
  `occurrence_chapter` names a chapter the packet does not contain
  (`missing_reference` or `future_reference`); an atlas occurrence in such a
  chapter.
- A malformed `threads.json` / `atlas.json` / `universe.json`: invalid JSON, a
  non-object container, or a collection key (`open`, `closed`, `promises`,
  `deferred_answers`, `axes`) that is not an array. Structured findings, never a
  stack trace.
- A malformed JSON blueprint under `design` or `profile`, and a chapter list in
  a blueprint (`target_chapter`, `destination_chapter`, `due_chapter`,
  `chapter_memberships`, `planned_chapters`) whose value is not a chapter
  number.

References are read field by field because the fields do not mean the same
thing: an accepted occurrence or an asked question must name accepted material,
while `due_chapter` is a deadline and a blueprint destination is a plan, so both
may point forward inside their own contract. A chapter declared in
`scope.omitted` is a declared omission, not a missing reference.

## Annotation-driven semantic review (`annotations.v1`)

When `--annotations` is present, the reviewer parses the file and refuses it
whole (exit 2) when anything is malformed. Each entry of `findings` is a
semantic claim that must carry:

| Field | Rule |
| --- | --- |
| `id` | stable, unique across the file |
| `source_version` | exactly the packet `version` |
| `scope` | `kind` ∈ `chapter` \| `scene` \| `arc` \| `book`, and non-empty `chapters` naming chapters of the accepted book |
| `evaluator`, `method` | who judged it, and how |
| `kind` | `contradiction` \| `unsupported_change` \| `editorial` |
| `category` | `fact` \| `chronology` \| `character_knowledge` \| `character_attribute` \| `permanent_rule` \| `social_rule` \| `plan` (eligible kinds) |
| `severity`, `certainty` | declared vocabularies |
| `status` | `confirmed` \| `unresolved` \| `dismissed` |
| `rationale` | the reasoning, in prose |
| `evidence` | evidence.v1 items that exist in the frozen packet |
| `alternative_explanation` | required on an eligible claim: state it or declare it `null` |
| `limitations` | required on an `unresolved` reading |
| `attribute`, `catalyst` | required on a `character_attribute` claim; `catalyst: null` states that the accepted material supplies none |
| `comparison` | optional stable id linking symptoms of one underlying defect |

Each evidence item is an `id`, `file`, `sha256`, zero-based half-open UTF-8 byte
range `start`/`end` and the exact `quote`. Verification recomputes the packet
file hash, requires both offsets to be code-point boundaries, decodes the range
as UTF-8 and compares the decoded slice with the declared quote byte for byte. An
item that does not exist in the frozen bytes is `INVALID_EVIDENCE` and refuses the
file: a judgement resting on absent bytes cannot be reviewed by anyone.

A **resolved verdict** — a confirmed contradiction, or a change declared
supported — must additionally carry `baseline` and `later` evidence with
`temporal_scope` naming both chapters. Without that pairing the claim is kept,
reported as `unresolved` and flagged `downgraded_to_unresolved`, so it can
inflate neither the contradicted nor the consistent count. An explicitly
`unresolved` reading with its limitation is welcome; a claim with no evidence at
all is not.

Without `--annotations`, no semantic comparisons are performed and the coverage
note says so. No semantic finding is ever invented.

## Result envelope (`continuity-result.v1`)

```jsonc
{
  "schema_version": "continuity-result.v1",
  "ok": true,
  "version": "sha256:…",              // the packet version this result was bound to
  "scope": { "universe_id": "…", "kind": "complete", "chapters": [1, 2], "omitted": [],
             "chapters_reviewed": [1, 2], "coverage_note": "…",
             "coverage": 1, "coverage_bounds": { "lower": 1, "upper": 1 } },
  "reviewed_claims": ["claim-0001"],
  "comparisons": [ { "id": "comparison-0001", "subject": "…", "kind": "fact",
                     "outcome": "contradicted", "baseline": {…}, "later": {…},
                     "temporal_scope": {…}, "claim_ids": ["claim-0001"],
                     "evidence_ids": ["ev-1", "ev-2"], "limitations": null,
                     "alternative_explanation": "…" } ],
  "counts": { "eligible_comparisons": 1, "consistent": 0, "contradicted": 1, "unresolved": 0 },
  "derived": { "cci": { "status": "computed", "value": 0, "coverage": 1,
                        "lower_bound": 0, "upper_bound": 0, "reason": null },
               "cad": { "status": "not_applicable", "value": null, … } },
  "findings": [ … ],
  "errors": [],
  "warnings": [],
  "outputs": ["<result-dir>/continuity-result.json"]
}
```

The **comparison ledger is separate from the defect list**: a defect list is a
list of symptoms, a ledger is a list of decisions. Each comparison names its
subject, its baseline and later evidence, its temporal scope and one outcome —
`supported`, `contradicted` or `unresolved`; a character change also names its
`attribute` and `catalyst`. Symptoms linked by one `comparison` id share a single
outcome, so repeated symptoms of one defect add one penalty rather than several,
while two distinct defects on the same subject stay two comparisons.

`counts` is derived from those records and never trusted from outside. A `counts`
object in the annotations — or in an embedded previous result — that disagrees
with the ledger is `INVALID_ANNOTATIONS`, and the reproduced `eligible=1,
consistent=8` payload is refused rather than believed. An embedded
`continuity-result.v1` is accepted only when it is `ok`, describes this same
version and scope, and reconciles.

`coverage` is the share of eligible comparisons that reached an outcome and stays
in `[0, 1]` (`null` when there was no eligible comparison); `coverage_bounds`
carries the interval the unresolved comparisons leave open. `derived.cci` and `derived.cad` report `computed` (a single value),
`unresolved` (bounds instead of a value) or `not_applicable` (nothing eligible
was reviewed, so there is no denominator). CAD is `not_applicable` when no
eligible character change was reviewed; withheld indices are never reported as
perfect ones, and judged provenance (`claim_ids`, `evidence_ids`, evaluator,
method, rationale, confidence) survives the arithmetic.

## Ownership

The reviewer is read-only with respect to narrative state. It writes only into
the explicit `--out` directory, and only after the destination has been proven
separate from every input. The host validates the result and publishes the
report; ALA or a human chooses and writes any revision through the normal
transaction.
