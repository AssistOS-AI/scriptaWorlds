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
    "source_version":"sha256:9f2c…","manifest":"edition-manifest.json",
    "chapterInventory":[{"number":1,"path":"chapters/0001-x.md","sha256":"…","bytes":1234}],
    "outputs":[{"format":"pdf","path":"/…/the-ash-archive-20260921.pdf","bytes":193332,"pages":41,
                "sha256":"…"},
               {"format":"docx","path":"/…/the-ash-archive-20260921.docx","bytes":13342,"pages":null,
                "sha256":"…"}]}
   ```

   On error: `{"ok":false,"error":"clear message","code":"MISSING_FONT"}` and exit code `1`
   (processing) or `2` (usage). Report to the client the file path, the format, the number of
   pages and the size; do not invent values you have not read from the JSON.

   The same run writes `exports/edition-manifest.json` (schema `edition-manifest.v1`): the requested
   format, every produced document with its file name, size, sha256 and page count, and
   `source_version` — the accepted version of `docs/contracts.md` §8.2 the edition was rendered from.
   That record is what lets the server check the edition later; never write or edit it by hand.

## CLI

```
node skills/scripta-book-export/scripts/build-book.mjs \
  --universe <universe-folder> [--out <folder>] [--format both|docx|pdf] [--fonts <folder>] [--language <code>]
```

`scripts/build-book.mjs` is only the entry point (arguments, render pipeline, the JSON line); the
engines are native ES modules in `scripts/lib/`: `errors.mjs` (exit codes, `fail`, file and text
helpers), `truetype.mjs` (font parser and subsetter), `fonts.mjs` (font search, `BookFace`,
`resolveFonts`), `markdown.mjs` (the accepted Markdown subset), `book.mjs` (edition language, labels,
book model, the §8.2 accepted version), `layout.mjs` (pagination, table of contents, title page),
`pdf.mjs` (PDF writer), `docx.mjs` (ZIP + OOXML writer), `verify.mjs` (structural verification of a
produced PDF or DOCX) and `manifest.mjs` (the `edition-manifest.v1` record). This is an internal
layout only: the commands, the flags, the JSON lines and the exit codes below are unchanged.

| Flag | Meaning |
| --- | --- |
| `--universe` | the universe folder (required); accepts `.` |
| `--out` | the destination folder (default `<universe>/exports`) |
| `--format` | `both` (default), `docx` or `pdf` |
| `--fonts` | alternative folder of `.ttf` fonts (overrides the system search) |
| `--language` | the language of the edition (default: `language` from `exports/edition.json`, then from `universe.json`, otherwise `ro`) |

### Server acceptance: `verify-edition.mjs`

The server does not accept an edition because a file appeared: after the agent's run it calls the
second command of this skill, which reads the universe and its `exports/` folder, checks the produced
documents as documents and compares them with `exports/edition-manifest.json`. It writes nothing.

```sh
node skills/scripta-book-export/scripts/verify-edition.mjs \
  --universe <universe-folder> [--format both|docx|pdf] [--since <epoch-ms>] [--fonts <folder>] [--language <code>]
```

| Flag | Meaning |
| --- | --- |
| `--universe` | the universe folder (required) |
| `--format` | the formats this run requested (`both` by default) |
| `--since` | only files written at or after this time in epoch milliseconds count as this run's products |
| `--fonts` | re-checks that this folder's faces cover every character the edition text needs |
| `--language` | the language the edition was labelled in; re-checked against the manifest and used for the glyph re-check |

One JSON line on stdout, exit `0` when `ok` is true and `2` in every other case (a failed check, an
invalid argument, an unusable universe):

```json
{"schema_version":"edition-verification.v1","ok":true,"errors":[],"warnings":[],
 "documents":[{"format":"pdf","path":"exports/the-ash-archive-20260921.pdf","bytes":193332,
               "sha256":"…","pages":41,"source_version":"sha256:9f2c…","historical":false}]}
```

| Code | Meaning |
| --- | --- |
| `USAGE`, `MISSING_UNIVERSE` | the arguments are invalid or `--universe` is not a folder |
| `DUPLICATE_CHAPTER` | two chapter files carry the same number, so there is no single chapter set to bind the edition to |
| `NO_EXPORT` | a requested format has no document (`--since` counts this run's products only) |
| `MISSING_MANIFEST` | a document exists but no `edition-manifest.json` records it, so it cannot be bound to a source version |
| `INVALID_MANIFEST` | the manifest is unreadable, malformed, or disagrees with the requested run (a format it does not record, another language) |
| `INVALID_EXPORT` | the file is not a readable document for its format, or its bytes, hash or page count disagree with the manifest |
| `MISSING_FONT` | with `--fonts`: the faces do not cover every character the edition text needs |
| `HISTORICAL_EDITION` (warning) | the recorded `source_version` is no longer the accepted version of the universe: the edition does not contain the current book |

A `%PDF-` header is not a PDF and a `PK` signature is not a DOCX: the verifier reads the
cross-reference table, the trailer and the page tree of a PDF, and inflates the ZIP members of a DOCX
and parses its required Word parts, before it accepts anything.

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
then any serif `.ttf` font from `/usr/share/fonts`. A family is accepted only when every face the
layout renders with covers, through its `cmap`, the characters that face is asked to render — the
bold face the headings and the bold runs, the italic face the quotes, the bold-italic face both —
and the regular face must also cover the essential Latin baseline the labels, the page numbers and
the table of contents are built from. A style that has no file of its own falls back to the regular
face, and that fallback is allowed only when the regular face covers the characters that style
renders. Otherwise the next family is tried, and when no family covers the edition the CLI exits with
`MISSING_FONT` and names the family, the face and the missing characters (for example
`bold face (LiberationSerif-Bold) has no glyph for "ș" (U+0219)`). There is no partial-font success:
a character with no glyph is never replaced by `?`, an empty box or a dropped run — the edition is
refused instead. Use `--fonts <folder>` only if you want a specific font; the folder must contain
`.ttf` files with `glyf` outlines (CFF/`.otf` fonts and `.ttc` collections are ignored).

## Rules

- Do not modify `universe.json`, `turns/` or the chapters during the export; the renderer only reads.
- Do not write manually into `exports/` except for `edition.json`; the `.pdf`/`.docx` files and
  `edition-manifest.json` are produced by the CLI.
- Do not install dependencies: the renderer and the verifier use only built-in `node:` modules.
- If `--format` was requested by the server (`both|docx|pdf`), use exactly that format.
- Do not report a successful edition the JSON line does not confirm; the server runs
  `verify-edition.mjs` itself and fails the turn when the documents or their record do not hold.

Dependency inventory and design summary: [dependencies.md](dependencies.md), [DS.md](DS.md).
