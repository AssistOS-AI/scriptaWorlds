# Scripta Book Export Design Summary

## Introduction

`scripta-book-export` turns the Markdown chapters of a scriptaWorlds universe into a printable
edition (PDF and/or DOCX). It is the implementation of the renderer CLI contract in
`docs/contracts.md` §3: one command, five flags, one JSON line on stdout, exit codes 0/1/2, and no
npm dependencies — only Node.js built-ins. A second, read-only command (`scripts/verify-edition.mjs`)
is the acceptance step the server runs afterwards: it checks the produced files as documents and
against the edition record that binds them to the accepted version of §8.2.

The skill is invoked by the coding agent running inside a universe folder
(`node .agents/skills/scripta-book-export/scripts/build-book.mjs --universe . --format both`), so
every path is resolved from the universe folder and the outputs land in `exports/`.

## Module layout

`scripts/build-book.mjs` and `scripts/verify-edition.mjs` are only the command lines — argument
parsing, orchestration and the single JSON line each — and the engines live beside them in
`scripts/lib/` as native ES modules with relative `.mjs` imports and no npm dependency:

| Module | Responsibility |
| --- | --- |
| `lib/errors.mjs` | exit codes, `BookError`/`fail`, file readers, slug/date/XML/PDF-string helpers, byte helpers |
| `lib/truetype.mjs` | TrueType table directory, `cmap` formats 0/4/12, glyph access, composite closure, subsetting |
| `lib/fonts.mjs` | font discovery and ranking, `BookFace`, `resolveFonts` |
| `lib/markdown.mjs` | the accepted Markdown subset |
| `lib/book.mjs` | edition language and labels, chapter loading, the book model, the §8.2 identity over the role files |
| `lib/layout.mjs` | A5 pagination, block styles, TOC pass, title and dedication pages |
| `lib/pdf.mjs` | PDF writer (subsetted fonts, outline, document info, xref) |
| `lib/docx.mjs` | ZIP + OOXML writer |
| `lib/verify.mjs` | structural verification of a produced document (xref/trailer/page tree, ZIP/OOXML parts) |
| `lib/manifest.mjs` | the `edition-manifest.v1` record: build, serialize, read, validate |

## Core Content

**Inputs.** `universe.json` (title fallback, language), `chapters/NNNN-slug.md` sorted numerically by
the number in the file name, and `exports/edition.json` (title, subtitle, author, year, dedication,
preface, afterword — all optional except the title, plus an optional `language` that wins over
`universe.json`). Chapters are parsed with a minimal Markdown
parser limited to the accepted set in §2.3: `#`/`##` headings, blank-line separated paragraphs,
`> ` quotes, `---` scene separators, `**bold**` and `*italic*` runs. The chapter title (first `#`
line) is promoted to the section heading; front and back matter use their first heading, defaulting
to the localized labels (`Cuvânt înainte` / `Postfață` in Romanian, `Preface` / `Afterword` in
English). Only the edition's labels and metadata are localized — chapter, preface and afterword text
is printed verbatim in the language it was written in.

**Layout engine.** Both renderers share one pagination pass over A5 pages: word-level tokenisation
with real glyph advances from the chosen font, greedy line breaking with justification, paragraph,
quote, heading and scene-separator styles, widow/orphan control for headings and paragraph starts,
page breaks before every chapter, and a page index for every level-1 heading. The table of contents
is laid out from those page indexes and iterated with the body until the number of TOC pages is
stable, so the printed numbers are exact. The same numbers feed the DOCX TOC cache.

**PDF engine.** No library: the PDF is written directly (objects, xref table, trailer). Fonts are
subsetted from a system TrueType file — glyph closure over composite glyphs, reindexed `glyf`/`loca`,
rebuilt `hmtx`, `maxp`, `head`, `hhea`, a format 4 `cmap`, plus `post` 3.0, an empty `name` and the
original `OS/2`; hinting instructions are dropped and table checksums and `checkSumAdjustment` are
recomputed. Embedding uses a Type0/CIDFontType2 font with `Identity-H` (codes are subset glyph IDs)
and a `ToUnicode` CMap, so text is selectable and Romanian diacritics extract as
U+0103/U+00E2/U+00EE/U+0219/U+021B. The document ships a title page, optional dedication page, TOC
with dot leaders, footer page numbers (none on the title page), document info, and a flat outline
for level 1 and level 2 headings.

**DOCX engine.** No library: a minimal ZIP writer (`node:zlib` `deflateRawSync` + CRC32) plus valid
OOXML parts — `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, `word/styles.xml`,
`word/footer1.xml`, `word/_rels/document.xml.rels`, `docProps/core.xml`. Styles `Title`, `Heading1`,
`Heading2`, `Normal`, `Quote` and `TOC1` are declared; chapters start with a page break; the footer
carries a `PAGE` field (suppressed on the first page via `titlePg`); the TOC is a real
`TOC \o "1-1" \h \z \u` field whose cached result lists exactly the level-1 headings with the layout
engine's page numbers, so a manual field refresh produces the same entries.

**Font selection.** Families are searched in `/usr/share/fonts/liberation-serif-fonts`,
`/usr/share/fonts/truetype/liberation*`, `/usr/share/fonts/google-noto-vf/NotoSerif*`, then any serif
in `/usr/share/fonts` (or in `--fonts <folder>`, which replaces the search). A candidate family is
laid out once, and it is accepted only when every face the layout actually used covers, via its
parsed `cmap`, the characters that face was asked to render — the bold face the headings and the
emphasised runs, the italic face the quotes, the bold-italic face both — and the regular face also
covers the essential baseline of printable Latin, Romanian diacritics and typographic punctuation
used by the labels, the page numbers and the table of contents. A style with no file of its own falls
back to the regular face, which is accepted only when that face covers the style's characters. There
is no partial-font success path: a missing glyph is never written as `?` or dropped, and if no family
covers the edition the CLI fails with `MISSING_FONT`, naming the family, the face and the characters.
Fonts are a soft dependency: the skill works on any system with a TrueType serif, and no font is
downloaded or bundled.

**CLI contract.** `--universe` (required), `--out` (default `<universe>/exports`), `--format`
(`both|docx|pdf`), `--fonts`, `--language` (edition language; default: `language` from
`exports/edition.json`, then from `universe.json`, otherwise `ro`). `--language` localizes the TOC
heading, the default preface/afterword titles, the „Capitolul N"/"Chapter N" labels, the fallback
title and the DOCX/PDF language metadata; `ro` and `en` are the required label sets and any other
code falls back to English labels. File names are `<slug>-<YYYYMMDD>.<ext>` with the slug
transliterated to `[a-z0-9-]`. Success prints `{"ok":true,"title":…,"chapters":…,"words":…,
"source_version":"sha256:…","manifest":"edition-manifest.json","chapterInventory":[…],
"outputs":[{"format","path","bytes","sha256","pages"}]}`; failure prints
`{"ok":false,"error":…,"code":…}`. Exit codes: 0 success, 2 usage, 1 processing. The same run writes
`exports/edition-manifest.json`: the requested format, the language, the `source_version` of §8.2,
and one entry per document with its file name, size, sha256 and page count.

**Verification.** `scripts/verify-edition.mjs --universe <folder> [--format both|docx|pdf]
[--since <epoch-ms>] [--fonts <folder>] [--language <code>]` reads and never writes. It requires a
document for every requested format (`NO_EXPORT` otherwise, and `--since` keeps an older edition from
counting as this run's product), verifies each one structurally (`INVALID_EXPORT`), checks it against
the record it must have (`MISSING_MANIFEST`, `INVALID_MANIFEST`), repeats the per-face glyph check
when `--fonts` is given (`MISSING_FONT`) and reports a document whose recorded version the universe
has left as `historical: true` with a `HISTORICAL_EDITION` warning. Result: one JSON line
(`edition-verification.v1`), exit 0 when `ok` and 2 otherwise.

## Decisions & Questions

### Question #1: Why a hand-written PDF/DOCX engine instead of a library?

Response: The project forbids npm dependencies and the renderer must be portable and offline. The
subset of PDF and OOXML needed here (text-only book, four styles, one font family, a cached TOC) is
small and stable, and the layout engine is shared by both outputs, so a library would add a large
opaque dependency for a narrow gain. The engines are validated by external consumers: `pdftotext`,
`pdffonts`, `pdftoppm`, Ghostscript, `unzip` and LibreOffice all read the produced files.

### Question #2: Why is `MISSING_UNIVERSE` exit code 2 rather than 1?

Response: A missing or wrong `--universe` path is an invocation error — the caller pointed the tool
at something that is not a universe — while everything after loading the universe (no chapters, no
usable font, I/O failure) is a processing error. The contract fixes 2 for usage errors and 1 for
processing, and both cases still emit the single JSON line.

### Question #3: Why are preface and afterword not extra levels in the TOC field?

Response: The contract fixes the DOCX field instruction to `\o "1-1"` (level 1 only). The TOC
therefore lists every level-1 heading in document order, which includes the preface and afterword
sections (rendered as `Heading1`), and the cached result stays identical to what Word or LibreOffice
recomputes.

### Question #4: Why a second command instead of a verification flag on the renderer?

Response: The two questions are different. The renderer answers "what did I write?", which it knows
only from its own run; the verifier answers "is what is on disk a readable edition of the accepted
version it claims?", which must hold when the files are the only thing left — after a restart, after
a truncation, or when an agent reports a run that produced nothing. A verification flag inside the
renderer would be told what to expect and could still trust the run that just failed; a separate,
read-only command re-derives everything from the universe and the bytes, and its independence is what
makes it usable as the server's acceptance step. The record (`edition-manifest.json`) is what carries
the claim between them, so the verifier compares two independent derivations rather than one.
