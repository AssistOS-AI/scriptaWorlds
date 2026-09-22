# Finding the chapters of a book that arrives without boundaries

A universe is a sequence of chapters. A book that came with its own chapters keeps them, one to one. A book that came as one block of prose — a single stream of paragraphs, a scan the host could not split, a novel published without chapter headings — has to be cut before it can be a book again. The host says which case you are in: when it could not detect boundaries it delivers one large chapter and a warning that says so.

Cutting is the one place where the import makes a structural decision of its own, so it is declared in the record (`segmentation`) and it is always done at a boundary the text itself already has.

## Which method to use

Try them in this order and stop at the first that applies. Record `host` when you cut nothing.

| `segmentation` | When | What a boundary is |
| --- | --- | --- |
| `host` | The host delivered several chapters | Nothing to do: keep them one to one |
| `scene` | One chapter, but the prose marks its own scene breaks | A scene break, grouped into chapters where the scene changes |
| `word_count` | One chapter, no headings and no scene marks | A paragraph boundary at about 2,000 words |

`word_count` is an approximation you declare, never a discovery. When a book has a mixture — some headings, some unmarked stretches — use the method of the *least* structured cut you had to make: `word_count` if you ever cut by words, otherwise `scene`.

## Boundaries by heading

A heading is a line that stands alone and names rather than tells. It is a heading when all of these hold: the line is short (fewer than a hundred characters); it has no final sentence punctuation; it is not a paragraph of dialogue; and it looks like one of the shapes a book uses for headings — `Chapter 7`, `CHAPTER VII`, `Capitolul 5`, `Capítulo 5`, `Part Two`, `PART TWO`, `Book One`, a bare number (`7`, `VII`), or a short line of capitals. A blank line usually stands before and after it.

- A heading starts a new chapter, and the heading line becomes the chapter's title.
- A part heading (`Part Two`, `PART TWO`) is not a chapter of its own when it has no prose of its own: it is the title of the run that follows. Record it in `skipped` when the extraction delivered it as its own entry with no prose, or make it the title of the first chapter it introduces.
- A line that is a running head (`24   THE ASH ARCHIVE`) is not a heading; it is page furniture and is removed (`references/prose-cleaning.md`).
- A table of contents is not prose: when the extraction delivered it as a chapter of its own, and it carries words, import it as the book has it rather than deciding that the book's own front matter may be dropped. The import copies the book; it does not edit it.

## Boundaries by scene

When there are no headings, the prose itself usually shows where scenes change:

- a mark line: `* * *`, `***`, `---`, `___`, `···`, or a single `#`;
- a blank line followed by an indented first line or a capitalised opening in a text whose paragraphs are otherwise flush;
- a change of place, of day or of point of view between two paragraphs, with a blank line between them.

A scene break is a cut candidate, not automatically a chapter. Group consecutive scenes into a chapter of roughly 1,500 to 2,500 words, and cut at the break closest to 2,000 words: a chapter of a book is not one scene, and a book of four thousand scenes is not four thousand chapters. Never cut inside a scene.

## Boundaries by word count

When neither headings nor scene breaks exist, cut at paragraph boundaries only:

1. Walk the paragraphs, counting words.
2. At the first paragraph boundary at or after 1,500 words, remember the candidate.
3. Continue to the paragraph boundary closest to 2,000 words; if the paragraphs are long, stop at the first boundary after 2,500 words — never cut inside a paragraph.
4. Repeat from the next paragraph. The last segment of the source chapter keeps whatever remains, however short.

The result is a run of chapters inside the band a written episode lives in (900 to 2,400 words by default), which is what makes an imported chapter behave like a written one.

## What cutting must not do

- Never merge two of the book's own chapters because both are short.
- Never split a scene to hit a word count, and never cut inside a paragraph.
- Never reorder, and never leave a gap: the cut pieces of one source chapter run consecutively and are the only chapters that share a `source_chapter` value.
- Never add a heading line the book does not have to make a cut look tidy.
- Never rename a scene, a part or a chapter.

## Numbering, titles and file names

- The universe chapter number is the four-digit `NNNN` of `chapters/NNNN-slug.md`, running from the import's `start_chapter` with no hole.
- The title is the source's own heading text. When the extraction gives none — a book published without titles, a segment you cut yourself — use the short label of the book's language and the segment number: `Capitolul 7` in Romanian, `Chapter 7` in every other language. Never invent a literary title.
- The slug is lowercase letters, digits and hyphens, derived from the title with the diacritics transliterated (`ș→s`, `ț→t`, `ă→a`, `â→a`, `î→i`), so `Capitolul 7` gives `chapters/0007-capitolul-7.md` and `The Blind Librarian` gives `chapters/0002-the-blind-librarian.md`.
- A chapter the source itself numbers (`Chapter 7`) keeps the source's number in its *title*, not in the universe's numbering: the universe's `NNNN` is the position in the imported sequence.

## What the record says about the cut

Every cut chapter occupies one entry in `chapters[]`, in order, with `source_chapter` naming the extraction chapter it came from and `segment` its 1-based position inside it, so a later reader can reconstruct exactly how the book was divided:

```jsonc
{ "chapter": 4, "source_chapter": 3, "segment": 1, "file": "chapters/0004-the-ash-archive.md", "title": "The Ash Archive" },
{ "chapter": 5, "source_chapter": 3, "segment": 2, "file": "chapters/0005-the-ash-archive-2.md", "title": "The Ash Archive (2)" },
```

A chapter kept whole says `"segment": null`. The segments of one source chapter are `1..k` with no hole, and the validator refuses anything else. When you cut by word count, every non-final segment must land inside 1,500–2,500 words; a segment outside that band is reported as `SEGMENT_OFF_BAND`, a warning that says the cut is not the one the guide describes.
