# Anchored rubric (rubric-anchors.v1)

The report publishes one versioned, machine-readable rubric at
`schema/rubric-anchors.v1.json`. It is the scale the host's annotation prompt
declares and the scale `scripts/lib/rubric.mjs` enforces: the same
`rubric-anchors.v1` name appears in the profile, the prompt and the published
file, so a producer can read exactly what the consumer will accept instead of
guessing. `tests/rubric-anchors.test.mjs` fails whenever the published file and
the code disagree, the same way `tests/vocabulary.test.mjs` pins the annotation
vocabulary.

## The scale

The scale is anchored 0 through 4, five levels, each with a general meaning and
a per-dimension description:

| Level | Meaning |
| --- | --- |
| 0 | Absent or broken: the reader cannot recover the relation or the feature at all. |
| 1 | Mostly failed: recovery is usually blocked; the reader supplies what the text does not give. |
| 2 | Partial: recovery is possible but effortful, uneven or dependent on one cue. |
| 3 | Reliable: the reader recovers the relation without strain, with at most minor gaps. |
| 4 | Exact and economical: every needed relation is recoverable and deliberate choices serve it. |

Every rating is a claim about a passage in the selected text: it carries at
least one evidence id, and the reason must name what the passage does. A rating
without a cited passage is not a judgement.

## Defaults that are not defects

The published file states a rule the evaluator must obey, and the case
selection repeats it: a **quiet scene**, a **static character**, a **closed
ending** or a **local cultural setting** is not a defect by default.

- Low tension is not low quality; an aftermath that stays quiet can be the
  point of the scene.
- A character who does not change can be the subject of a scene, and a static
  habit that keeps revealing more is a device, not a failure.
- A deliberately closed ending that satisfies its promise is a success, not a
  dodge.
- A local setting is a setting; it is not a demerit next to a "universal" one.

A low rating on any dimension therefore requires cited evidence that the chosen
device fails its own purpose in the selected text, never the bare fact that the
device was chosen.

## Component dimensions

### CS — Coherence Score (four dimensions)

- **Referential clarity**: who and what each pronoun, name and definite
  description points at.
- **Discourse connection**: whether consecutive utterances are linked by
  recoverable relations rather than juxtaposed.
- **Causal support**: whether events and choices carry recoverable causes and
  consequences.
- **Temporal intelligibility**: whether the reader can reconstruct the order
  and duration of events.

The experimental scalar is `100 * sum(ratings) / 16`, and it exists only when
all four dimensions are assessable under this rubric version.

### OI — Originality Index (three dimensions)

- **Perspective**: distinctiveness of the viewpoint or voice.
- **Dramatic development**: distinctiveness of how the scene or turn unfolds.
- **Expression**: distinctiveness of diction, syntax and imagery.

OI requires an explicit `comparison_scope`: the references the judgement was
made against. The experimental scalar is `100 * sum(ratings) / 12`, and only
with complete ratings and a named scope. OI is never `100 - SI`.

### NCS — Novelty & Cliché Score (two dimensions)

- **Novelty of execution**: freshness relative to recent scene patterns and the
  declared scope.
- **Cliché reliance**: how much the effect depends on overused expression or
  machinery instead of earned choices.

NCS has no combined scalar: the two dimensions stay separate until their
trade-offs are calibrated. A fixed phrase alone is a candidate for inspection,
not proof of cliché.

## The eight literary indicators

Each indicator publishes its contextual definition, the evidence question that
forces the evaluator to cite a passage, and the intended-effect qualification
that keeps a description from being misread as a score. The category lists are
the same lists the validators accept (see `scripts/lib/registry.mjs`):

| Indicator | Categories | The question to answer with a citation |
| --- | --- | --- |
| Narrative coherence | Low / Medium / High | Which relation works or fails, and how is it recovered? |
| Thematic depth | Superficial / Moderate / Profound | Which competing values make a choice defensible in more than one way? |
| Character complexity | Simple / Moderate / Complex | Which action reveals a want or contradiction the surface would not predict? |
| Originality | Low / Partial / High | Which choice is this text's own, and against what declared reference? |
| Stylistic quality | Poor / Acceptable / Excellent | Which exact passage shows the style working for, or against, the text? |
| Emotional impact | Weak / Moderate / Strong | Which situated action or detail invites investment or distance? |
| Interpretive openness | Closed / Partially open / Open | Which readings does the text support, and on what evidence? |
| Cultural value | Local / Regional / Universal | What reception evidence exists — or, for a new book, that it does not yet exist? |

`cultural_value` stays `not_assessable` for a newly generated unpublished book:
its reception evidence does not exist yet, and predicting universal importance
would be fabrication. Current contextual resonance may be described separately;
it cannot substitute for demonstrated influence.

Do not convert the indicator categories to 1, 2 and 3 and average them into a
literary grade. Each indicator stands on its own, with its own evidence.
