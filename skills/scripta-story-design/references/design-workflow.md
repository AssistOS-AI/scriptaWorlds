# Design workflow and proposed artifacts

Prepared from `private/guide.docx`, especially G1052 through G1469 and G1472 through G1483. Source SHA-256: `8ee4ad1ceca60b68b1d56c5a66600b11ea61aaf166571313f3ba52ba8d2ccb20`. Fields and paths here are implementation proposals, not the current universe contract.

## Before the first episode

1. Read the permanent law and reader request. Separate explicit constraints from assumptions that the author is free to explore.
2. Write a short central premise and thematic question. State what the reader should experience and what remains uncertain.
3. Choose the first focal character and the people whose wants complicate that character's immediate task. Give each a private pressure and a different way of resisting.
4. Sketch the initial arc as a direction with possible turns. Include the cost of failure and at least one possible change in a relationship. Do not mandate a fixed number of acts or turning points.
5. Identify likely reader interventions and which parts of the plan they can alter. Permanent laws remain outside that freedom unless the human changes them.
6. Write the brief to `proposal/story-design.json` in the run directory. Hand nothing to ALA yet: the proposal becomes usable only when a human approves concrete directions in `approval.json`, and the host then passes exactly those accepted directions as input data of a later chapter request. Leave unused possibilities in the design file rather than loading them all into each prompt, and never ask the writing turn to read this skill or its references.

The proposal records the accepted version it was written against (`based_on_version`, the §8.2 identity). If the book changes so that this is no longer the accepted version, the proposal is **stale**: it is reported as stale rather than applied, and a direction that was declined stays declined instead of being proposed again. A design phase writes only inside its own run directory, never into `universes/` and never into the frozen `input/` packet.

## At the next chapter or arc

Compare the last accepted change with the blueprint. Choose a chapter purpose such as discovery, pursuit, aftermath, intimacy, confrontation or pause. The list is illustrative. State the experience or relationship change the chapter should make possible and what the reader's request changes.

Review the recent chapters for repeated dramatic machinery. The same location or image is not itself a defect. Repeating the same confrontation, explanation and settlement without changing knowledge, stakes or a relationship is a stronger reason to redesign.

At arc completion, record what the accepted prose actually resolved, what remains open and what promise the next arc carries. An explicit accepted `arc_completed` event later triggers a report. An unfinished or abandoned design does not trigger one.

## Proposed design artifact

`proposal/story-design.json`, inside the external assessment workspace (`docs/contracts.md` §8), has `schema_version`, `design_id`, `based_on_version`, `language`, `central_idea`, `premise`, `thematic_question`, `reader_promise`, `structural_intent`, `character_directions`, `relationship_directions`, `world_assumptions`, `arcs` and `open_design_questions`. Narrative strings use the universe language; schema keys use English.

Each arc has an ID, intended pressure, possible destinations, chapter memberships if already known, reader decision points and a planning status. Accepted completion belongs to the host's narrative memory, not merely to an agent setting a status in this draft. A planned ending can be replaced without rewriting history. A `completed` status inside a design brief is therefore an intention, and the validator warns about it for that reason: an arc with no accepted members cannot stand as an accepted event, and only accepted prose establishes that it completed. Chapter memberships follow the story chronology; the order in which the prose discloses them is a separate decision, and a deliberate non-linear disclosure is not a continuity error.

Character directions refer to stable entity IDs. They distinguish desired future development from observed attributes. Relationship directions identify who wants what to change, without overwriting the accepted relationship. World assumptions carry their epistemic kind and sources where established.

Keep required fields small. Empty optional fields are preferable to invented certainty. A new book may have no complete arc outline. An existing book may have no reliable origin for a canon entry; mark that gap and retrieve the earlier prose before accepting a continuation that depends on it.

## Context and memory handoff

The accepted memory view should return current facts, superseded conditions, relevant dated events, current character knowledge and open commitments. Include the original evidence when a new action depends on a disputed fact. A summary cannot overrule its source chapter.

Set a configurable context budget and record what was omitted. Prioritize the reader request, permanent rules, active relationships and the facts needed for this scene. Avoid sending every past explanation of the same law. A chapter about a valve needs its last known setting more than a full catalogue of institutional debates.

## Editorial acceptance questions

- Does the brief identify a human pressure that can be dramatized?
- Does it leave room for ordinary life beyond explaining the world law?
- Is a planned surprise compatible with established evidence?
- Can the next reader decision alter a consequential route?
- Does the chosen form suit this book, including deliberate ambiguity or stability?

These questions guide revision. The future schema validator checks structure, IDs and references; it does not certify the answers as good literature.
