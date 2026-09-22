# Universe files — exact schema

Every file lives in the current universe folder (the working directory).

## `canon.md`

Markdown with fixed sections. Every fact is one short, verifiable line in the present tense.

```markdown
# Canon — <Book title>

## Fundamental laws
- The metaphysical law of the universe (copied from `universe.json` → `law`), line by line.
- Consequences of the law already established (what follows from it, what is impossible in this world).

## World
- One concrete, stable fact per new line.

## Recurring characters
- **Name** — who they are, what they want, what they lived through in earlier episodes, current state.

## Timeline
- <year/relative epoch> — canonical event (including any time jumps used).

## Stable facts
- Facts that do not change without an explicit causal reason.

## Mysteries with a fixed cause
- Mystery — the real cause (fixed before any hints were handed out) — hints given so far.
```

Rules: never delete old facts; add. If an episode contradicts canon, create an explicit fork or explain the
change causally, in the text and in canon. The `## Fundamental laws` section is mandatory when the universe
has a `law`: it is the metaphysical contract of the book.

## `threads.json`

```json
{
  "open": [
    {
      "id": "thread-0007",
      "kind": "promise",
      "question": "What will the colony ask for in exchange for the water?",
      "created_chapter": 3,
      "due_chapter": 6,
      "status": "open"
    }
  ],
  "closed": [
    {
      "id": "thread-0004",
      "kind": "mystery",
      "question": "Who was lighting the lamps?",
      "created_chapter": 2,
      "closed_chapter": 4,
      "resolution": "The answer given in episode 4, in one sentence."
    }
  ],
  "promises": [
    {
      "id": "prom-0009",
      "to": "Name",
      "promise": "ALA promised not to modify minds without confirmation.",
      "created_chapter": 5,
      "due_chapter": 8,
      "status": "open"
    }
  ],
  "deferred_answers": [
    {
      "id": "def-0002",
      "question": "Why did the answers from the future stop?",
      "reason": "The revelation carries the main thread; answering now would defuse episode 7.",
      "asked_chapter": 5,
      "due_chapter": 7,
      "status": "deferred"
    }
  ]
}
```

`kind` ∈ `promise` | `mystery` | `decision` | `question`.
`status` ∈ `open` | `deferred` | `closed` | `abandoned`.
At most one new entry in `deferred_answers` per episode, with `due_chapter` > the chapter that asks it and
≤ current chapter + 3. An identifier is `<prefix>-NNNN` and unique across all four lists; `kind` and `status`
come from the sets above; `created_chapter`, `asked_chapter` and `closed_chapter` reference accepted chapters
(never a later one), while `due_chapter` may point forward.
Every episode: move what has been paid into `closed` and honour entries whose due date has arrived.

## `atlas.json`

```json
{
  "version": 1,
  "axes": [
    {
      "id": "mind-identity",
      "name": "Mind & identity",
      "nodes": [
        {
          "id": "editable-memory",
          "label": "Editable memory",
          "state": "dramatized",
          "chapters": [3, 4]
        }
      ]
    }
  ]
}
```

`state` ∈ `mentioned` (0.25) | `dramatized` (0.60) | `decision` (1.00) | `recontextualized` (1.00 + depth).
A concept that is merely named scores at most `mentioned`. Do not inflate the score by listing concepts.
Available axes: `mind-identity`, `life-death`, `time-causality`, `ai-autonomy`, `civilization-power`,
`abundance-scarcity`, `alien-alterity`, `reality-simulation`, `body-evolution`, `knowledge-truth`,
`cosmos-scale`, `culture-meaning`.
You may add new nodes with new `id`s; never rename existing nodes.

## `chapters/NNNN-slug.md`

```markdown
# Chapter title

Narrative text. Short paragraphs.

> A short quote, if it earns its place.

---

New scene.
```

`NNNN` = four digits, `slug` = lowercase letters, digits, hyphens (`[a-z0-9-]`).

## `chapters/NNNN-offer.json` — ALA's voice after the chapter

Written by the agent right after the chapter: ALA speaks directly to the reader (a conclusion that leaves a
question) and proposes **concrete decisions** specific to this episode, in the fiction language.

```json
{
  "teaser": "Two or three sentences in which ALA closes the episode, highlights what changed and makes the reader curious.",
  "options": [
    { "label": "Follow the registry", "prompt": "Continue the story: show what the registry does when it discovers the first living author." },
    { "label": "Jump 10 years", "prompt": "Let ten years pass and show what became of the living author." }
  ]
}
```

Rules: 2–3 options (a fourth is refused); `teaser` of 2–3 sentences, where a single short sentence is
refused; `label` short — at most 6 words, 7 or 8 are tolerated with a warning and more is refused;
`prompt` = the exact request that can be sent as it is; at least one option follows the main open thread.
The file is required: a chapter without a usable offer is refused by the validator, so the turn fails with
`INVALID_CHAPTER`. A chapter written before this rule still renders, with the interface showing a
continuation idea derived from the threads instead of the missing offer.

## `drafts/NNNN-plan.md`

The episode plan, with exactly the keys described in `SKILL.md` ("Episode plan" section). It is non-canonical:
no fact enters canon without appearing in the chapter. Every key carries a real value and appears once; the
validator refuses an empty or placeholder value, a repeated key and a plan that does not declare four to six
beats. `return_hook` is the only key that may say there is none.

## `exports/edition.json` (written only when a printed edition is prepared)

```json
{
  "title": "Book title",
  "subtitle": "Short subtitle",
  "author": "scriptaWorlds · ALA",
  "year": 2026,
  "dedication": "One line, optional.",
  "preface": "## Preface\n\n300–600 words…",
  "afterword": "## Afterword\n\n150–400 words…"
}
```
