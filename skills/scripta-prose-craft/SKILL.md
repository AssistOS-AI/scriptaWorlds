---
name: scripta-prose-craft
description: Shape or revise fictional scenes through focalization, character voice, subtext, narrative blocks and rhythm, using the book's intended effect and accepted facts. A separate-phase craft skill, never invoked while writing a chapter.
---

# Prose-craft

Craft decisions for scene execution and bounded revision. This is a **separate-phase skill**: it runs during
design and requested-revision phases only, never while ALA is writing a chapter candidate. ALA remains
responsible for producing chapter prose and state proposals; this skill supplies the craft decisions and
validates the profile that records them.

Start from the scene's purpose, focal character, accepted conditions and the reader request. Decide what the
character notices, wants to conceal and can reasonably know. Choose expression and rhythm that make the
intended experience possible. Do not apply fixed dialogue, action or description quotas; sentence length,
block ratios and adjective counts are never validation inputs.

Read [references/narrative-blocks.md](references/narrative-blocks.md) when deciding how a scene should unfold.
Use [references/voice-and-revision.md](references/voice-and-revision.md) for a prose profile and a targeted
revision.

## Prose profile (`proposal/prose-profile.json`, schema `profile.v1`)

Records who speaks and how, in one small document readable alongside an episode plan. The profile lives in
the `proposal/` directory of the external assessment workspace (`docs/contracts.md` §8.1); it is never
written into a universe. Narrative descriptions use the book language; keys remain English.

Required keys: `schema_version` (`"profile.v1"`), `profile_id` (non-empty string), `language` (a supported
code), `reader_experience` (non-empty string), `narrator` (non-empty string — who speaks).

Optional keys: `based_on_version` (the accepted content identity of `docs/contracts.md` §8.2, `sha256:…`; a
universe id is not a version and is refused), `focalization` (object or string), `register`,
`character_voices` (array), `recurring_devices` (array), `revision_priorities` (array of strings),
`expressive_components` (the evidence-bearing annotations of the inspection), `calibration` (the recorded
readiness of the profile) and `intended_use` (`draft`, `review` or `production`).

- `focalization` is an object with optional `mode` (string), `limits` (string) and `focal_character` (string,
  an `entity_id` reference to the perceiving character), or a plain prose string.
- `character_voices[]`: each entry requires `entity_id` (string) and `notes` (string); `speech_habit` is an
  optional string. Voice notes describe decisions a writer can use — e.g. answering indirectly to protect
  status, noticing machinery before faces, avoiding future tense when afraid. They are not verbal tics.
- `recurring_devices[]`: each entry requires `device` and `purpose` (strings).
- `revision_priorities[]`: free-form strings.
- `expressive_components[]`: each entry requires `component_id` (unique), `component` (one of `focalization`,
  `description`, `dialogue`, `narration`, `interior_monologue`, `rhythm`), `anchor` (the passage the
  observation is anchored to), `status` (`observed`, `uncertain`, `unresolved` or `not_applicable`),
  `evaluator` (who judged it), `rationale`, and — unless the status is `not_applicable` — a non-empty
  `evidence` array whose entries pair a `source` with the `quote` it supports. `method` is an optional
  method label; `uncertainty` is required for an `uncertain` or `unresolved` reading, and `alternatives`
  preserves a competing reading instead of collapsing it. With `--context`, every quote is located
  verbatim in the packet file it names, so a fabricated quotation or an undeclared source is refused.
- `calibration` records readiness: `status` (`uncalibrated`, `experimental` or `calibrated`),
  `protocol_version`, an optional `note` and, for a calibrated profile, the `evidence` behind it (entries
  with `source` and `note`). An absent `calibration` means uncalibrated.
- `intended_use: "production"` is refused until the profile actually names a calibration protocol and its
  evidence; the calibration work of C34 does not exist yet, so a profile stays advisory.

Structural rules the validator enforces: unique `profile_id` (it must not collide with a declared
`entity_id`); unique `entity_id` across `character_voices`; unique `device` across `recurring_devices`;
unique `component_id` across `expressive_components`, whose vocabulary, status, `anchor`, `evaluator`,
`rationale`, quoted evidence and stated limitation are all required as described above; a calibrated profile
must name its protocol and its evidence; `intended_use: "production"` requires that calibration;
every referenced `entity_id` (`focalization.focal_character`) must be declared in `character_voices`;
`language` must be one of the 19 supported codes. **No aesthetic judgement is applied**: any prose
description is valid as long as the structural types hold.

Identifiers (`profile_id`, `entity_id`, `device`, `component_id`) are compared after trimming surrounding
whitespace and applying Unicode NFC normalization, so two identifiers that differ only by that collide and
are refused.

A prose profile and an evaluation configuration are **different documents with different schema
identifiers**. `profile.v1` names the prose profile; the metrics evaluation configuration of
`scripta-metrics-report` is `assessment-profile.v1`. A document that names another kind — or that carries
the evaluation configuration's own fields (`aggregation`, or a `scope` whose kind is
`scene`/`chapter`/`arc`/`book`) under `profile.v1` — is refused with a structured error instead of being
validated against prose rules.

## Validator CLI

```
node scripts/validate-profile.mjs --input <profile.json> [--context <packet-dir|manifest.json>]
```

- stdout: exactly one JSON object
  `{ "schema_version": "profile.v1", "ok": bool, "errors": [], "warnings": [], "context": null | {...} }`.
  `context` is null when no packet was supplied; otherwise it records the `universe_id`, the `version` that
  was checked and the `scope` the packet covered (`kind`, `chapters`, `omitted`, `note`), so a result always
  names the accepted version and the coverage behind it.
- stderr: human diagnostics only.
- Every error is structured as `<CODE>: <message>`. The codes are `USAGE`, `OUTPUT_NOT_SUPPORTED`,
  `MISSING_FILE`, `INVALID_INPUT`, `BAD_JSON`, `PATH_ERROR`, `IO_ERROR`, `INTERNAL`, `INVALID_PROFILE`,
  `DUPLICATE_ID`, `SCHEMA_VERSION`, `INVALID_BASED_ON_VERSION`, `STALE_BASED_ON_VERSION`,
  `CALIBRATION_INCOMPLETE`, `UNCALIBRATED_PROFILE`, `UNVERIFIED_EVIDENCE`, `EVIDENCE_NOT_FOUND`, plus the
  packet codes below.
- Exit codes: `0` structurally valid, `2` invalid arguments/input/schema (malformed JSON, wrong types,
  duplicate IDs, unsupported language, a context refusal), `1` execution failure (unexpected I/O).
- `--context` (optional) names an `assessment-input.v2` packet (`docs/contracts.md` §8.3) — the packet
  directory or its `manifest.json`. The manifest is verified first: schema version, path containment through
  real paths, duplicate paths and artifact ids, byte counts, SHA-256 values, the accepted version identity
  recomputed per §8.2, and the declared `scope.kind`. A superseded manifest (`assessment-input.v1`) or an
  unknown `schema_version` is refused as such. `based_on_version` is then compared with the packet's
  `version` (the accepted content identity), never with `book.universe_id`; a profile written for version A
  is refused as stale against version B of the same book, and every quoted component evidence is located in
  the packet file it names. The packet codes are `MISSING_CONTEXT`, `MISSING_MANIFEST`, `MISSING_FILE`,
  `INVALID_MANIFEST`, `PATH_ESCAPE`, `DUPLICATE_PATH`, `DUPLICATE_ARTIFACT_ID`, `DUPLICATE_CHAPTER`,
  `BYTE_MISMATCH`, `HASH_MISMATCH`, `VERSION_MISMATCH`, `SCOPE_INCOMPLETE`, `SCOPE_INCONSISTENT`.
- Without `--context`, a profile that carries a `based_on_version` or quoted component evidence is reported
  as a **warning**: neither the version nor the support can then be checked, and an unchecked claim is never
  treated as agreement.
- No `src/` imports and no npm dependencies.

## Publication and the boundary with the writing phase

The validator is read-only by construction: it takes no output path and refuses one (`--out`, `--output`,
`--emit`, `--write`, `--publish`) before it reads anything, so no output can equal, nest under or alias back
into the profile or the packet. That is deliberate — this skill publishes no bundle of its own, and the
accepted proposal is published by the crafting session that owns the workspace.

The proposal is published into `proposal/prose-profile.json` (`docs/contracts.md` §8.1) and never by
rewriting the accepted proposal in place: write the new profile to a fresh temporary file or directory
inside the same workspace, validate it against the same packet that the rest of the run used, and then
publish it with one rename so a reader sees either the previous complete proposal or the new complete
proposal and never a mixture. A run that fails validation leaves the previous proposal untouched, and a
proposal that is not published is not cited by anything.

**A profile is a proposal and never evidence.** A voice, a device, an expressive component or a
calibration note recorded here is a direction, not a fact: it is not part of the book until an accepted
chapter shows it, and a profile that contradicts the accepted version is reported as stale rather than
applied. Only an approval record and a later writing request carry directions into the book
(`docs/contracts.md` §8.4). Consequently this skill is never part of the chapter prompt: ALA writes a
chapter from `scripta-ala`, the canon and the reader request, and it neither reads nor executes this skill
during a turn. Handing directions to a later writing turn is the host's job, not a step this skill adds.

## What this skill deliberately does not police

The validator settles structure and declared support, nothing else. It never counts adjectives, never
measures sentence length or block ratios, never requires a dialogue/description proportion, never prefers a
register, never demands that a motif be repeated or that a repetition be removed, and it never assesses
whether the prose is good. A deliberately formal, minimal, repetitive, fragmented or unreliable profile is
structurally valid. Whether a scene works is a reader's judgement; the profile records the intention so that
a reviewer can name a passage and the effect to preserve instead of asking for `more adjectives`.

## Drafting pass

1. State what the scene gives the reader and which accepted conditions constrain it.
2. Choose focal attention and immediate desire; identify what the character cannot know yet.
3. Let the encounter change a practical condition, relationship, understanding or emotional position.
4. Use dialogue where people need something from one another; use summary where duration matters more than
   individual exchanges. End at the point that serves the chapter.

## Editorial inspection

Read the scene with the recent chapters, then inspect earlier scenes only where a repetition or continuity
question requires it. Ask whether a repeated image acquires a different meaning.

- **Repeated explanations** — mark one if the reader already has its information and it adds no new pressure,
  misunderstanding or emotional force.
- **Speaker substitution** — try it on a suspect exchange. If the line could belong to any character without
  changing its purpose, inspect the speaker's stake and defence. This is a diagnostic question, not a
  requirement that every character have a visibly unusual voice.
- **Stated lessons** — locate sentences that state the lesson of the immediately preceding action. Keep an
  interpretation when the narrator's judgement is itself revealing; remove it when it merely tells the reader
  what the scene has already shown. Do not replace explanation with decorative adjectives.
- **Emotional distance** — the reader may need a physical inconvenience, a mistaken gesture, humour, ordinary
  work or a private wish to care about an abstract conflict. These details must belong to the character and
  setting, not be a checklist of compulsory humanizing moments.

## Revision

Preserve strong passages. A proposed edit names a passage, a reason tied to this book, and the effect to
preserve. Default to one requested revision pass; recheck the changed evidence and structural validity. If a
change improves cadence but contradicts established knowledge, it is not ready. Submit changed prose through
ALA's candidate workflow. Do not change permanent rules, manufacture earlier evidence, or revise merely to
increase a literary score.
