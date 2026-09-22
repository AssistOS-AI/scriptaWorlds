# Source map

This map supports the planning material prepared on 2026-09-22. The material paraphrases selected definitions and adapts them to scriptaWorlds. It does not validate the documents' academic references or reproduce their figures.

`private/guide.docx` SHA-256: `8ee4ad1ceca60b68b1d56c5a66600b11ea61aaf166571313f3ba52ba8d2ccb20`.

`private/metricx.docx` SHA-256: `89789a269b0af16b56fb106bab946f8e7586d030844218d39facb10131a5d9a7`.

G and M identifiers count every `w:p` element in the main `word/document.xml`, in document order, starting at one and including empty paragraphs and table cells. They are stable only for the hashes above. Extract text from `w:t` and `m:t`, decode XML entities and preserve paragraph boundaries. Do not count only visible paragraphs or use cached table-of-contents pages as verified page references.

| Source paragraphs | Topic | Prepared destination |
| --- | --- | --- |
| G0064 through G0148 | Introduction and central idea | Story-design concepts and workflow |
| G0149 through G0352 | Theme | Thematic question and meaning through choices |
| G0353 through G0488 | Genre systems and wisdom | Reader promise and provisional insight |
| G0489 through G1051 | Hierarchy, structure, plot devices, narrative models, architecture and counter-models | Distinctions between meaning, organization and operational plans |
| G1052 through G1144 | Blueprint | Flexible arc and chapter planning |
| G1145 through G1361 | Characters and relationships | Character pressures, knowledge and relationship changes |
| G1362 through G1469 | Worldbuilding, headed "Wordbuilding" in the source | World facts, institutions and consequences |
| G1470 through G1530 | Workflow, perspective and block system | Prose-craft overview |
| G1531 through G1646 | Scene, sequence and chapter | Structural units and overlapping membership |
| G1647 through G1754 | Action, conflict and event | Content labels |
| G1755 through G2041 | Description, dialogue, narration and interior monologue | Expression and differentiated voice |
| G2042 through G2299 | Rhythm, suspense, cliffhanger, pause, acceleration and alternation | Purposeful pacing |
| G2300 through G2392 | Frequent errors, coherence and originality | Revision and evidence questions |
| M0001 through M0047 | Literary quality and indicator categories | Eight-indicator literary rubric |
| M0050 through M0077 | Evaluation layer and metric inventory | Measurement architecture and registry |
| M0078 through M0109 | Metric definitions | Twelve-metric catalog |
| M0114 through M0123 | Dependencies and narrative scales | Aggregation, coverage and limitations |
| M0124 through M0139 | System reports | Five views of one assessment |

The guide's source spelling "Scena" is normalized to "scene" in the prepared English material. The metrics source names STG constraints without supplying an implementable rule list. VAD and BCI appear only as additional labels in M0120. They are not added as defined metrics.

The prepared files contain project decisions where the sources leave implementation open. In particular, byte-offset evidence, missing-value statuses, folder ownership, lexical formulas, calibration procedures and review scheduling are proposals. The user explicitly selected reports on request and at arc completion, with advisory literary scores.

Raw source files are not required at runtime. If a later implementation cites an external publication or adopts a dataset mentioned by the documents, verify the primary source, availability and license at that point. Do not inherit unsupported scientific or legal claims from this planning source.
