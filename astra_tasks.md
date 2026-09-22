# Current implementation tasks

This file contains only current corrections and the evidence needed to implement them. All C61-C86 tasks below are open. Do not restore the completed C01-C60 checklist or create another review document. Remove a task only after its regression no longer reproduces and its enduring instructions have moved into the owning documentation.

## Review basis and limits

Reviewed on 2026-09-22 against `18f3a54`. `npm run check` passed 137 checks and `node --test skills/*/tests/*.test.mjs` passed 372 tests. Additional probes used the real report CLI, the existing fixture builders and isolated copies of the host with a fake evaluator. No existing book was rewritten. The reader and report interfaces were traced in source; this review did not repeat a browser smoke or call a paid model. Earlier model smoke results show that a run completed, not that all its literary measurements worked.

The implementation has useful packet validation, report rendering, lexical calculations, component builders and feedback persistence. The remaining defects affect what is evaluated, which evidence supports a score, whether a model failure counts as success, and whether reader responses form a valid comparison. The previous statement that no regressions remained is withdrawn.

Generic evaluation remains usable without human calibration. Human research is not a delivery gate. Synthetic cases can test specific distinctions; actual reader responses can accumulate through the application. Neither may be relabelled as an independent human study. Literary scores stay advisory, reports run on request and at accepted arc completion, and integrity/continuity checks retain their separate responsibilities.

## What the metric implementation still needs

| Metric | Current gap to correct |
| --- | --- |
| CS | Components calculate, but their rating anchors are not supplied to the evaluator, evidence can be outside the selected text, and unavailable components retain numerical values. |
| OI | The same component/status/scope defects apply. A free-text comparison description must not imply a corpus comparison that never happened. |
| NQS | Can calculate from unavailable/error components and a bare emotional-fit number without valid supporting judgement. |
| EAP | The prompt requests `points` and `segment`; the consumer reads `trajectory` and `segment_id`. The supplied trajectory disappears into an unavailable result. |
| NCS | A component builder exists, but the generic prompt does not request its two dimensions. |
| CCI and CAD | The generic metrics path does not supply a verified continuity result. Metrics also accepts incomplete continuity totals and can report full coverage for a largely unexamined population. |
| CAR | The generic path has no supplied rule/outcome registry and does not capture the charter or originating request as authoritative review input. The two compliance reports can be empty shells. |
| SI and TOP | A declared corpus is legitimately required. However, byte-identical text in an independently identified reference is wrongly discarded as the candidate's own source. |
| CR | Normally unavailable without accessible training data. Keep this limitation; do not substitute convenient reference-library overlap. |
| AEG | Normally unavailable without comparable active-human timing. Keep this limitation; ordinary ratings or model latency do not supply it. |

The eight literary indicators also need their contextual definitions, evidence questions and intended-effect qualifications in the actual evaluator input. Publishing their category names alone does not implement the rubric.

## Execution instructions

Read `AGENTS.md`, DS001, `docs/contracts.md` and the owning specifications before implementation. Use dependency-free Node.js modules and the existing browser modules. Keep portable skill code independent of `src/`. The deterministic report CLI stays model-free. Host evaluation, proposals and feedback operate outside `universes/` on frozen accepted content. Update affected contracts, specifications and HTML pages in each behavioral change; do not document an intended fix as implemented before its test passes.

Keep the definitions prepared from the private documents: [source map](skills/scripta-story-design/references/source-map.md), [story concepts](skills/scripta-story-design/references/concepts.md), [design workflow](skills/scripta-story-design/references/design-workflow.md), [narrative blocks](skills/scripta-prose-craft/references/narrative-blocks.md), [voice and revision](skills/scripta-prose-craft/references/voice-and-revision.md), [metric catalog](skills/scripta-metrics-report/references/metric-catalog.md), [literary rubric](skills/scripta-metrics-report/references/literary-rubric.md), [report contract](skills/scripta-metrics-report/references/report-contract.md) and [calibration protocol](skills/scripta-metrics-report/references/calibration.md). Do not ask the user for those documents again.

P1 means incorrect results, attribution or job behavior. P2 means incomplete evaluation, usability or reproducibility. Start with C61-C64 and C67-C71, then complete the evaluation inputs and feedback corrections. Keep each change reviewable. The final acceptance pass is C84; C85 reconciles documentation, including newly added import behavior.

## C61. Make the produced EAP document match its consumer

Priority P1. Work in `src/annotation-prompt.mjs`, the published annotation schema, `rubric.mjs` and vocabulary/host tests.

Evidence: the prompt at line 97 requests `EAP.points` with `segment`, while `buildEap` at line 226 reads `trajectory` with `segment_id`. Moving the valid fixture's trajectory to the requested shape makes the real CLI exit 0 while EAP becomes `not_assessable`. The vocabulary test checks enum lists but never this field structure.

Publish one executable structural contract for EAP and build a complete valid prompt example from it. State valence, tension and emotional-fit scales separately. Reject unsupported field names or handle a documented compatibility conversion instead of silently losing supplied observations. Include NCS's two component fields in the producer contract. Test a document in exactly the requested shape through prompt-stage validation, CLI assembly and rendering. Done when EAP remains an ordered trajectory and NCS remains a pair of components in a generic host report.

## C62. Prevent scores from unavailable or failed inputs

Priority P1. Work in `rubric.mjs`, `assemble.mjs:getEmotionalFit`, aggregate validation and rendering tests. Depends on C61 for emotional-fit structure.

Evidence: set fixture CS to `not_assessable`, OI to `error`, and EAP to `{status:'not_assessable', emotional_fit:100}`. Enable research weights 0.4/0.3/0.3 with an intention. The CLI returns CS 75, OI 50 and a computed NQS 75 with coverage 1 despite those statuses.

Validate the complete status/value contract. Unavailable, inapplicable and failed results cannot provide eligible aggregate values. Require emotional fit to have its own assessability, scale, evaluator, rationale, evidence and declared-intention binding; it may be assessed separately from a trajectory but cannot be an unsupported number. Preserve valid zero scores. Test every status, missing dimensions, absent fit evidence, valid zero and known arithmetic. Done when the aggregate states precisely which prerequisites are missing and never consumes ineligible cached numbers.

## C63. Send the requested selection to the evaluator

Priority P1. Work in `assessments.mjs`, generic scope resolution, packet metadata and annotation prompts.

Evidence: requesting only chapter 1 from a two-chapter book gives the model `REVIEW SCOPE: complete 1, 2`, while the published bundle labels its results chapter 1. `generateAnnotationsForRun` passes `record.scope`, the packet inventory, instead of the resolved review selection. Scene/arc identifiers and context are also lost from the host's reduced requested-scope record.

Resolve selection before the model call. Carry selected chapters/ranges/segments, explicitly permitted context and omitted material without conflating them with packet inventory. Give the model a clear reading list and distinguish evidence about selected prose from contextual explanation. Resolve scope against the captured version, including `fromTurn`, rather than the current live inventory. Test chapter, scene, arc, whole book and historical capture. Done when requested scope, model input, evidence validation and published scope agree.

## C64. Enforce scope on all semantic results and coverage

Priority P1. Work in assembly, semantic annotation validation and evidence/segment selection. Depends on C61-C63.

Evidence: configure the fixture to select chapter 1 with no context and change every CS dimension to cite `ev3`, a quotation from chapter 2. The CLI still reports CS 75 with coverage 1. Its EAP also retains points from chapter 2. Evidence existence is checked, but selection eligibility is not.

Require semantic judgements, indicators, trajectories, findings and preserved passages to identify the selection they describe. Reject or explicitly exclude out-of-scope observations. Permit declared contextual evidence to explain a selected claim, not to become the only basis for a score of unexamined prose. Enforce scene byte ranges and arc membership as well as chapter numbers. Distinguish component completeness from textual coverage; one quote does not establish full-book coverage. Test changed scope with reused annotations, context-only evidence and partial scene ranges. Done when a valid quote from the wrong text cannot support a current score.

## C65. Supply actual rubric anchors and teaching passages

Priority P1 for rating interpretation. Work in `annotation-prompt.mjs`, canonical rubric resources and the case loader. Depends on C61.

Evidence: the prompt declares an anchored 0..4 scale but supplies no descriptions for those ratings. The loader reads only the case index, never the case files. It always selects the first eight Romanian entries and supplies the placeholder `the feature that changed` rather than the paired passages and evidence. The detailed literary indicator definitions are not loaded either.

Define versioned per-dimension 0..4 descriptions with concrete distinctions, evidence requirements and justified exceptions. Supply relevant literary definitions and a bounded selection of actual original cases in the book's language. Include paired text, changed feature, evidence and alternative readings. Separate teaching selections from any declared regression holdout. Do not rank quiet scenes, static characters, closed endings or local cultural settings as defects by default. Test the assembled prompt for actual passages, language selection, anchors and counterexamples. Done when the evaluator receives the material that gives its ratings meaning.

## C66. Connect available narrative context, continuity and rules

Priority P1 for completeness. Work in packet roles, the host review workflow, the annotation prompt and requirements assembly. Depends on C63-C65.

Evidence: the generic prompt requests CS/OI/EAP and indicators but no NCS, continuity result or requirements registry. The packet omits the charter and accepted authoring request/brief. The UI ordinarily supplies none of these. Consequently CCI/CAD and CAR cannot assess available project facts, and compliance views have nothing to report.

Capture the relevant charter, originating request, approved directions and declared intention with provenance when they exist. For imported books, distinguish absent authoring instructions from actual violations. Run or consume a verified continuity assessment on the same version and selection as a separate substage, without turning literary scores into acceptance gates. Supply its comparison results to metrics. Build a versioned applicable-rule registry with observed outcomes; do not let the model invent the authoritative rules. Request NCS explicitly. Test one real rule failure, one unresolved rule, a scoped continuity comparison and an imported book without a brief. Done when naturally available inputs produce useful compliance/continuity views while genuinely missing data remains explained.

## C67. Include all effective inputs in run identity

Priority P1. Work in `assessments.mjs`, `inputFingerprint` and generic-profile serialization.

Evidence: the fingerprint call hardcodes `mode: 'deterministic'` and omits model, prompt, request, brief and intention inputs. Starting a deterministic chapter review and then requesting generic review with a different model/request returns the old deterministic run as a duplicate. Conversely, generic aggregate profiles include wall-clock `created_at`, so equivalent profiles can hash differently.

Fingerprint normalized effective scope, mode, model/settings, prompt/rubric/case versions, request, brief, intention and every supplied input. Separate timestamps from semantic profile identity. Persist the fingerprint version and reject unsupported equivalence claims for old records. Preserve serialized concurrent creation. Test changes to each effective input, equivalent repeated aggregate requests and different teaching-resource versions. Done when duplicates mean the same evaluation and cannot suppress a requested model review.

## C68. Validate the full annotation contract before the repair decision

Priority P1. Work in annotation-stage validation and reusable portable validators. Depends on C61-C64.

Evidence: `{schema_version:'annotations.v1', source_version:<correct>}` passes the host stage and produces a `done` generic report with zero judged metrics. Rating ranges, complete metric shapes, indicator categories and several finding fields are left to the later CLI. A consumer rejection therefore does not trigger the advertised schema-repair attempt.

Run the full shared structural/evidence/selection validation before accepting generated annotations or deciding whether to retry once. Require an evaluation disposition for each requested component: supported observation or explicit reason it cannot be assessed. An empty object is not a completed review. Keep honest unavailable results valid. Validate UTF-8 boundaries and accept exact repeated quotations at their declared valid offsets; the current first-occurrence test wrongly rejects later repeated passages. Test consumer-level failures through the repair path and a valid repeated quote. Done when stage success means a report-consumable evaluation with explicit coverage.

## C69. Respect evaluator exit status and enforce resource bounds

Priority P1. Work in `runAnnotationStage` and `generateAnnotations`.

Evidence: a fake evaluator emits a minimally valid document and exits 1. The host records the failed exit but still publishes seven files with status `done`. The stage checks `validation.ok` without requiring `call.ok`. `stdout`, `stderr` and response text grow without enforced bounds; `MAX_OUTPUT_BYTES` is reported but never used to stop the stream.

Treat nonzero exit, timeout, signal, spawn failure and output overflow as process failures. Do not publish their partial output as a successful reading. Enforce byte limits while streaming and a total budget across original and repair attempts. Bound the input before invocation. Keep actionable diagnostics and distinguish process failure from fixable schema failure. Test valid-looking output followed by failure, overflow, no output, timeout and repair-budget exhaustion. Done when process failures remain failures without unbounded memory or repeated calls.

## C70. Cancel and stop every review child before settling the run

Priority P1. Work in assessment process ownership, cancellation, server shutdown and retry state transitions. Depends on C69.

Evidence: cancel during the annotation stage returns `cancelled`, but the fake evaluator continues and the run becomes `done` with seven outputs. The annotation child is absent from the host's `running` map. Cancellation also modifies a separately loaded record rather than the executing record. Server shutdown stops writing jobs but has no matching assessment-child shutdown.

Give each run one lifecycle controller covering annotation, repair and deterministic children. Cancellation stops the active child, waits for termination, prevents later stages and wins over late success. Shutdown stops intake and waits or escalates before releasing ownership. Prevent a retry while a cancelled child still lives. Test cancellation at every stage, a child ignoring SIGTERM, a late write and restart. Done when cancelled/interrupted runs cannot publish success or survive server ownership release.

## C71. Enforce frozen inputs and review write boundaries

Priority P1. Work in review execution, packet validation and input/output publication.

Evidence: `packet_intact` compares manifest hash strings before/after rather than hashing the actual files, and unreadable manifest fallback reuses the previous strings. The evaluator is launched with `--auto-approve` in a working directory; a working directory alone does not restrict filesystem writes. The downstream CLI may catch some corruption, but the recorded integrity claim is still unsupported.

Validate original bytes and paths before invocation and rehash them after all children terminate. Missing/unreadable files must fail integrity. Restrict model tools so review cannot edit the live universe or its frozen inputs. If the executor cannot provide an enforceable read-only tool boundary, have the host supply bounded source text to a tool-disabled evaluation call and write returned data itself. Test mutation of a chapter without changing its manifest, removed manifest, attempted writes outside the review output area and symlink escapes, entirely in temporary workspaces. Done when `packet_intact` describes actual verified bytes and the claimed write boundary is enforced.

## C72. Validate continuity populations and source identity

Priority P1. Work in `normalizeContinuity`, CCI/CAD calculation and the shared comparison contract.

Evidence: supplying `eligible_comparisons:100, consistent:1, contradicted:0, unresolved:0` is accepted and yields CCI 100 with coverage 1. The validator rejects only totals greater than the population. It also keeps continuity `version` separately from the optional `source_version`, so the actual source identity must be checked explicitly.

Require a complete partition or represent unexamined comparisons as unresolved with coverage and bounds. Bind the result's authoritative version and exact scope to the packet. Derive counts from verified comparison records where available instead of trusting bare totals. Keep CAD candidates and defect deduplication in the same selected population. Test missing comparisons, stale version, duplicate defects and conflicting candidate statuses. Done when a single observed success cannot imply complete consistency across 100 eligible comparisons.

## C73. Distinguish an independent exact copy from self-comparison

Priority P1. Work in corpus provenance, `classifyReferences`, SI/TOP and host corpus capture.

Evidence: build the fixture with `referenceText: CHAPTER_1`. The independent `ref1` is excluded solely because its hash equals the selected chapter; both SI and TOP become unavailable with `same_source_version`. Exact duplication is the case overlap measurement most needs to retain.

Represent corpus source identity separately from byte identity. Exclude a reference only when declared and verified to be the same candidate source/version. Preserve an independent reference with identical bytes and label duplicate text. If identity is unknown, say so instead of inferring self-reference from a hash. Test genuine self-comparison, independent exact duplication, whitespace-only changes and partial selected scenes. Done when an independent full copy produces the expected full overlap.

## C74. Make trajectory order and coverage operational

Priority P2. Work in EAP, segment ordering, selection and its rendered views. Depends on C61 and C64.

The current builder trusts array order, records `ordering: story` when supplied and sets coverage to 1 for any nonempty trajectory. It does not establish that all selected segments were assessed or that story-order claims match the sequence displayed.

Define whether incoming order must be valid or is normalized with its original order retained. Check duplicate/missing segment references, declared story order and disclosure order. Retain separate character/focalization trajectories where relevant. Report assessed versus selected segments and explicit omissions; low tension is a description, not a defect. Test a nonlinear sequence with reversed supplied story positions, one assessed segment among many and overlapping arc membership. Done when the EAP view represents the declared chronology and actual coverage.

## C75. Save auditable evaluator provenance with the report

Priority P2. Work in generated artifacts, run records and bundle provenance. Depends on C65, C67 and C68.

The run retains a prompt version and attempt summaries, but not the exact full prompt and resource selection. Metric evaluator labels are model-authored strings, and the standalone bundle does not retain the complete host evaluation provenance. The stored generated-annotation hash is also computed from compact JSON while the file is pretty-printed; retry recomputes a different hash from the file bytes.

Save the exact prompt or a complete reconstructible prompt manifest, rubric/case hashes, actual model/settings, attempt identities, source selection and byte hashes of generated artifacts. Bind generated evaluator identity to the host invocation. Include this provenance in portable report output while keeping model variability explicit. Record provider usage only when observed. Test re-rendering saved annotations without a call and verify all published hashes against actual files. Done when another session can establish what the evaluator saw and which judgement produced each result.

## C76. Preserve published assessments across retries

Priority P1 for historical evidence. Work in retry lifecycle, report identifiers and feedback references. Depends on C67 and C70.

Evidence: `retryAssessment` permits a `done` run, deletes its result directory and republishes under the same run ID. Existing feedback and finding links can then refer to a replaced report. Generated annotation reuse checks file existence and recalculates its hash instead of comparing it with the originally accepted artifact.

Keep successful published results immutable. Re-evaluation creates a new run or immutable attempt ID with an explicit relationship to the old one. Failed/interrupted retries retain their attempt records and validate any reused annotations against their saved hash and source. Bind finding reactions to the exact report revision. Test re-evaluation after reader reactions and tampering with stored annotations. Done when historical evidence links cannot change meaning after retry.

## C77. Bind feedback capture to the displayed version

Priority P1. Work in chapter reading metadata, feedback target API, capture and reader form.

Evidence: read a version, replace its chapter, then call `createFeedbackTarget` with the former `sourceVersion`. The function ignores that field and silently freezes the new version. The reader sends no expected version and currently always requests a book target. Checking quotes later cannot detect a misattributed whole-text rating.

Send the version and displayed chapter hashes when opening feedback. Capture that verified version or return a stale-target response preserving the draft. If a frozen historical target exists, reopen its text explicitly. Coordinate capture with narrative mutation so version/hash/content cannot race. Expose the intended chapter, declared arc or book scope in the form. Test another client's rewrite between reading and opening feedback, rewrite during capture and a comment-only response. Done when feedback cannot silently attach to prose its reader never saw.

## C78. Separate feedback populations and count independent readers

Priority P1. Work in summary, comparison and response selection.

Evidence: one reader submits interest 1 and 5 for chapter 1, then 3 for chapter 2 in the same accepted version. The summary combines all three into a distribution and reports mean 3. Its comparison threshold counts answered responses, so repeated submissions from one person can satisfy the three-response threshold. Questionnaire declarations also collapse by question ID across versions.

Group comparable responses by exact source version, scope/target, language and questionnaire version. Define one latest active response per reader and compatible target/questionnaire, preserving older submissions in history. Count independent readers separately from response records. Do not pool chapter and book ratings or changed questionnaire scales. If showing a cross-target summary, label its unit and selection explicitly. Test repeated submissions, two chapters, questionnaire changes and one versus three readers. Done when a distribution states a defensible population and repetition cannot masquerade as independent feedback.

## C79. Serialize correction validation with correction writes

Priority P1. Work in `feedback-entries.mjs:resolveRevision` and `submitFeedback`.

Evidence: two concurrent submissions with different IDs and the same `revisionOf` both succeed. Parent validation runs before the serialized write. The result has two current children even though the contract promises one correction lineage.

Validate the parent and expected current revision inside the same serialized transaction as idempotency lookup and publication. Check reader identity, target, source version, questionnaire and withdrawal status there as well. A correction cannot silently move an answer to another target. Preserve same-key retries without adding branches. Test concurrent siblings, withdrawal racing a correction, correction to a different target and identical retries. Done when exactly one conflicting correction commits and summaries have a single unambiguous current answer.

## C80. Store reading conditions and finding reactions per response

Priority P2. Work in feedback targets/entries, report interaction and questionnaire metadata.

Targets deduplicate by version/scope but store the first capture's `run_id`, `finding_ids` and note. These are session-specific context; later readers can inherit a report association they did not see. Conditions currently record place, duration, device and completeness, but omit prior exposure to model scores or group comments. Dedicated usefulness/defect-presence reactions are absent.

Keep reusable frozen text identity separate from each reading session. Store actual report/finding references, exposure declarations and optional reactions on that response. Verify the referenced finding belongs to the same source and compatible scope. Show other readers' distributions after submission in the ordinary independent-reading flow without claiming this proves blindness. Test two sessions using one target but different reports, prior exposure and a historical finding. Done when later analysis can distinguish unaided reading, report-assisted reading and evaluator feedback.

## C81. Provide a portable feedback export with identity controls

Priority P2. Work in export, target verification and export documentation.

The current JSON export contains reader display names and only paths/hashes for frozen prose. It is useful inside the original store but cannot reconstruct the evaluated text in a fresh workspace. A path to the current chapter is not sufficient after revision.

Keep the existing lightweight export if useful, and add a self-contained dataset option with frozen selected texts, questionnaire definitions, responses, revision/withdrawal selection and a manifest with counts and hashes. Use stable pseudonyms by default; named internal export must be explicit. Validate source bytes before producing the snapshot. Test importing or inspecting the export in a fresh directory with no access to the original store, including Romanian quotes and historical versions. Done when future analysis can reproduce the reading targets and preserve repeated-reader relationships without disclosing names by default.

## C82. Implement the requested comparison session

Priority P2. Work in comparison storage, API and reader UI. Depends on C77-C81.

The previous C54 asked for persisted A/B reading sessions, preference/tie/unable answers and presentation-order metadata. Current `feedback-comparison.mjs` only juxtaposes existing rating distributions and refuses small populations; it stores no comparison response. That feature is not an A/B reading session.

Implement an optional session over two immutable targets. Persist randomized display order across refresh, reader, question, exposure conditions, A/B/tie/unable preference and rationale. Allow the current team, even one member, to record a pilot response without claiming reliability. Keep ordinary descriptive distributions available with counts; a statistical restriction must not prevent data collection. Test reversed display order, ties, historical targets and refresh. Done when the application can accumulate actual comparative observations for future calibration.

## C83. Make the report useful before presenting its numbers

Priority P2. Work in report assembly and `public/ui/render/bundle.js` plus the five views. Depends on C61-C66 and C74-C75.

Lead the generic review with observed strengths, the most consequential supported problems, exact passages and bounded revision options. Show how an observation relates to the book's intention. Keep all metric details accessible, including unavailable reasons, coverage, bounds, component provenance and the declared aggregate arithmetic. The default bundle currently omits some diagnostic detail fields, so an NQS number does not expose its weights or calibration qualification there.

Do not equate an empty findings list with a clean bill of literary health when the evaluator made no observations. Distinguish not evaluated, insufficient evidence and no supported issue found. Preserve different possible readings and strengths through revision selection. Test rendering a partial review, an unavailable component with retained diagnostic data, a qualified NQS and a contradictory interpretation. Done when the report gives the author actionable evidence rather than a list of unexplained grades.

## C84. Replace successful-envelope checks with boundary regressions

Priority P1. Depends on each corrected path. Extend the existing check groups and skill tests.

Reproduce this review using `buildReportFixture` and `runReport` from the metrics tests, and isolated copies of the host with `scripts/check-fixtures.mjs`. Assert actual metric statuses, values, evidence scope, process outcomes and population counts. Include the exact EAP shape requested by the prompt, unavailable/error NQS inputs, out-of-scope evidence, incomplete continuity totals, independent exact-copy references, mode/model changes, nonzero evaluator exit, cancellation during annotation and simultaneous feedback corrections.

Add a real HTTP and browser smoke covering selected-chapter review, report details, historical feedback and export. Keep paid model calls out of `npm run check`. Add a separate bounded semantic regression command over the original ro/en cases, recording disagreements, false positives on justified exceptions, coverage, model/prompt versions and cost. No human recruitment is required, and fake responses do not count as semantic validation. Done when the regressions fail before their fixes and pass after them, with an explicit account of any unperformed model/browser checks.

## C85. Correct documentation and completion claims

Priority P2. Apply with the affected code changes, then verify the whole documentation flow.

Describe actual rubric inputs, supported metric availability, scope, lifecycle, feedback populations, export modes and comparison sessions in their owning contracts/specifications/HTML pages. Update DS003 only under its mandatory behavior re-derivation. The root catalog currently says six product skills while listing seven, including `scripta-import`; fix the count and associated ownership descriptions without removing import behavior. Reconcile DS001's outdated check/layout description as well.

Regenerate the specification matrix when specification metadata changes. Keep unavailable CR/AEG and optional human research honest. A green check suite or a real-model run producing seven files does not establish literary correctness. Done when documentation makes no stronger claim than the tested behavior, and only unfinished work remains here.

## C86. Bound whole-book evaluation and report partial reading honestly

Priority P2. Depends on C63-C65, C69 and C75. Work in host evaluation planning and per-scope provenance.

The generic host currently makes one request to read every chapter in the packet and imposes fixed output item limits, without an input-budget plan or a record of which portions were actually assessed. Whole-book review therefore does not scale just because its output says `book`.

Plan bounded chapter/scene units with explicit surrounding context, retain per-unit findings and assemble book/arc conclusions through a separate synthesis over those verified observations. Preserve cross-chapter relationships and unresolved gaps; do not average chapter grades into a literary verdict. Record attempted, completed, omitted and failed units, resume completed work after interruption and expose budget limits before invocation. Test a book exceeding the unit budget with a late-chapter defect and an interrupted middle unit. Done when a partial reading is visibly partial and a complete-book claim has complete declared coverage.
