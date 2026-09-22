---
name: scripta-story-design
description: Design or revise a book's thematic question, reader promise, flexible arcs, characters, relationships and world assumptions before drafting an episode or changing the book's direction, then validate the brief with a dependency-free Node.js validator.
---

# Story design

Story design prepares a book or an arc before any prose is written. It is a **separate design and
validation phase** — it is **not used during chapter writing**. When a new episode is drafted, use
`scripta-ala`; when prose, continuity or metrics are reviewed, use the matching review skills. This
skill runs only when a design is prepared or revised.

The output is a compact, tentative **design brief** (`schema_version: "design.v1"`). It gives the next
episode a purpose within the book while leaving room for reader intervention. It never turns planned
events into canon and never changes the universe's permanent law.

The brief is written to `proposal/story-design.json` inside the external assessment workspace of
`docs/contracts.md` §8.1 — `<workspace>/<universe-id>/<accepted-version>/<run-id>/proposal/` — never into
a universe folder, and this skill never mutates the frozen packet it reads. A proposal is not evidence:
the directions it records reach a later writing turn only through the human approval of §8.4
(`approval.json`, which carries the proposal's path and hash, the version it was written against, the
reviewer and the accepted directions). The host then passes those approved directions as input data of
the chapter request; the chapter prompt names `scripta-ala` and never asks the agent to read this skill,
one of its references, or a handbook while writing.

Start from the actual reader request, accepted prose and permanent rules. State the unresolved thematic
question and the experience promised to the reader. Identify the characters whose incompatible wants make
that question matter. Choose a structural approach because it suits this book. Keep alternatives when the
next reader decision can change the route. At arc review, compare the accepted story with the previous
design and revise when the story has earned a different direction — never rewrite established facts to
protect an abandoned blueprint.

## Working order

1. Read the permanent law and reader request. Separate explicit constraints from assumptions the author is
   free to explore.
2. Write a short central idea, premise and thematic question, plus the reader promise and what remains
   uncertain.
3. Choose the first focal character and the people whose wants complicate that character's task. Give each
   a private pressure and a different way of resisting.
4. Sketch the initial arc as a direction with possible turns, the cost of failure, and at least one possible
   relationship change. Do not mandate a fixed number of acts or turning points.
5. Identify likely reader interventions and which parts of the plan they can alter. Permanent laws stay
   outside that freedom unless the human changes them.
6. Write the brief and validate it with the CLI below. Leave unused possibilities in the design file rather
   than loading them all into each prompt.

## Brief schema

The brief is a JSON object with `schema_version: "design.v1"`. Required keys: `schema_version`,
`design_id`, `language`, `central_idea`, `premise`, `thematic_question`, `reader_promise`. Optional keys:
`based_on_version`, `structural_intent`, `character_directions`, `relationship_directions`,
`world_assumptions`, `arcs`, `open_design_questions`. Narrative strings use the universe language; schema
keys and enum values use English. `language` must be one of the supported fiction languages (the same
list the server serves from `GET /api/config`).

`based_on_version` is the **accepted content identity** of the version the brief was written against — the
`sha256:…` value of `docs/contracts.md` §8.2, not a universe id. It is what the validator compares with a
`--context` packet, so a brief written for version A cannot pass for version B of the same book.

Identifiers (`design_id`, arc ids, entity ids, world-assumption ids) are compared after trimming
surrounding whitespace and applying Unicode NFC normalization, so two ids that differ only by that collide
and are refused. Arc `chapter_memberships` are positive chapter numbers: `0` and negative numbers are
invalid, while a number above the last accepted chapter is a planned future membership and stays legal.

Character directions refer to stable entity IDs and distinguish desired future development from observed
attributes. Relationship directions identify who wants what to change without overwriting the accepted
relationship. World assumptions carry their epistemic kind (`law`, `observation`, `belief`, `social_rule`,
`hypothesis`, `plan`) and their sources. Keep required fields small; empty optional fields are preferable
to invented certainty. Full field definitions are in `references/concepts.md` and
`references/design-workflow.md`; the exact rules are documented at the top of
`scripts/lib/design.mjs`, and the packet rules at the top of `scripts/lib/packet.mjs`.

## CLI

```
node scripts/validate-design.mjs --input <design.json> [--context <packet-dir|manifest.json>]
```

`--input` names the brief and `--context` names a frozen assessment packet. Both are explicit: the
validator writes nothing, never touches a universe and derives no default path from a repository root. The
brief itself lives in the `proposal/` directory of the external assessment workspace
(`docs/contracts.md` §8.1), as `proposal/story-design.json`.

`--context` accepts an `assessment-input.v2` packet (`docs/contracts.md` §8.3): either the packet directory
that contains `manifest.json` or that `manifest.json` file itself. The manifest is verified before the
brief is judged — the schema version, every declared path (relative, no `..`, inside the packet after
symlinks are resolved), every byte count and SHA-256, duplicate paths and artifact ids, the accepted
version identity recomputed per §8.2 from the chapter, offer, canon, threads and atlas entries, and the
declared `scope.kind` (`complete` requires every chapter up to `book.last_accepted_chapter` plus the
`canon`, `threads` and `atlas` roles; `partial` must declare what it omits in `scope.omitted`;
`textual_only` carries prose alone). A superseded `assessment-input.v1` manifest is refused explicitly,
because it carries no accepted version identity. `based_on_version` is then compared with the packet's
`version`, never with `book.universe_id`: a brief written for version A is refused as stale against
version B of the same book.

Without `--context` a brief that names a `based_on_version` is reported as a **warning** — the version
cannot then be checked, and an unchecked version is never treated as agreement. A proposal whose version
is no longer the accepted version of that book is **stale**: it is reported as stale and is never applied,
and an approval whose proposal changed cannot be applied silently either. Declined directions stay
declined and are not proposed again.

stdout is exactly one JSON object:

```json
{ "schema_version": "design.v1", "ok": true, "errors": [], "warnings": [] }
```

Exit codes: `0` — the brief is valid (warnings are observations, not failures); `2` — invalid arguments,
malformed JSON, or a schema/consistency violation, including every packet refusal; `1` — unexpected
execution failure. An invented future event inside a `plan`-kind world assumption is a warning, not an
error: planned futures are not canon until accepted prose establishes them. An arc whose `status` is
`completed` is warned about for the same reason — a design brief is a proposal, so the status records an
intention, and accepted prose, not this document, establishes that an arc completed. Input files are never
modified.

## Editorial acceptance questions

The validator checks structure, IDs and references; it does not certify the answers as good literature.
Before accepting a design, ask:

- Does the brief identify a human pressure that can be dramatized?
- Does it leave room for ordinary life beyond explaining the world law?
- Is a planned surprise compatible with established evidence?
- Can the next reader decision alter a consequential route?
- Does the chosen form suit this book, including deliberate ambiguity or stability?

## Working material

- `references/concepts.md` — idea, theme, structure, blueprint, characters, relationships, world assumptions.
- `references/design-workflow.md` — the full workflow, proposed artifact, approval transfer and editorial questions.
- `references/source-map.md` — source provenance for the adapted definitions.
- `scripts/lib/design.mjs` — the brief schema and every validation rule.
- `scripts/lib/packet.mjs` — the `assessment-input.v2` loader: hashes, byte counts, real-path containment, the §8.2 version identity and the declared scope.
