---
name: scripta-import
description: Import an uploaded book into a scriptaWorlds universe: read the host's extraction, bring in a bounded range of chapters per turn, carry the book's own prose into chapters/, derive canon.md, threads.json and atlas.json from it, record drafts/import-progress.json, then run validate-import.mjs. Use it when the host turns an uploaded book into a universe instead of writing one.
---

# scripta-import — an uploaded book becomes a universe

You are importing a book somebody already wrote. The universe you write into must end up
indistinguishable, in structure, from one written chapter by chapter: the same `chapters/NNNN-slug.md`
files with `# Title` on the first line, the same `canon.md`, `threads.json` and `atlas.json`, the
same possibility of being read, reviewed, continued, rewritten and printed afterwards.

What is different is that you invent nothing. The prose is the book's, copied and cleaned; the state
files describe that prose. You are the archivist, not the author.

## What you read

1. `universe.json` — the universe the host created: `title`, `language`, `law`, `status`. Read it,
   never write it (`docs/contracts.md` §2.2).
2. `charter.md` when it exists — the permanent rules of this universe.
3. `.agents/import/extracted.json` — the host's extraction of the uploaded file. This is your only
   source of prose; the format is fixed and documented in `references/extraction-format.md`.
4. `.agents/import/book.md` — the same prose as plain text, for reading comfortably. Never a source
   of different words; when the two disagree, the JSON wins.
5. `drafts/import-progress.json` — the import record, when a previous turn wrote one: it says which
   extraction chapters are already imported and which one is next.
6. On a later turn, `canon.md`, `threads.json` and `atlas.json`, so you extend them instead of
   replacing them.

## One turn covers a bounded range (mandatory)

An import is a sequence of turns, and each turn covers a bounded range of the extraction:

- at most **3** extraction chapters and at most **6,000** words of their prose, whichever comes
  first;
- always at least one extraction chapter, even when that chapter alone is longer than 6,000 words —
  otherwise a book of long chapters could never be imported;
- extraction chapters in order, from the continuation pointer to the end of the window; never a
  chapter out of order and never a chapter twice.

The next turn starts at `next_source_chapter` of the record, or at the first chapter of the
extraction when there is no record yet. Chapters the extraction declares with no prose at all (a part
title, a blank page) are recorded in `skipped` with the reason, and are not written as chapters.

## Working order (mandatory)

1. **Load the extraction** and refuse the import if it is unusable (see below). Do not continue.
2. **Compute the window**: from the continuation pointer, take extraction chapters until the next one
   would pass the chapter bound or the word bound.
3. **Write the chapters** of the window to `chapters/NNNN-slug.md`, `NNNN` four digits. The first
   free number of the universe is the import's `start_chapter` on the first turn and is fixed in the
   record from then on; every later chapter follows it without a gap. See
   `references/prose-cleaning.md` for what cleaning may and may not do.
4. **Derive the state** and write `canon.md`, `threads.json`, `atlas.json` (`references/state-files.md`).
   On the first turn you create them; on later turns you extend them, moving what the new chapters
   pay into `closed` and adding what they open.
5. **Write the import record** `drafts/import-progress.json` — the machine-readable mark that this
   book was imported, and the only place a later turn learns where to continue
   (`references/turn-discipline.md`).
6. **Run the validator over your own range** and fix what it reports:
   `node .agents/skills/scripta-import/scripts/validate-import.mjs --universe . --import .agents/import/extracted.json --chapters N-M`
   where `N-M` is the *extraction* chapter range this turn covered — the same range you recorded in the
   turn journal. Run it again after every fix until `ok` is `true`.
7. **Report** in 3–6 English lines: the extraction chapters imported, the universe chapters written,
   what entered canon, which threads were opened and closed, the continuation pointer, and whether
   the import is complete.

## Faithfulness — the point of the whole skill

- The chapter text is the book's own words, in the book's own order, in the book's own language. You
  may remove page furniture, rejoin words broken across lines, normalize whitespace and mark scene
  breaks. You may not rewrite, translate, summarize, shorten, extend, reorder or explain, and you
  may not add a sentence of your own — no scene setting, no connective tissue, no footnote, no
  chapter summary, no note about the import.
- A chapter file carries a title on the first line and prose after it, and nothing else. The title is
  the source chapter's own title when the extraction gives one; when it does not, use the short label
  of the book's language (`Capitolul N`, `Chapter N` for any other language). Never invent a
  literary title.
- A chapter the extraction declares with prose is always imported. You may never drop a readable
  chapter in silence; the only chapters that may be passed over are the ones the extraction declares
  with no words, and each of them is named in `skipped` with its reason.
- The validator confirms this cheaply: the words of a chapter must stay inside a plausible band
  around its extraction chapter, and at least 85% of its eight-word runs must occur in that
  extraction chapter and vice versa. Prose you wrote rather than copied fails both.

## Segmenting a book with no boundaries

When the host could not detect chapter boundaries it delivers one large chapter and says so in
`extracted.warnings`. Segment it yourself, in this order of preference, and record which you used in
the record's `segmentation` (`references/segmentation.md` gives the full procedure):

1. **heading** — a line that is only a numbered or named heading (`Chapter 7`, `Capitolul 5`,
   `PART TWO`, a standalone number, a line of capitals shorter than a hundred characters) starts a
   new chapter; a heading that names a part becomes the title of the chapters that follow it.
2. **scene** — when the prose has scene breaks (a blank line around `* * *`, `---`, a rule of
   characters) and no headings, group the scenes into chapters, cutting where the scene changes.
3. **word count** — when neither exists, cut at a paragraph boundary at about 2,000 words: never
   before 1,500 and never after 2,500, so an imported chapter reads like a written one. The tail of
   the source chapter keeps whatever remains.

Say which one you used. A `word_count` segmentation is a declared approximation, not a discovery of
the book's own structure.

## The state files

`canon.md`, `threads.json` and `atlas.json` describe the prose you imported, in the schema a written
book uses, and they are the only reason the imported book can afterwards be analysed, continued or
rewritten like any other. Every line is traceable to the imported chapters and says so with `(ch. N)`.

- `canon.md` — the sections `## Fundamental laws`, `## World`, `## Recurring characters`,
  `## Timeline`, `## Stable facts`, `## Mysteries with a fixed cause`. The law comes from
  `universe.json`; the rest is what the imported chapters actually establish. A mystery whose cause
  the book has not given does not belong in `## Mysteries with a fixed cause` — it belongs in
  `threads.json` as an open `mystery`.
- `threads.json` — what the book leaves open at the frontier: promises made and not paid, mysteries
  not solved, decisions not taken, questions asked and not answered. Imported entries carry the
  chapter that shows them; when a later turn imports the chapter that pays one, move it to `closed`
  with a one-sentence `resolution` that names what the book itself did.
- `atlas.json` — the axes and nodes the imported chapters work, with the state the prose shows
  (`mentioned`, `dramatized`, `decision`, `recontextualized`) and the chapters that show it. Axes,
  node identifiers and labels are English schema vocabulary; the book's own words for an idea belong
  in `canon.md`.

Never invent: no fact the imported chapters do not show, no character who has not appeared, no date
the book does not give, no new axis, no node for an idea the book never touches, no thread for a
promise nobody made. When the prose does not settle something, leave it out or record it as an open
question — an honest gap is part of the book, an invented fact is a defect.

## Language

The prose is written in the book's language, always, whatever `universe.json` says. The state files
are written in the book's language too, because they describe the book; schema vocabulary (file
names, section names, JSON keys, thread kinds and statuses, atlas axes and states) stays English.

When `extracted.detected.language` differs from `universe.json.language`, you do not translate the
book and you do not touch `universe.json`: you import the prose as it is, write the state in the
book's language, and record the difference in `language` of the import record (`book`, `state`,
`universe`, `match`), so the operator can settle the metadata. When the extraction detects no
language, the universe's language is used for the state files and `language.book` is `null`. The
validator reports a mismatch as a warning, never as a refusal, and refuses a record whose own claim
contradicts it.

## When the extraction is unusable

Refuse the import, write nothing, and report in English what is missing and what the operator should
do. An unusable extraction is:

- **absent or empty** — no `.agents/import/extracted.json`, or a file with no content: report
  `NO_EXTRACTION` and stop. This is the case of a scan without a text layer: it has no words to
  import and none may be invented.
- **unreadable** — the file is not valid JSON, or its `schema_version` is not `book-import.v1`, or a
  chapter entry has no text, or the file holds no text at all.
- **unusable for the language** — the prose is in a script or a language you cannot copy faithfully
  (for example a text whose characters arrive as replacement marks): report it and stop rather than
  guessing.
- **already imported** — the record covers every extraction chapter (`complete: true`): there is
  nothing left to do; say so and stop.

The record is never repaired by guessing: a record that does not match the extraction you were given
(the same `import_id` and the same `source.sha256`) is refused with `INVALID_IMPORT`, not edited.

## Files you write, files you never write

Inside the universe folder an agent writes only `canon.md`, `threads.json`, `atlas.json`,
`chapters/*`, `drafts/*` and `exports/edition.json`. This skill writes `chapters/NNNN-slug.md`,
`canon.md`, `threads.json`, `atlas.json` and `drafts/import-progress.json`.

Never write `universe.json`, `charter.md`, `turns/*`, `.agents/*`, `universe-title.txt` or anything
under `exports/`; never translate, never run `git`, never touch another universe, and never read
`turns/`. No `drafts/NNNN-plan.md` and no `chapters/NNNN-offer.json` come out of an import: a plan is
how an episode is invented and an offer is ALA's voice about what could happen next, and an imported
chapter has neither. A chapter that is later continued or rewritten gets both from `scripta-ala`.

## Final self-check

- Every chapter of the window is on disk, numbered without a gap, with `# Title` on the first line.
- No sentence in a chapter file comes from anywhere but the extraction.
- The words stay inside the plausible band and the prose overlap holds.
- The record names the same `import_id` and `source.sha256` as the extraction, the chapters it
  lists, and the range and the turn that wrote them.
- `canon.md`, `threads.json` and `atlas.json` describe the imported chapters and cite them.
- `validate-import.mjs` says `ok: true` for this turn's range.
- If the extraction is unusable, nothing was written at all.

## Working material

- `references/extraction-format.md` — the fixed input contract of the extraction file, field by field.
- `references/turn-discipline.md` — the bound of one turn, the record schema, continuation, resume and repair.
- `references/segmentation.md` — finding boundaries by heading, by scene or by word count.
- `references/prose-cleaning.md` — what cleaning may do to the book's words, and what it may never do.
- `references/state-files.md` — deriving `canon.md`, `threads.json` and `atlas.json` from imported prose.
- `references/validator-contract.md` — the command, the envelope, the codes and what it can prove.
