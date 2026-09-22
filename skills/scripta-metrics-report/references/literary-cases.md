# Synthetic literary case library

This library gives the review phase short paired texts whose intended effect and expected evidence are both known before an evaluator looks at them. It exists so that a reading, an annotation prompt, a rule or a rubric can be checked against text that separates one literary feature at a time, without waiting for a corpus from the user and without pretending that the author's own examples are a benchmark.

Every case here is synthetic teaching and regression material written for this repository. No case is collected reader data, no case carries a human judgement, and the library is never described as an independent human benchmark. The index states this in its own fields: `label` is `synthetic`, `human_benchmark` is `false`, and each case carries `synthetic: true` together with the label `synthetic_teaching_and_regression`.

The library lives in `fixtures/literary-cases/`. `index.json` is the machine-checkable inventory: it names each case file, its language, its target distinction, whether it is a pair or a counterexample, and whether it belongs to the reserved regression subset. `cases/<id>.json` holds one case, and `model-agreement.json` records what has and has not been measured against the library.

A case holds two short texts of the same length and shape. The `before` side is the version whose effect works, and the `after` side is the variant in which exactly one literary feature changed. The two sides keep the same paragraph count, at least one paragraph is identical between them, and `change.changed_paragraphs` names the paragraphs that really differ; the validator compares the sides paragraph by paragraph and refuses a case whose declaration does not match its text.

The case carries a `target_distinction` from a closed vocabulary, and each distinction allows exactly one `change.feature`. The validator refuses a case whose declared feature is not the feature of its distinction, so "one changed feature per pair" is a property the tooling checks rather than a promise the author makes.

`expected_evidence` points at the two halves: at least one anchored quote from each side, each with zero-based half-open UTF-8 byte offsets and a note about what the evaluator should cite. The offsets are matched against the exact bytes of the side text, the quote must occur exactly once, and a quote that is absent, ambiguous or shifted is refused. `acceptable_alternative_readings` records the readings a careful reader may legitimately hold instead of the intended one, so disagreement can be discussed instead of being treated as an error.

`intention` states what the text wants to do, in one sentence, before any evaluator sees it. `provenance` records that the material is `original_synthetic`, who wrote it, when, and that no model was used to produce it. Nothing in a case is quoted or adapted from another work.

The library covers twelve target distinctions in Romanian and twelve in English, one pair each: flat against specific emotion, interchangeable against distinct voices, unsupported against motivated choices, exposition recited in dialogue, meaningful against empty repetition, the quiet scene, nonlinear chronology, the static character, unreliable narration, intentional ambiguity, and two counterexamples where adding conflict or adding explanation weakens the intended effect. The two counterexample cases add material in their weaker half, which the validator checks by length rather than by trust.

The regression subset is declared in `index.json` under `regression_subset`, and it is the eight cases whose `regression` flag is `true`. A later run may send those cases to an evaluator together with a recorded prompt version, and compare whether the evaluator still separates the weaker half from the stronger half after a prompt or model change. The subset is small on purpose: it is a regression check chosen for cost, not a measurement of quality, and a disagreement inside it is a question for a person to read, not a score.

`model-agreement.json` records real evaluator agreement separately from the cases. It currently reports `status: "unperformed"`, with no run, no failure and no figure, because no evaluator has been run against this library. When a run happens, the record takes a status of `partial` or `reported` and carries, per run, the model identity, the prompt and rubric versions, the date, the recorder, the number of cases attempted and agreed, the disagreements written out case by case, and a prompt or input hash. A record that claims a status without such a run is refused by the validator.

The record also states `human_study.status: "not_performed"` with its note. No independent reader has judged these cases, and no field here may be filled with an invented reading. A study that asks whether a rubric agrees with human readers is separate optional research: it needs its own consent, sample, recorded disagreements and limitations, and it would compare a judge with readers rather than with the author's intended effect.

These cases test whether a description of the text matches the text. They cannot establish that a book is good, that a reader will enjoy it, or that literary quality improved between two versions; those questions need the observations that only people provide.

Run the validator from the skill folder or from the repository root:

```sh
node skills/scripta-metrics-report/scripts/validate-cases.mjs
node skills/scripta-metrics-report/scripts/validate-cases.mjs --fixtures <literary-cases-dir>
```

Standard output is one JSON envelope with the case count, the split by language, the number of distinctions, the regression subset and the model-agreement status. Exit status `0` means the library is valid, and status `2` means a refused library: the envelope then carries one `{ file, message }` problem per defect, naming the case file and the reason, and nothing is written.
