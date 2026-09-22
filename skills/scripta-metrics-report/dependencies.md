# Dependencies

## Scope

This record covers the full `scripta-metrics-report` skill: instructions (`SKILL.md`),
the five references under `references/`, catalog metadata (`skill.json`), the deterministic
engine and Markdown renderers under `scripts/`, the synthetic literary case library under
`fixtures/`, and the `node --test` suites under `tests/`.

## Runtime prerequisites

- **Node.js ≥ 20** — required for `scripts/build-report.mjs` and the `scripts/lib/*.mjs`
  modules. Only built-in `node:` modules are used (`node:fs`, `node:path`, `node:crypto`,
  `node:util`, `node:child_process` in tests). Verify with `node --version`; without it the
  command cannot run, but the instructions and references remain usable.

## External dependencies

None. No npm packages, no vendored code, no third-party CLIs, no CDN, no build step and no
runtime downloads. The optional corpus is read only from an explicit `--corpus` manifest
and is never downloaded. The command never starts a model and never hits the network.

The deterministic SI/TOP lexical measures need an explicitly supplied corpus manifest.
Corpus rights, provenance, language, hashes and exclusions belong to the manifest and
study record; a corpus is data, not evidence of access to a model's training set.

Segmentation is this skill's own versioned method (`scripts/lib/tokenize.mjs`,
`unicode-letter-run-v2+byte-offsets`): it declares the scripts it cannot segment instead of
adopting a linguistic library, so no tokenizer, stemmer or language detector is a
dependency. Its supported languages, its treatment of numbers, apostrophes, diacritics,
Markdown headings, quotations and boilerplate, and its exact token-to-UTF-8-byte mapping are
documented in that module and summarized in `SKILL.md`.

External embeddings, NLP packages, language classifiers, plotting libraries and datasets
remain deferred. Before adopting any of them, record the exact dependency, purpose,
alternatives, license, source, entry-point probe and removal opportunity.

The literary cases under `fixtures/literary-cases/` are original synthetic text written for
this repository, so they carry no third-party rights, no license obligation and no corpus
download. They are validated by `scripts/validate-cases.mjs` with Node.js built-ins only, and
the model-agreement record they contain is a data file rather than a dependency: it changes
only when a real evaluator run is recorded.

## Maintenance

Any future dependency (library, CLI tool, dataset) is recorded here with justification,
rejected alternatives, source, license, startup check and removal opportunity. Nothing is
installed globally without explicit authorization. The local references identify the guide
and metrics DOCX by hash only; neither private document is a runtime dependency.
