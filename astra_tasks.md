# Current implementation tasks

This is the only implementation backlog. Every task below is open. Completed tasks have been removed. Preserve existing working code; implement the corrections and outcomes below. Do not recreate `astra_review.md` or `astra_plan.md`.

## The product decision

Deliver a generic literary review that works without a human calibration study, plus a backend and reader interface that collect the team's feedback for later analysis. Reports run on request and at accepted arc completion. Literary scores are advisory. File integrity and continuity checks retain their own results and acceptance rules.

C34 previously combined software delivery with a human study. That dependency is withdrawn. The executor must author the initial synthetic examples, implement the generic evaluator and collect actual reader feedback through the application. The user does not need to supply a corpus or recruit independent readers before these features work. Team members provide their own responses when they read; the software must also work with zero responses.

A later human study can test whether a particular rubric or aggregate agrees with readers. It requires observations that code cannot invent. That study is optional follow-up research, not an unfinished prerequisite of this implementation. Do not fabricate human responses, rename model judgements as human labels, or claim measured improvement without a measured comparison.

`research` in the existing NQS schema means an experimental formula. It does not prohibit using the feature in the deployed application. `production` currently denotes an aggregate claiming calibration support. Generic reports may use the former with an explicit advisory label. Keep the aggregate optional and the component explanations useful on their own.

## Evidence behind the remaining corrections

Review on 2026-09-22 reran `npm run check`: all 70 checks passed. `node --test skills/*/tests/*.test.mjs` passed all 291 tests. Those results establish the tested contracts; they do not establish literary quality or complete host integration.

- `src/assessments.mjs` captures annotations and corpus inputs, but `phaseCommand` passes neither `--annotations` nor `--corpus`. Both skill CLIs load these inputs only through their explicit arguments. In an isolated copy of the project, a metrics request containing deliberately invalid annotation and corpus schemas still finished as `done`.
- The same reproduction changed both supplied documents and received the first run again with `deduplicated: true`. The identity compares annotation presence and omits corpus identity. These are unfinished parts of the earlier C28.
- `buildNqs` computed 71 from CS 80, OI 60 and emotional fit 70 with weights 0.4/0.3/0.3 under `research`, without human data. The identical `production` request was unavailable because calibration was absent. Generic aggregation already exists; it needs correct integration and wording.
- The production calibration check currently accepts a study identifier, a `held_out` boolean and a nonempty evidence array. It does not establish that the referenced study exists or supports the profile.
- The host runs deterministic report commands. It has no model annotation stage that reads the book and supplies the semantic judgements. A report can therefore contain valid unavailable results while providing little literary diagnosis.
- `listAssessments` sorts on `createdAt`, but records contain `created_at`. Report assembly hardcodes `trigger: 'request'`, including when the host launched an arc review.

## Instructions that apply to every task

Read `AGENTS.md`, `docs/specs/DS001-coding-style.md`, `docs/contracts.md` and the owning specifications through `docs/specs/matrix.md`. Use dependency-free Node.js `.mjs` modules, the current plain browser modules and the existing `omp` integration. Split modules by responsibility within DS001's size limits. Read affected dependency records before changing a dependency or skill. Update contracts, owning specifications and affected HTML pages when implementing behavior. The interfaces below are proposed work, not claims about existing behavior.

The metrics CLI remains a deterministic renderer and calculator. The host's separate review phase owns any model invocation. Review input is a frozen copy; model output, feedback, proposals and reports live outside `universes/`. A review does not run during a chapter-writing turn, alter accepted prose, alter canon or change chapter acceptance. Later writing receives only directions a person explicitly selected and approved under the existing transfer contract.

Use these prepared sources rather than asking the user to provide the DOCX files again:

- [Source map](skills/scripta-story-design/references/source-map.md): paragraph ranges and hashes of `private/guide.docx` and `private/metricx.docx`, including which details are project decisions.
- [Story concepts](skills/scripta-story-design/references/concepts.md) and [design workflow](skills/scripta-story-design/references/design-workflow.md): intention, theme, relationships and flexible structure.
- [Narrative blocks](skills/scripta-prose-craft/references/narrative-blocks.md) and [voice and revision](skills/scripta-prose-craft/references/voice-and-revision.md): focalization, subtext, expression, rhythm and contextual revision.
- [Metric catalog](skills/scripta-metrics-report/references/metric-catalog.md), [literary rubric](skills/scripta-metrics-report/references/literary-rubric.md) and [report contract](skills/scripta-metrics-report/references/report-contract.md): definitions, evidence and output types.
- [Calibration protocol](skills/scripta-metrics-report/references/calibration.md): retain its study procedure, but correct its blanket restriction on enabling NQS as C38 specifies.

Execute C36-C38 first. Generic review and feedback can then be developed independently against the agreed contracts. Do not mark a task done from a filename, a stub, a fake score or an HTTP success alone. Its observable outcome and regression cases must pass. Use temporary books, synthetic responses and a fake model process for tests. Never populate production feedback with test readers.

## C36. Pass declared assessment inputs to their consumers

Priority: first. No new dependency. Work in `src/assessments.mjs`, `src/assessment-packet.mjs`, both review entry points and `scripts/check-assessments.mjs`.

Build child arguments from the frozen manifest and the phase's supported inputs. Pass declared annotations to continuity and metrics, and the declared corpus to metrics. Resolve paths inside the captured input directory. Reject inputs unsupported by a phase rather than silently accepting them. Preserve optional-input behavior. A corpus's referenced texts must also be captured with hashes in a supported layout, or rejected with an actionable missing-resource error; saving only its manifest is insufficient.

Test a valid semantic annotation that changes the expected host-generated component, a valid corpus with an independently known lexical result, invalid annotations and invalid corpus data. Invalid inputs must fail through the host as they do through the CLI. Include continuity annotations and whole-tree input inventories. Complete when supplied inputs appear in report provenance and affect their intended results without changing the book or frozen packet.

## C37. Correct run identity, ordering and event provenance

Priority: first. Depends on C36. Work in assessment records, packet capture, report assembly and integration checks.

Replace annotation-presence deduplication with a versioned fingerprint of phase, accepted version, resolved scope, profile, annotations, corpus manifest and referenced bytes, supplied continuity results and other effective inputs. Include evaluator/prompt versions and mode when C40 adds them. Persist explicit hashes. Identical simultaneous requests must converge through serialized or exclusive creation, not only a list-then-write check. Legacy records with unknown hashes are not proven duplicates.

Preserve the request or accepted arc event that caused a run, including its arc ID, through the published bundle. Map existing `requested`/`request` vocabulary explicitly. Sort by `created_at`, with a stable tie-breaker. Test changed annotation content, changed corpus bytes, different scopes, simultaneous duplicates, restart, legacy records and an arc report with correct provenance. Complete when changed evidence cannot return an older assessment as if it were new.

## C38. Support generic review without the former C34 gate

Priority: first. No new dependency. Work in profile loading, assessment defaults, calibration guidance, DS013 and the skill page.

Bundle a versioned generic profile with understandable defaults and a resolved chapter, arc or book scope. Ordinary requests must not require hand-authored JSON or human study data. Enable component evaluation and keep NQS optional. If selected, generic aggregation uses `research`, with declared weights, an emotional intention and an explicit uncalibrated/advisory explanation. If intention is absent, produce the component report and explain why NQS is unavailable. Do not invent an intention just to obtain a number.

Correct `references/calibration.md` and related documentation so only an empirical calibration claim needs study evidence. Preserve saved-profile compatibility. Test generic input without human labels, research aggregation with known arithmetic, missing intention and an unsupported production claim. Complete when generic review is a supported application mode rather than an apparently blocked experiment.

## C39. Author bilingual semantic examples

Depends on C38. Work under the relevant skill's `references/`, `fixtures/` and tests; keep definitions portable.

Author at least 24 original paired cases, 12 Romanian and 12 English. Change one literary feature within each pair and retain the diff. Include flat versus specific emotion, interchangeable versus distinct voices, unsupported versus motivated choices, exposition in dialogue, meaningful versus empty repetition, quiet scenes, nonlinear chronology, static characters, unreliable narration and intentional ambiguity. Include counterexamples where adding conflict or explanation would weaken the intended effect.

Give each case a stable ID, language, intention, target distinction, expected evidence, acceptable alternative readings and creation provenance. Label them synthetic teaching and regression examples. Reserve a declared subset for prompt regression checks; do not call it an independent human benchmark. Validate schemas and evidence deterministically. Record real model agreement separately, including failures. Complete when the executor has supplied usable examples without requiring material from the user.

## C40. Generate annotations in the separate host review phase

Depends on C36, C38 and C39. Add a focused host module and a versioned annotation prompt. Retain the metrics CLI's no-model boundary.

On a generic review request, run the configured `omp` agent in the external review workspace against the frozen packet. Supply the existing literary definitions, selected scope, relevant contextual examples and bounded output schema. Request observations about the actual prose with verified passages, rationale, uncertainty, counterevidence, strengths and bounded revision suggestions. Produce structured CS/OI components, an EAP trajectory and applicable literary indicators. Separate observed text, declared author intention and evaluator inference.

Record model identity, requested settings, prompt/rubric versions, input hashes, scope and available provider usage. Shared writer/evaluator model provenance must be visible; repeated model calls are not independent human readings. Supplied annotations can be processed without model budget. Omitted annotations trigger the chosen generic mode, while an explicit deterministic-only mode remains available.

Test a fake process that emits valid structured observations for the packet it receives, then verify those observations reach the deterministic report consumer. Complete when the application supplies literary diagnosis without manually authored annotations.

## C41. Validate and bound model review jobs

Depends on C40. Work in the review-job lifecycle, annotation validator and failure tests.

Treat book passages and feedback as data, never as instructions authorizing tools or writes. Restrict the review process to its external workspace using available executor capabilities, and verify input hashes before and after execution. Resolve quoted evidence from exact bytes with unambiguous matching or reject it. Validate annotation schema, scope, provenance and source version before publication. Store generated annotations separately from original frozen input. If a completed evaluation packet is needed, publish a new packet with its own inventory while retaining the original capture and narrative version.

Bound input/output size, duration and attempts. Allow at most one explicit schema-repair attempt and record it. Cancellation and shutdown wait for child termination. Persist error/interrupted states; present a deterministic-only fallback explicitly rather than claiming a successful literary review. Test malformed JSON, fabricated evidence, timeout, cancellation, late writes, restart and a rewrite during review. Complete when failed review jobs cannot become successful judgements or mutate the book.

## C42. Keep missing measurements honest and calibration claims verifiable

Depends on C38 and C40. Work in metric assembly, NQS aggregation and profile validation.

Missing comparison data leaves SI/TOP unavailable unless an eligible corpus is declared. Scope OI to the comparison actually performed. Missing training-set evidence leaves CR unavailable; missing comparable active-human timing leaves AEG unavailable; absent reception evidence normally leaves cultural value unavailable. These gaps must not block other observations. Do not replace missing values with zero or redistribute aggregate weights.

For `production`, replace the current self-declaration check with locally verifiable study artifacts bound to rubric/profile version, language and scope. Arbitrary strings in a nonempty evidence array are insufficient. Until verification exists, refuse the calibrated label while preserving generic mode. Test absent studies, invented references, hash mismatch, incompatible profiles and a synthetic valid study fixture explicitly marked test-only. Complete when setting `held_out: true` cannot manufacture calibration support.

## C43. Expose requested and arc-end generic reviews

Depends on C37, C38, C40 and C41. Work in assessment routes, arc events and focused `public/ui/` modules.

Provide a review action with chapter, declared arc or accepted-book scope, a generic default and optional aggregate setting. Show queued/running/error/completed states, version, scope, strengths, findings and the five report views. Explain unavailable metrics where they appear. Label older reports historical and open their frozen source rather than applying quotations to new prose.

An accepted arc-completion event schedules its configured generic report without hand-written profile JSON. Repeated declarations deduplicate; a planned arc flag remains distinct from an accepted event. Keep integrity results separate. Test live HTTP with a fake evaluator, including requested review, accepted arc completion, failure and historical output. Complete when the team can use generic review through the application.

## C44. Define feedback records and storage ownership

No dependency on generic review. Agree this contract before C45-C51. Work in contracts, storage/API specifications and new focused backend modules.

Use the external assessment workspace, for example `<workspace>/<universe-id>/feedback/targets/<target-id>/` for frozen targets and `entries/<feedback-id>/` for response revisions. Keep it outside `universes/` and independent of assessment retries. Update workspace enumeration so feedback directories are not interpreted as run records.

Define `reader-feedback.v1` with server-issued IDs/timestamps, questionnaire version, reader ID/kind, target ID, universe ID, accepted source version, scope, language, optional run/finding references, nullable answers, comments, evidence, review-condition metadata and revision lineage. Define `reader-feedback-target.v1` with hashes and immutable reading context. Real submissions use `reader_kind: team_human`; model annotations and synthetic fixtures have distinct provenance and do not enter production response counts.

Provide concrete request/response examples, field limits and errors. Complete when identity, ownership and the difference between a reader response and a metric annotation require no guesswork.

## C45. Capture the text each reader actually evaluated

Depends on C44. Work in target capture, accepted-version helpers and chapter response metadata.

Bind a feedback session to the displayed version. Return source version and chapter hash with reading metadata; never attach a form silently to whatever is current at submission. Capture immutable selected prose and scope context outside the universe when opening a feedback target. Reuse verified assessment input where suitable, but allow feedback without an existing metrics report.

Support chapter, declared arc and book scope with explicit chapter membership. Preserve UTF-8 evidence ranges and hashes. If the displayed version cannot be reconstructed, return a stale-target error and preserve the form. A verified frozen target can receive historical feedback after a rewrite. Test rewrite-before-capture, rewrite-after-capture, changed paths, Romanian offsets, invalid ranges and partial scopes. Complete when every stored observation can be reopened against the text its reader saw.

## C46. Persist stable team reader identities

Depends on C44. Work in a small reader registry and API/UI integration.

Offer a first-use team identity choice with a server-issued stable ID and editable display name. Renaming does not change response attribution. Allow a team member to reselect their identity in another browser. Do not require email, external accounts or recruited readers. Separate raw identity from export pseudonyms.

Respect the real access boundary. A self-selected identity in a trusted team deployment is self-identified, not authenticated. Do not claim private per-reader permissions without enforcing them. Make collection an explicit operator setting for the team deployment and expose team records within that configured boundary. Test restarts, duplicate display names, renamed readers, unknown IDs and disabled collection. Complete when responses remain attributable to stable, honestly described readers.

## C47. Implement durable and idempotent feedback writes

Depends on C44-C46. Add focused validation and persistence modules using Node.js built-ins.

Validate target, reader, questionnaire, enums, numeric ranges, text limits and evidence before writing. Bind an idempotency key to the normalized submission: retries return the original result; a changed body with the same key returns conflict. Serialize conflicting writes and publish complete records atomically. Acknowledge only after commitment under the repository's durability policy.

Avoid a shared mutable JSON array. Preserve original responses and immutable revisions with an explicit current-revision rule. Concurrent corrections require the expected revision and return conflict instead of losing answers. Allow comment-only submissions; skipped ratings remain null. Test simultaneous submissions, retries, disk failure, incomplete staging, restart and concurrent edits. Complete when an acknowledged response survives restart without duplicates or lost information.

## C48. Add backend routes for feedback and readers

Depends on C45-C47. Use focused handlers from `src/server.mjs` within file-size limits.

Implement these proposed routes: `POST /api/universes/:id/feedback-targets` to capture a target; `GET /api/universes/:id/feedback-targets/:targetId` to read its frozen scope; `POST /api/universes/:id/feedback` to submit; `GET /api/universes/:id/feedback` to list with bounded pagination/filters; `GET /api/universes/:id/feedback/:feedbackId` for one response and history; `POST /api/universes/:id/feedback/:feedbackId/revisions` for corrections. Add team-reader create/list/update endpoints under one documented namespace.

Resolve server-owned identifiers, never client disk paths. Enforce universe ownership, body limits, methods and the configured access boundary. Responses contain committed IDs, revision, source version and historical status. Pagination has stable ordering. Test HTTP behavior, invalid/cross-universe IDs, traversal, retries and restart. Complete when a client can create, read and correct feedback without filesystem access.

## C49. Build a short questionnaire in the reading flow

Depends on C44-C48. Work in the reader and a versioned questionnaire definition shared with backend validation.

Offer optional anchored 1-to-5 ratings for interest, clarity, voice distinctness, emotional effect and desire to continue. Each item has its own question and labelled endpoints. Add comments for where interest weakened, what felt generic or unconvincing, what should be preserved and what the reader would change. Record whether only part of the target was read. Skipped/not-applicable answers remain distinct from the lowest rating.

Do not require the twelve metrics or scholarly indicator terminology in this first team form. Store stable question IDs and questionnaire version separately from labels. Keep drafts after a failed save; clear only after backend acknowledgement. Show a receipt identifying the evaluated chapter/version and allow a deliberate correction. Test keyboard operation, optional fields, comment-only feedback, network failure/retry and stale targets. Complete when a reader can leave useful feedback without understanding the metrics system.

## C50. Add passage comments and reactions to findings

Depends on C43, C45, C48 and C49. Work in passage selection, evidence validation and report interaction.

Allow exact-passage and whole-target comments. Browser rendered-text offsets are not automatically UTF-8 Markdown offsets. Resolve selections against frozen source unambiguously; if mapping fails, ask for an explicit source passage or retain a whole-target comment. Never guess an anchor.

Add optional reactions to published findings: useful, partly useful, not useful or unable to judge, with a reason and a separate answer about whether the cited defect is present. Bind reactions to real run/finding IDs. Record whether the report was visible before the response; assisted responses are not blind readings. Test repeated phrases, diacritics, formatting, historical findings and missing quotations. Complete when later analysis can distinguish criticism of prose from criticism of the evaluator.

## C51. Preserve individual responses and disagreement

Depends on C46-C50. Work in listing, team review and summary preparation.

Save each reader's answers before showing group distributions in the feedback flow. Record declared exposure to earlier comments/scores; UI order alone does not prove blindness. Preserve discussion and corrected answers as revisions. With one reader, report one reader. For repeated responses by the same reader and target/questionnaire, default summaries select the latest active revision and expose that rule.

Show counts and disagreement, including opposing ratings and interpretations. A discussion outcome may be recorded separately, but it cannot replace raw observations with artificial consensus. Test two readers disagreeing, one revising, one skipping a question and one exposed to the report. Complete when who judged what and under which conditions remains recoverable.

## C52. Export a reusable feedback dataset

Depends on C47, C48 and C51. Add an explicit export command or team endpoint and a portable dataset contract.

Export versioned JSONL plus a manifest with schema, creation time, filters, counts, hashes, questionnaire versions, target IDs and revision-selection rule. Include frozen target texts or a verifiable explicit inventory sufficient to reopen them. Use stable export pseudonyms, omitting display names by default while preserving repeated-reader relationships. Keep human responses, model annotations and synthetic fixtures separately typed.

Exports are immutable snapshots. Collection does not automatically send feedback to a provider, add it to prompts or use it for training. Test round-trip parsing, quote resolution, historical prose, missing answers, disagreement and record/hash counts. Complete when later analysis needs neither HTML scraping nor guesses about which version was read.

## C53. Summarize feedback without hiding its limits

Depends on C51 and C52. Add deterministic summaries and a team review view.

Group by source version, scope, language and questionnaire version. Show reader count, response count, per-item answered/skipped counts and rating distributions. Keep passage comments and strengths accessible. Do not silently combine incompatible questionnaires or old/new prose. Zero responses mean no observations; one reader means an individual response.

Join automated results only by exact version and compatible scope. Keep reader ratings separate from metric units. Any average retains its count and distribution; a 1-to-5 answer does not validate an NQS percentage. Test zero/one/multiple readers, mixed versions, missing answers, revisions and opposite ratings. Complete when collected information is useful without invented consensus or evidence.

## C54. Support optional before-and-after comparisons

Depends on C45, C51 and C52. Add a minimal comparison session and response independently of ordinary feedback.

Bind two immutable targets to a declared question and known authoring/model settings. Persist randomized A/B display order, reader ID, preference for A/B/tie/unable to judge, rationale and whether generation labels or scores were visible. Keep raw preferences separate from ordinary ratings. Support existing pre/post-revision texts without requiring new model calls or a recruited panel.

Label findings as a team pilot with sample size and conditions. Ordinary comments are not a controlled baseline. Later AEG work needs explicit comparable active-human timing; model latency or remembered estimates do not become measured efficiency. Test order persistence on refresh, reversed order, historical targets, ties and unfinished comparisons. Complete when the application can accumulate a future baseline while generic review remains usable immediately.

## C55. Transfer selected feedback into an approved revision

Depends on C50 and C53. Work in the existing approval/findings transfer and rewrite-request UI.

Let an author select reader observations and qualities to preserve as proposed directions for one later request. Retain feedback IDs, source version, passages and approved wording. Reuse approval/version checks. If the book changes, require a fresh interpretation or selection rather than silently applying old observations. Historical feedback remains stored even when it cannot be applied to current prose.

Do not insert the whole feedback store into prompts, rewrite automatically after a low rating or average disagreement into an instruction. Treat comments as quoted data. Test explicit selection, excluded comments, stale evidence, preserved qualities and instructions embedded in a comment. Complete when feedback informs a deliberate revision without creating an automatic rewrite loop.

## C56. Define withdrawal, retention and recovery

Depends on C47 and C52. Work in persistence, export filtering and operator documentation.

Provide a withdrawal state excluded from default summaries and future exports, with an audit event. Document authorized removal of personal text/identity when actual deletion is intended; withdrawal does not erase already exported datasets. State retention and revision semantics. Include feedback, reader registry and frozen targets in backup/restore procedures independently of the live book.

Detect incomplete staging and broken references on startup without converting corrupt data into an empty successful dataset. Keep unaffected records readable and recovery actionable. Test withdrawal after revision, export filtering, interrupted writes, missing targets and restore into a fresh workspace. Complete when stored feedback remains manageable beyond the first save.

## C57. Verify generic review through the host boundary

Depends on C36-C43. Extend current check groups instead of introducing a competing runner.

Use a fake evaluator producing anchored annotations for its actual packet. Assert semantic components, provenance and findings, not only that report files exist. Cover supplied/generated annotations, corpus resources, changed and duplicate requests, optional NQS, accepted arc events, cancellation, restart and historical output. Keep deterministic arithmetic/schema tests in the skill suites. Replay from saved annotations must make no model call and reproduce the same semantic report content.

Document a separate bounded manual smoke with the real configured evaluator to inspect whether its findings concern the prose. Do not describe fake-agent success as literary validation or force paid calls into `npm run check`. Complete when this review's integration bugs fail regression tests and ordinary checks remain deterministic.

## C58. Verify feedback across the UI, restart and rewrite

Depends on C44-C56. Add focused backend tests and a browser smoke on a temporary server.

Exercise two team readers, disagreement, a correction, comment-only feedback, retries, pagination, backend restart and an intervening rewrite. Reopen old frozen prose, submit/read historical feedback, export it and reconstruct its quotations from the dataset. Assert the summary revision rule and that explicitly approved observations reach only the intended rewrite request.

Check passage mapping, keyboard access, failed-save drafts, receipts and historical labels in the browser. Compare live universe inventories before/after feedback and review. Complete when normal operation and failures preserve responses and their source text without altering the book.

## C59. Reconcile documentation with implemented behavior

Depends on the task changing each documented area. Update documentation in each implementation change, then perform this final pass.

Update contracts, relevant DS002/DS004/DS005/DS006/DS013 sections, architecture, operations, API, reader and skill pages, and canonical glossary definitions. Update DS003 only after its required re-derivation of user-facing behavior. Regenerate the specification matrix. Preserve the six-skill catalog unless an actual additional skill is deliberately implemented and documented. Feedback storage is a host feature and does not require a seventh skill.

Document who calls a model, what is deterministic, feedback persistence, old-version access, calibration policy and unavailable results. Publish API claims only after implementation. Remove blanket statements that all NQS use awaits humans. Complete when another executor can follow setup, review, feedback, export and recovery without this conversation.

## C60. Keep only unfinished tasks in this file

Apply after each task passes its focused reproduction and appropriate project checks. Skill `TODO.md` files remain pointers here, not duplicate checklists.

Move enduring instructions into their owning documentation before removing completed tasks. Do not restore the C01-C35 status table or stale test counts. Retain open regressions with their evidence, procedure, dependencies and acceptance checks. If a missing requirement appears, add a focused task rather than declaring the broad feature complete.

The implementation report must distinguish completed software, automated verification, any actual real-model smoke and unperformed human research. Missing volunteers or human study data cannot leave generic evaluation or feedback collection blocked.
