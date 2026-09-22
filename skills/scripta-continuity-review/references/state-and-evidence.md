# State and evidence

Prepared from `private/guide.docx`, G1145 through G1469 and G2307 through G2328, and `private/metricx.docx`, M0085 through M0086 and M0116 through M0117. Guide SHA-256: `8ee4ad1ceca60b68b1d56c5a66600b11ea61aaf166571313f3ba52ba8d2ccb20`. Metrics SHA-256: `89789a269b0af16b56fb106bab946f8e7586d030844218d39facb10131a5d9a7`. The storage and evidence protocol below is a project proposal.

## Evidence classes

| Kind | Example | Treatment |
| --- | --- | --- |
| Permanent rule | The universe's stated physical constraint | Controlled by the charter/metadata ownership contract |
| Established observation | A valve was opened fully in chapter 1 | Valid for the observed time until a supported change |
| Current condition | The valve is now closed after repair | Derived from the latest supported event |
| Character belief | A crew member thinks the plant hears names | Belongs to that character's knowledge and uncertainty |
| Social rule | The crew votes that names must be recorded | An institutional fact, not automatically a physical mechanism |
| Hypothesis | Water shortage might explain the demand | Remains unresolved until the prose establishes more |
| Plan | A future chapter will reveal a cause | Never evidence that the event occurred |

Accepted prose, canonical summaries and permanent rules can disagree. Record that disagreement explicitly. Do not silently repair it by promoting a convenient summary, ignoring the charter or inventing a missing scene.

## Proposed accepted memory

The host-owned `narrative/` view records schema version, accepted source version, source hashes and last accepted chapter. Fact entries carry IDs, subject, predicate, value, epistemic kind, temporal scope, provenance and optional supersession. Events carry ordering constraints even when precise dates are unknown. Character knowledge records who knows or believes a fact and when they learned it.

Relationships record participants, direction, the relevant obligation or attitude, last change and its evidence. Attribute changes record a baseline and a cause when the text supplies one. Preserve uncertainty rather than inserting a false exact date, emotion score or universal trait.

An agent submits proposed changes under `drafts/`; the host validates the combined prose and state candidate before publishing accepted memory. The view can be rebuilt from accepted sources. Rewrites invalidate dependent records. Legacy canon entries without recoverable evidence remain labelled as such until reconciled.

## Evidence reference contract

Each evidence item has an ID, relative source path, SHA-256, zero-based half-open UTF-8 byte range, exact quote and chapter/segment IDs. Semantic claims can cite several items. The host verifies ranges and quote bytes against the frozen source. Offsets refer to original Markdown bytes, even if the evaluator read a normalized view. Both offsets must sit on a code-point boundary: a window that would end inside a multi-byte character is shortened rather than allowed to split it, and a claimed quote that is not found at the declared bytes refuses the whole annotations file instead of being reported as a finding.

Do not cite the authoring plan as proof that a payoff occurred. Cite the earlier promise and the later action that fulfils it. Do not cite the generated report itself as evidence for another report. Repeated mentions of one underlying event are not independent confirmations: symptoms of one defect are linked by a shared comparison id, so they add one penalty rather than several.

## The comparison ledger

Reviewed comparisons are kept apart from the defect list. Each record names its subject, its kind, the baseline evidence, the later evidence, the temporal scope between them and one outcome: `supported`, `contradicted` or `unresolved`. A character-change record additionally names the attribute that changed and the catalyst the text supplies. A resolved verdict without paired evidence and a temporal scope is preserved as declared and reported as unresolved, so it enters neither the contradicted nor the consistent count. Counts, coverage and the derived indices are computed from these records and never taken from a supplied total.

## Integrity findings

A reference to an unaccepted future chapter, duplicate active chapter number, stale memory hash, malformed state container or impossible evidence range is a deterministic integrity issue. Stop dependent measurements or mark them unavailable. A textual-only assessment can still run when explicitly requested, but it must disclose the missing continuity context.

The existing book has apparent chapter 10 state without an accepted chapter 10. Its origin is not established by the available records. The future migration must report the discrepancy and preserve the original files. It must not infer that the export caused it or fabricate a chapter to satisfy references.
