# One import turn at a time

A book has hundreds of pages and a turn is bounded. The import is therefore a sequence of turns, and the only thing that lets the second turn continue where the first stopped is the import record this skill writes: `drafts/import-progress.json`. Nothing else survives a turn — not memory, not the conversation, not the agent process.

## The bound of one turn

| What | Value | Why |
| --- | --- | --- |
| Extraction chapters per turn | at most 3 | every chapter means one chapter file plus its share of the state update, and three keeps a turn reviewable in one pass |
| Words of their prose per turn | at most 6,000 | about two and a half long trade chapters; a written episode is 900–2,400 words, and a turn that copies prose may carry more than one that composes, but not unboundedly more |
| Extraction chapters per turn | at least 1 | a single chapter longer than 6,000 words is imported alone in its own turn, otherwise it could never be imported at all |

Whichever bound is reached first ends the window. A turn above the bound is a warning (`TURN_OVERSIZE`) rather than a refusal: the work is done and correct, the host only learns that the turns are getting large.

## The window

The pointer `next_source_chapter` of the record names the extraction chapter the next turn starts at; without a record, the first chapter of the extraction. From there the turn takes extraction chapters in order:

```
window = extraction chapters from next_source_chapter, in order,
         stopping before the first chapter that would pass 3 chapters or 6,000 words
```

The turn never skips forward, never takes a chapter twice and never reorders. `scripts/lib/turns.mjs` exports this as `planTurnWindow(chapters, fromSourceChapter, { maxChapters, maxWords })`, and the host plans the same window from `schema/import.v1.json` (`turn_limits`), so a window the host planned and a window this skill planned are the same window. The record is authoritative for the pointer: chapter files on disk do not carry the number of the extraction chapter they came from.

## What one turn writes

1. `chapters/NNNN-slug.md` — one file per extraction chapter of the window, numbered from the first free number of the universe (the import's `start_chapter`, fixed by the first turn). A source chapter cut into segments writes several files, in segment order.
2. `canon.md`, `threads.json`, `atlas.json` — created on the first turn, extended on every later one.
3. `drafts/import-progress.json` — the record, rewritten with the new chapters, the new turn entry and the advanced pointer.

Nothing else. In particular no `drafts/NNNN-plan.md`, no `chapters/NNNN-offer.json`, no `universe.json`, no `turns/` and nothing under `.agents/`.

## The record

```jsonc
{
  "schema_version": "book-import.v1",
  "import_id": "20260922T155732-ab12",       // copied from the extraction; proves which upload
  "source": { "filename": "book.pdf", "format": "pdf", "sha256": "…", "bytes": 123456, "pages": 210 },
  "detected": { "title": "…", "author": "… or null", "language": "ro or null" },
  "language": { "book": "ro", "state": "ro", "universe": "ro", "match": true },
  "segmentation": "host",                    // host | scene | word_count
  "start_chapter": 1,                        // the first universe chapter the import wrote, fixed forever
  "next_source_chapter": 3,                  // where the next turn continues; null when finished
  "complete": false,                         // true exactly when next_source_chapter is null
  "chapters": [
    { "chapter": 1, "source_chapter": 1, "segment": null, "file": "chapters/0001-the-ash-archive.md", "title": "The Ash Archive" },
    { "chapter": 2, "source_chapter": 2, "segment": null, "file": "chapters/0002-the-blind-librarian.md", "title": "The Blind Librarian" }
  ],
  "skipped": [],
  "turns": [
    { "number": 1, "from_source_chapter": 1, "to_source_chapter": 2, "chapters": [1, 2], "imported_at": "2026-09-22T16:30:00.000Z" }
  ],
  "updated_at": "2026-09-22T16:30:00.000Z"
}
```

The complete, validator-passing document is `schema/import-progress.v1.example.json`; the field vocabulary is `schema/import.v1.json`, and `scripts/validate-import.mjs` refuses a record whose claims do not hold together.

| Field | Rule |
| --- | --- |
| `import_id`, `source.sha256` | Must equal the extraction you were given. A record written for another upload is refused with `INVALID_IMPORT`; it is never repaired by guessing. |
| `language` | `book` is the detected language or `null`; `state` is the language the state files are written in (the book's, else the universe's); `universe` is what `universe.json` says; `match` is `true` when the book's language is unknown or equal to the universe's. |
| `segmentation` | `host` when the host's chapters were kept, `scene` or `word_count` when this skill cut a boundaryless book. Report the least structured method you actually used. |
| `start_chapter` | The first chapter the import wrote, fixed by the first turn even when a written book already occupied earlier numbers. |
| `next_source_chapter` | The continuation pointer, or `null` when every extraction chapter is imported or skipped. `complete` is `true` exactly when it is `null`. |
| `chapters[]` | One entry per written file, ascending by `chapter`, `chapter` numbers without a hole from `start_chapter`. `source_chapter` is the extraction chapter it came from; `segment` is `null` for a chapter kept whole and `1..k` for the k parts of a cut one; `file` and `title` must be the file and the title line that exist on disk. |
| `skipped[]` | Every extraction chapter the import has already passed without writing a chapter file, with the reason — for example `{ "source_chapter": 4, "reason": "the extraction declares no prose for it (a part title)" }` while the pointer stands at 5. Only a chapter the extraction declares with no prose may appear here, a skipped chapter never also appears in `chapters[]`, and a chapter behind the pointer is either imported or skipped, never neither. |
| `turns[]` | One entry per import turn: its number from 1, the range it covered, the universe chapters it wrote and when. The range is the **window the turn covered, including the chapters it passed over**: a turn that walked extraction chapters 1–2 and found chapter 2 to be a part title writes `{"from_source_chapter": 1, "to_source_chapter": 2, "chapters": [1]}`. The ranges follow one another without a hole, the concatenation of `chapters` is the `chapters[]` list in order, and every extraction chapter of a window is either written by that turn or recorded in `skipped`. |
| `updated_at` | When the record was last written. |

## How a later turn continues

1. Read the record. If `complete` is `true`, the import is finished: report it and stop.
2. Take `next_source_chapter`; compute the window under the bound above.
3. Import that window and rewrite the record: append the chapter entries, append the turn entry with its range, move the pointer to the extraction chapter after the window (or `null`), and set `complete` accordingly. Never rewrite earlier entries.

## Resume, repair and refusal

- **Interrupted turn.** If a turn dies half way, the record still points at the chapter it was importing. The next turn rewrites that chapter and finishes the window. Write the chapter files first and the record last, so a half-finished turn leaves the pointer where it was.
- **A record that does not match the extraction** (another `import_id` or `source.sha256`): refuse with `INVALID_IMPORT`, write nothing and report it. Do not merge two uploads.
- **A chapter you cannot copy faithfully** (replacement characters, a script you cannot reproduce): refuse that turn, do not write a partial chapter, and report which extraction chapter failed.
- **An extraction already fully imported** (`complete: true`): there is nothing to do. Say so; do not re-import a chapter that exists.

## Running the validator over your own turn

```sh
node .agents/skills/scripta-import/scripts/validate-import.mjs \
  --universe . --import .agents/import/extracted.json --chapters N-M
```

`--chapters N-M` is the range of extraction chapters this turn covered (for example `--chapters 4-6`), which is the range the turn journal of your own record carries. Without the flag the whole import is checked, which is what the host does when the import finishes. Fix every reported error and run it again until `ok` is `true`; `references/validator-contract.md` explains each code.
