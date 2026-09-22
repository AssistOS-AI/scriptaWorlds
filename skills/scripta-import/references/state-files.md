# The state files of an imported book

Chapters make a text; `canon.md`, `threads.json` and `atlas.json` make it a universe. Everything the product does afterwards — continuing the book, rewriting a chapter, reviewing continuity, measuring prose, printing an edition — reads those three files. An import that writes chapters without them produces a folder of text nobody can work with, and the validator refuses it.

The state files describe the imported prose, and only the imported prose. Their vocabulary — section names, JSON keys, thread kinds and statuses, atlas axes and node states — is English, as it is for a written book; the text inside them is written in the book's language, as the prose is.

## `canon.md`

Fixed sections, in this order, all of them present after every turn (the validator requires each heading, empty or not):

```markdown
# Canon — <Book title>

## Fundamental laws
- The universe law copied from `universe.json` → `law`.
- Consequences of it that the imported chapters already show.

## World
- One stable fact per line, in this form: The archive admits one reader at a time (ch. 1).

## Recurring characters
- **Name** — who they are, what they want, what the imported chapters show them doing (ch. 1, ch. 4).

## Timeline
- Year 12 — the first living author is registered (ch. 1).

## Stable facts
- Facts that do not change without a cause the book gives (ch. 2).

## Mysteries with a fixed cause
- The question — the cause the book has already given — the hints given so far (ch. 2–4).
```

Rules that make the canon of an import trustworthy:

- **Every line is traceable.** End it with the chapter number(s) the prose shows it in — `(ch. 7)`. A line without a chapter is a line nobody can check, and the reviewer of the imported book will treat the whole canon as decoration.
- **Only what the imported chapters establish.** Not what the book's own later chapters will establish, not what a summary says, not what you infer from the title, not what the genre implies.
- **One fact per line, short and verifiable.** "The registry never deletes an entry (ch. 2)" and not "The registry, which is old and bureaucratic, has complicated feelings about memory (ch. 2)".
- **Never delete an old line.** Extend the canon; when a later imported chapter contradicts an earlier line, replace that line and say in the new one what changed it (`(ch. 9, contradicting ch. 2)`).
- **`## Fundamental laws` always carries the law** from `universe.json` when the universe has one. The import never invents a metaphysics for a foreign book: the law belongs to the universe the host created.
- **`## Mysteries with a fixed cause` is only for a cause the book has already given.** A mystery whose answer the book has not reached yet is an open thread, not a canon entry.

## `threads.json`

What the book leaves open at the frontier of the import: promises made and not yet paid, mysteries opened and not yet solved, decisions the prose leaves to its characters, questions asked in the text and not yet answered.

```json
{
  "open": [
    { "id": "thread-0007", "kind": "mystery", "question": "Who lit the lamps before the keeper arrived?", "created_chapter": 3, "due_chapter": 6, "status": "open" }
  ],
  "closed": [
    { "id": "thread-0004", "kind": "promise", "question": "Will the catalogue be finished?", "created_chapter": 1, "closed_chapter": 3, "status": "closed", "resolution": "The keeper finishes the third volume in chapter 3." }
  ],
  "promises": [
    { "id": "prom-0009", "to": "The keeper", "promise": "The registry will be read aloud.", "created_chapter": 2, "due_chapter": 5, "status": "open" }
  ],
  "deferred_answers": [
    { "id": "def-0002", "question": "Why did the letters stop?", "reason": "The book has not reached it yet.", "asked_chapter": 2, "due_chapter": 4, "status": "deferred" }
  ]
}
```

- All four lists are always present, even when empty.
- `id` is `<prefix>-NNNN`, unique across the four lists; `kind` is `promise`, `mystery`, `decision` or `question`; `status` is `open`, `deferred`, `closed` or `abandoned`.
- `created_chapter` (or `asked_chapter`) is the universe chapter whose prose shows the thread. `closed_chapter` names the chapter of the book that pays it, `due_chapter` a chapter after the one that opened it. Both must name chapters that exist.
- The text (`question`, `promise`, `resolution`, `reason`) is written in the book's language and in the book's own terms; a resolution says what the book did, not what you would have done.
- **On every later turn, move what the new chapters paid into `closed`** with a one-sentence `resolution`, and add what they open. A thread that stays open for ever makes the imported book look unfinished; a thread closed without a chapter that closes it is a lie.
- Never invent a promise on the book's behalf. A thread that the prose does not show does not exist.

## `atlas.json`

Which ideas of the Periodic Table the imported chapters work, and how deeply the prose works them.

```json
{
  "version": 1,
  "axes": [
    {
      "id": "knowledge-truth",
      "name": "Knowledge & truth",
      "nodes": [
        { "id": "catalogue-of-the-dead", "label": "A catalogue of the dead", "state": "dramatized", "chapters": [1, 3] }
      ]
    }
  ]
}
```

- `axes` may only use the twelve published axis identifiers, with the published names: `mind-identity`, `life-death`, `time-causality`, `ai-autonomy`, `civilization-power`, `abundance-scarcity`, `alien-alterity`, `reality-simulation`, `body-evolution`, `knowledge-truth`, `cosmos-scale`, `culture-meaning`. An import never invents an axis.
- Node identifiers are English, lowercase, hyphenated (`editable-memory`), and the label is a short English phrase for the idea (`Editable memory`). The book's own words for the idea belong in `canon.md`; the atlas is the vocabulary the measurement and the table speak.
- `state` is what the prose does with the idea: `mentioned` when it is only named, `dramatized` when a scene depends on it, `decision` when a character's choice turns on it, `recontextualized` when the book changes what an earlier idea means.
- `chapters` lists the imported chapters that show the node, and never an empty list: a node with no chapter is a claim with no source.
- Never rename a node that already exists; add new ones. An idea that recurs in later imported chapters gets those chapter numbers appended.

## Incremental writing across turns

The state files are written once per turn and never rebuilt from scratch:

1. Read the current `canon.md`, `threads.json` and `atlas.json` (they may be empty on the first turn, and they must be created then).
2. Append the canon lines the new chapters establish, each with its `(ch. N)`.
3. Move the threads the new chapters pay into `closed` with their resolution, add the threads they open, and keep the pointers honest.
4. Extend the atlas: new nodes for new ideas, new chapter numbers for ideas the book returns to.
5. Leave everything that belongs to earlier chapters exactly as it is.

## What the validator checks in them

It checks the shape and the references, never the truth: the six canon sections exist and the law section carries the law; `threads.json` has its four lists, unique identifiers from the documented vocabulary, and chapter references that name chapters which exist; `atlas.json` has `version: 1`, published axes, unique English node identifiers, valid states, non-empty chapter lists, and at least one node that names a chapter of the imported range. Whether a fact is true of the book is a question for the extraction, a reader, or the review skills — not for this validator.
