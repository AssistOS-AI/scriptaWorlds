# Scripta Book Export Design Summary

## Introduction

`scripta-book-export` turns the Markdown chapters of a scriptaWorlds universe into a printable
edition (PDF and/or DOCX). It is the implementation of the renderer CLI contract in
`docs/contracts.md` §3: one command, five flags, one JSON line on stdout, exit codes 0/1/2, and no
npm dependencies — only Node.js built-ins.

The skill is invoked by the coding agent running inside a universe folder
(`node .agents/skills/scripta-book-export/scripts/build-book.mjs --universe . --format both`), so
every path is resolved from the universe folder and the outputs land in `exports/`.

## Module layout

`scripts/build-book.mjs` is only the command line — argument parsing, the render pipeline and the
single JSON line — and the engines live beside it in `scripts/lib/` as native ES modules with
relative `.mjs` imports and no npm dependency:

| Module | Responsibility |
| --- | --- |
| `lib/errors.mjs` | exit codes, `BookError`/`fail`, file readers, slug/date/XML/PDF-string helpers, byte helpers |
| `lib/truetype.mjs` | TrueType table directory, `cmap` formats 0/4/12, glyph access, composite closure, subsetting |
| `lib/fonts.mjs` | font discovery and ranking, `BookFace`, `resolveFonts` |
| `lib/markdown.mjs` | the accepted Markdown subset |
| `lib/book.mjs` | edition language and labels, chapter loading, the book model |
| `lib/layout.mjs` | A5 pagination, block styles, TOC pass, title and dedication pages |
| `lib/pdf.mjs` | PDF writer (subsetted fonts, outline, document info, xref) |
| `lib/docx.mjs` | ZIP + OOXML writer |

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
in `/usr/share/fonts` (or in `--fonts <folder>`, which replaces the search). A family is accepted
only when its regular face covers, via its parsed `cmap`, every character of the book; missing styles
fall back to regular. If no family covers at least Latin plus Romanian diacritics the CLI fails with
`MISSING_FONT`. Fonts are a soft dependency: the skill works on any system with a TrueType serif.

**CLI contract.** `--universe` (required), `--out` (default `<universe>/exports`), `--format`
(`both|docx|pdf`), `--fonts`, `--language` (edition language; default: `language` from
`exports/edition.json`, then from `universe.json`, otherwise `ro`). `--language` localizes the TOC
heading, the default preface/afterword titles, the „Capitolul N"/"Chapter N" labels, the fallback
title and the DOCX/PDF language metadata; `ro` and `en` are the required label sets and any other
code falls back to English labels. File names are `<slug>-<YYYYMMDD>.<ext>` with the slug
transliterated to `[a-z0-9-]`. Success prints
`{"ok":true,"title":…,"chapters":…,"words":…,"outputs":[{"format","path","bytes","pages"}]}`;
failure prints `{"ok":false,"error":…,"code":…}`. Exit codes: 0 success, 2 usage, 1 processing.

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
