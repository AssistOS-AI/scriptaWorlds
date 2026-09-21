---
name: scripta-book-export
description: Generates the printed edition (DOCX and/or PDF) of a scriptaWorlds universe from its Markdown chapters, with its own layout engine and no npm dependencies. Use this skill when the client asks "Generate the edition", when an edition has to be rebuilt after chapters were added, or when the editorial metadata in exports/edition.json has to be checked.
---

# scripta-book-export

Turns a universe folder (`docs/contracts.md` §2.1) into a book: `exports/<slug>-<YYYYMMDD>.pdf`
and/or `.docx`. The renderer is a dependency-free CLI with its own PDF engine (subsetted TrueType
font, selectable text) and DOCX engine (ZIP + OOXML, table of contents as a real `TOC` field).

## When it is used

- The client asks for a printed edition (`kind: "export"` in the turn started by the server).
- Chapters were added or modified and the edition has to be regenerated.
- The editorial metadata (`exports/edition.json`) has to be completed before generation.

## Agent procedure (from the universe folder)

Run from the universe folder; the server has already created `.agents/skills/scripta-book-export`
(a symlink to `skills/scripta-book-export` in the repo), so the paths below are valid.

1. **Read the state of the book.** `chapters/NNNN-slug.md` (the title is mandatory on the first line, `# Title`)
   and `universe.json` (for the title, the language, `lastChapter`). Do not modify `universe.json` and `turns/`.
2. **Check and complete `exports/edition.json`** (contract §2.5). Write the file if it is missing;
   keep what already exists and fill in only the gaps. All fields except `title` are
   optional, and the gaps are filled in automatically from `universe.json`.

   ```json
   {
     "title": "The Ash Archive",
     "subtitle": "Six episodes about a library that survives its readers",
     "author": "scriptaWorlds · ALA",
     "year": 2026,
     "dedication": "For those who read to the last shelf.",
     "preface": "## Preface\n\nText…",
     "afterword": "## Afterword\n\nText…"
   }
   ```

   - `preface` / `afterword` are plain Markdown (§2.3); the section title is the first heading in the text,
     and if it is missing the localized label of the book's language is used ("Cuvânt înainte"/"Postfață"
     in Romanian, "Preface"/"Afterword" in English).
   - `language` (optional) forces the language of the edition; it takes priority over `language` in `universe.json`.
   - The dedication appears on its own page; the preface and the afterword appear in the table of contents.
3. **Run the renderer.**

   ```sh
   node .agents/skills/scripta-book-export/scripts/build-book.mjs --universe . --format both
   ```

   Add `--language <code>` only if the edition has to be labeled in a language other than the one resolved
   automatically (`edition.json` → `universe.json` → `ro`).

4. **Read the JSON line on stdout** (the only output line) and **report the absolute paths**:

   ```json
   {"ok":true,"title":"The Ash Archive","chapters":6,"words":10050,
    "outputs":[{"format":"pdf","path":"/…/the-ash-archive-20260921.pdf","bytes":193332,"pages":41},
               {"format":"docx","path":"/…/the-ash-archive-20260921.docx","bytes":13342,"pages":null}]}
   ```

   On error: `{"ok":false,"error":"clear message","code":"MISSING_FONT"}` and exit code `1`
   (processing) or `2` (usage). Report to the client the file path, the format, the number of
   pages and the size; do not invent values you have not read from the JSON.

## CLI

```
node skills/scripta-book-export/scripts/build-book.mjs \
  --universe <universe-folder> [--out <folder>] [--format both|docx|pdf] [--fonts <folder>] [--language <code>]
```

`scripts/build-book.mjs` is only the entry point (arguments, render pipeline, the JSON line); the
engines are native ES modules in `scripts/lib/`: `errors.mjs` (exit codes, `fail`, file and text
helpers), `truetype.mjs` (font parser and subsetter), `fonts.mjs` (font search, `BookFace`,
`resolveFonts`), `markdown.mjs` (the accepted Markdown subset), `book.mjs` (edition language, labels,
book model), `layout.mjs` (pagination, table of contents, title page), `pdf.mjs` (PDF writer) and
`docx.mjs` (ZIP + OOXML writer). This is an internal layout only: the command, the flags, the JSON
line and the exit codes below are unchanged.

| Flag | Meaning |
| --- | --- |
| `--universe` | the universe folder (required); accepts `.` |
| `--out` | the destination folder (default `<universe>/exports`) |
| `--format` | `both` (default), `docx` or `pdf` |
| `--fonts` | alternative folder of `.ttf` fonts (overrides the system search) |
| `--language` | the language of the edition (default: `language` from `exports/edition.json`, then from `universe.json`, otherwise `ro`) |

**The edition language** (§3) localizes only the labels: table of contents ("Cuprins"/"Table of contents"),
default preface/afterword ("Cuvânt înainte"/"Preface", "Postfață"/"Afterword"), "Capitolul N"/"Chapter N",
the fallback title ("Fără titlu"/"Untitled") and the DOCX/PDF language metadata. `ro` and `en` are
required; any other code uses the English labels. The chapter, preface and afterword text written by the
agent **is not** translated.

File names: `<slug>-<YYYYMMDD>.pdf|.docx`, where `slug` is the normalized title `[a-z0-9-]`
(diacritics are transliterated: `ș→s`, `ț→t`, `ă→a`, `â→a`, `î→i`). The JSON output is a single
line on stdout; exit codes: `0` success, `1` processing error, `2` usage error.

## What it produces

- **PDF**: separate title page, dedication (optional), table of contents with the localized label of the edition
  ("Cuprins"/"Table of contents") and with titles and page numbers computed by the layout engine,
  chapters starting on a new page with the localized label "Capitolul N"/"Chapter N",
  footer page numbering (the title page is not numbered), bookmarks (outline) for titles,
  subsetted serif TrueType font with `ToUnicode` — selectable text and correct Romanian diacritics
  (`ă â î ș ț`, `„"`, `– —`).
- **DOCX**: `Title`/`Heading1`/`Heading2`/`Normal`/`Quote`/`TOC1` styles, page breaks between
  chapters, footer page numbering (no number on the first page) and the table of contents as a **real
  field** `TOC \o "1-1" \h \z \u` with a cached result (titles + page numbers from the same layout
  engine). Word can regenerate the field; the regenerated result contains exactly the same level 1 titles.

Accepted Markdown (§2.3): `#`/`##` headings (deeper levels are treated as `##`), paragraphs
separated by a blank line, `> ` quotes, `---` scene separators, `**bold**` / `*italic*` emphasis.
Tables, images, code, HTML and links are not accepted.

## Fonts

The search order is: `/usr/share/fonts/liberation-serif-fonts/` (Regular/Bold/Italic/BoldItalic),
then any `/usr/share/fonts/truetype/liberation*`, then `/usr/share/fonts/google-noto-vf/NotoSerif*`,
then any serif `.ttf` font from `/usr/share/fonts`. The chosen family must cover through its `cmap`
every character of the book; otherwise the next one is tried, and if none covers at least the
Latin set plus the Romanian diacritics, the CLI exits with `MISSING_FONT`. Missing styles (for example
Bold) fall back to Regular. Use `--fonts <folder>` only if you want a specific font; the folder must
contain `.ttf` files with `glyf` outlines (CFF/`.otf` fonts and `.ttc` collections are ignored).

## Rules

- Do not modify `universe.json`, `turns/` or the chapters during the export; the renderer only reads.
- Do not write manually into `exports/` except for `edition.json`; the `.pdf`/`.docx` files are produced by the CLI.
- Do not install dependencies: the renderer uses only built-in `node:` modules.
- If `--format` was requested by the server (`both|docx|pdf`), use exactly that format.

Dependency inventory and design summary: [dependencies.md](dependencies.md), [DS.md](DS.md).
