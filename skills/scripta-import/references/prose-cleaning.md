# Cleaning the book's prose, and never rewriting it

The extraction is a transcription, not a book page. It carries what a machine read: running heads, page numbers, footnote markers, hyphenated line breaks, hard wraps at the end of every line, and the occasional artefact of a page boundary. Turning that into a readable chapter file means removing the transcription and keeping every word the author wrote.

The rule is one sentence: **cleaning may remove what a page has and may not add, change or reorder what an author wrote.** When you hesitate, keep the book's words.

## What cleaning may do

| Operation | Example | Why it is allowed |
| --- | --- | --- |
| Drop running heads and feet | a line `24   THE ASH ARCHIVE` at the top of every page | they are the page's, not the prose's |
| Drop page numbers | `— 214 —`, a lone number between paragraphs | the same |
| Drop scanner artefacts | a line of `~~~~`, a lone `|`, an isolated asterisk | the same |
| Join a word broken across lines | `under-\nstanding` becomes `understanding` | typographic, not verbal |
| Unwrap hard-wrapped lines | lines joined into their paragraph | the paragraph, not the line, is the unit of prose |
| Normalize whitespace | runs of spaces become one, tabs become spaces | invisible in reading |
| Normalize quotation marks and dashes | `“`/`”` used consistently, `--` becomes `—` | typographic; do it only when the extraction is obviously inconsistent |
| Mark a scene break | `* * *` or `---` on its own line, in place of a break the page shows | a structure the renderers accept |
| Keep `#` and `##` headings the book itself has | a section title inside a chapter | the book's own structure, in the accepted Markdown subset |
| Keep `> ` quotes | an epigraph, a letter, a quoted document | the book's own text |

Paragraphs are separated by one blank line. A quote is one line starting with `> `; a scene break is one line with `---`. The accepted subset of Markdown is exactly what the print renderer and the reader use: `#` and `##` headings, paragraphs, `> ` quotes, `---` separators, `**bold**` and `*italic*`. Tables, images, code blocks, HTML, links, footnotes and lists are refused by the chapter validator; convert nothing into them.

## What cleaning may never do

- **No new words, sentences or paragraphs.** Not an opening sentence, not a transition, not a note that says what happens next, not a summary at the end, not a caption.
- **No translation.** The prose stays in the book's language, even when `universe.json` says something else (`references/state-files.md` covers what to do about the metadata).
- **No shortening.** Do not condense a dialogue line, drop an aside, or "tidy" a repeated phrase: repetition is the author's. Removing a *duplicated block* that the extraction produced is allowed only when the two copies are identical byte for byte and one is plainly a page-boundary artefact; when in doubt, keep both and report nothing.
- **No extending.** Do not complete a truncated sentence, do not fill a gap the scan left, do not guess a missing word. Report the truncation in the turn report instead.
- **No modernizing.** Keep the spelling, the punctuation and the register of the book.
- **No meta text of your own.** No `Translated by`, no `[page 12]`, no `(...)` note, no italic aside.
- **No reordering.** The order of sentences, paragraphs and scenes is the book's.
- **No chapter titles you invented.** A title comes from the source, or from the short label of the book's language (`Capitolul N` / `Chapter N`).

## The chapter file

```
# The Ash Archive

First paragraph of the book's prose.

> An epigraph the page carries.

---

The prose continues after the scene break.
```

- The first non-empty line is the title: `# Title`. The chapter validator and both renderers refuse a file without it.
- Then prose, paragraphs separated by one blank line. No front matter, no heading that repeats the title, no commentary.
- The file is UTF-8, with the book's own diacritics intact. Never transliterate a title's letters inside the prose; transliteration belongs to file names only.
- An extraction chapter whose text carries no words at all is not written as a chapter file; it is recorded in `skipped` with its reason.

## Why the validator can tell

Two cheap measures run over every imported chapter, and both are documented in `references/validator-contract.md`:

- **the word band** — the chapter's word count must sit inside 0.8× to 1.2× of its extraction chapter (plus an absolute slack of 20 words), so a chapter that was cut short or padded is caught even when every kept word is genuine;
- **the prose overlap** — at least 85% of the chapter's eight-word runs must occur in its extraction chapter, and at least 85% of that chapter's runs must occur in the chapter. Cleaning removes and rejoins material, and every removal breaks the runs that straddled it, which is why the bound is below one; prose you wrote rather than copied scores near zero, because a chapter that shares its sentences with no page of the book is not the book's.

That is why a faithful cleaning passes and a rewrite fails, without a model ever reading either.
