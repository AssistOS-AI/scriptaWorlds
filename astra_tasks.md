# Current implementation tasks

This is the only implementation backlog. **Every task listed here is open; completed tasks have been removed.** There are none open at this moment.

The behaviour itself is specified where it lives: `docs/specs/DS003-main-behavior.md` states what the product does for readers and operators, the specialised specifications under `docs/specs/` own their areas, `docs/contracts.md` is the reference for every format, payload and command line, and `AGENTS.md` carries the rules of the repository. A task that outlives this file belongs in one of those, not here.

## The product decision

Deliver a generic literary review that works without a human calibration study, plus a backend and reader interface that collect the team's feedback for later use. A book can also arrive as a file the team did not write here: it is imported into a universe of its own and then treated exactly like one written here — reviewed, measured, rewritten chapter by chapter and printed.

C34 previously combined software delivery with a human study. That dependency is withdrawn: the review path is complete without it, and the aggregate that claims calibration support stays refused until verifiable study artifacts exist (`skills/scripta-metrics-report/schema/study.v1.json`).

A later human study can test whether a particular rubric or aggregate agrees with readers. It requires observations that code cannot invent. That study is optional and remains unperformed.

## How the work was verified

**Completed software.** The store and its turns; the book renderer and the print skill; the separate design and review phases with the annotation stage, whose observations come from the configured evaluator and are validated before the report sees them; the review surfaces in the reader (an icon toolbar, a review panel and a report panel); the import pipeline (upload, dependency-free extraction of a DOCX or a PDF, bounded import turns verified by the import skill); and team feedback (frozen targets, reader identities, responses with quoted evidence, corrections and withdrawals, a reproducible export, an honest summary, supported comparisons, and carrying selected feedback into an approved revision).

**Automated verification.** `npm run check` runs 137 checks against temporary universes and spends no model budget; it includes the review boundary, the import pipeline end to end, the feedback groups and the export/summary/comparison/revision groups. `node --test skills/scripta-metrics-report/tests/*.test.mjs` runs 144 tests and `node --test skills/scripta-import/tests/*.test.mjs` runs 49. The review groups replace the agent with a real child process of their own, so the pipeline they prove is the pipeline that runs.

**Real-model smoke.** One bounded review against the real evaluator was performed and is documented in `docs/operations.html`: run `20260922T163803-metrics-7c57` on a one-chapter book with `omp/18.2.8` and `deepseek/deepseek-v4-flash` reached `done` with seven published files and `packet_intact: true`; its first attempt was refused for a missing `schema_version` and the repair call, which names the failed field, was accepted. An earlier smoke (`20260922T162643-metrics-ade6`) completed the same way. Nothing else in this repository has been run against a real model.

**Unperformed research.** No human study, no volunteer readings, no calibration of an aggregate against readers. The synthetic case library declares `human_benchmark: false` and its model-agreement record is `unperformed`, and the report refuses a calibration claim without verifiable study artifacts. Nothing here may be reported as validated by readers.

## Open regressions

None recorded. A regression is added here with the evidence that reproduces it — the command, its output and the version it was seen on — and removed only when that evidence no longer reproduces.
