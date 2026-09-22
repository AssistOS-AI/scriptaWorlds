---
title: DS008-scripta-book-export-skill
summary: Defines the print skill: the command line of the renderer and of the verifier that accepts an edition, the edition record that binds it to the accepted version, the editorial metadata it consumes, the language and naming rules, the accepted chapter Markdown, the per-face font requirement, the produced DOCX and PDF characteristics, and its exit codes.
---

## Introduction

`skills/scripta-book-export/` turns a universe folder into a printable [edition](wiki.html#definition-edition). The agent writes the editorial metadata and then runs the renderer, which produces a DOCX file, a PDF file or both inside the universe's `exports/` folder together with the record that binds them to the content they were rendered from; the server then runs the skill's second command, the verifier, which accepts or refuses that edition. This specification states both command-line contracts, what the renderer reads and writes, how the edition language is resolved, what the produced files contain, what the verifier establishes before an edition counts as produced, and which failures the caller has to handle. The export turn that invokes it is in `DS003-main-behavior`, the metadata file in `DS004-universe-storage`, and the browser surface that offers the downloads in `DS006-reader-interface`.

## Core Content

### Purpose and scope

The skill exists so that a book written as Markdown chapters can be read as a printed edition without any external toolchain: the renderer contains its own TrueType font parser and subsetter, its own A5 layout engine, its own PDF writer and its own DOCX writer built on `node:zlib` and `node:crypto`, and it depends on no npm package, no Python, no browser library and no external command. The folder contains `SKILL.md` with the agent procedure and the CLI reference, `DS.md` with the design summary, `dependencies.md` with the dependency record, `skill.json` as the catalog manifest, the two executables `scripts/build-book.mjs` and `scripts/verify-edition.mjs`, and the focused test suites under `tests/`.

The skill has two commands and no subcommands: the renderer, which the agent runs and which writes the edition, and the verifier, which the server runs afterwards and which only reads — it establishes that the files are documents a reader can open and that they are the edition of the accepted version the record claims, and it writes nothing anywhere. Each command has a single JSON line as its output contract, which makes them usable both by the agent, by the server and by `npm run check`, which parses the renderer's line to prove the renderer still works.

`scripts/build-book.mjs` holds only the entry point: the option parsing, the render pipeline, the edition record and the single JSON line. The engines it uses are native ES modules in `scripts/lib/`: `errors.mjs` (exit codes, `fail`, file readers and text/byte helpers), `truetype.mjs` (the font parser and subsetter), `fonts.mjs` (the font search, the family ranking and `BookFace`), `markdown.mjs` (the accepted Markdown subset), `book.mjs` (the edition language, the labels, the book model and the accepted-version identity), `layout.mjs` (pagination, table of contents and title page), `pdf.mjs` (the PDF writer), `docx.mjs` (the ZIP and OOXML writer), `verify.mjs` (the structural verification of a produced PDF or DOCX, shared by the renderer and the verifier) and `manifest.mjs` (the edition record). The split is internal and descriptive only: the commands, the flags, the JSON lines and the exit codes below are unchanged.

### Command-line contract

```sh
node skills/scripta-book-export/scripts/build-book.mjs \
  --universe <universe-folder> [--out <folder>] [--format both|docx|pdf] [--fonts <folder>] [--language <code>]
```

`--universe` is required and accepts `.` so that the agent can run the command from inside the universe folder, where the same script is reachable through the `.agents/skills/scripta-book-export` symlink. `--out` defaults to the `exports` folder of the universe. `--format` defaults to `both` and accepts `docx`, `pdf` or `both`. `--fonts` replaces the system font search with a folder of `.ttf` files. `--language` overrides the edition language.

A missing value, an unknown flag, an invalid format, an invalid language code or a missing `--universe` produce a usage failure: the JSON line carries `ok: false` with the code `USAGE` and the process exits with status 2. Supplying an option that the caller needs but never checks is therefore not possible: an invalid invocation never produces a partial edition.

### Editorial metadata

The agent writes `exports/edition.json` before running the renderer. `title` is the only required field; `subtitle`, `author`, `year`, `dedication`, `preface`, `afterword` and `language` are optional, and missing values are filled from `universe.json`. The renderer reads `title`, `language` and `id` from `universe.json` and uses the folder name when the identifier is absent. A subtitle, dedication, preface and afterword come only from the metadata file; a missing metadata file is not an error, and a metadata file that is not valid JSON fails with `BAD_JSON`.

The preface and afterword are Markdown and their section title is the first heading in the text; when it is missing, the localized label of the edition language is used. The dedication is set on its own page, and the preface and the afterword appear in the table of contents as level one entries next to the chapters.

### Language resolution

The edition language is resolved in a fixed order: the `--language` flag first when it is given, then `language` in `exports/edition.json`, then `language` in `universe.json`, and then `ro`. The order matters because a book can be written in one language while an edition is labelled in another; the flag exists exactly for that case, and the metadata file lets a single universe produce editions with different labels over time.

The resolved language localizes the labels only: the table of contents heading, the default preface and afterword headings, the chapter label, the untitled-chapter fallback and the language metadata written into the DOCX and PDF files. Romanian and English labels are required; any other code uses the English labels. Narrative text written by the agent is never translated, so a Romanian book exported with `--language en` keeps Romanian prose and English section labels.

### Naming and produced files

An edition file is named `<slug>-<YYYYMMDD>.<ext>`, where the slug is the normalized title reduced to lowercase letters, digits and hyphens with diacritics transliterated, and the date is the build date. The extension is `pdf`, `docx` or both, according to `--format`. The renderer creates the output folder when it does not exist and writes only the documents of this run plus the edition record beside them: it never touches chapters, `universe.json`, `turns/` or `exports/edition.json`.

The PDF contains a separate title page, the optional dedication, a table of contents whose titles and page numbers are computed by the layout engine, chapters that start on a new page under the localized chapter label, footer page numbering that omits the title page, bookmarks for the titles, and a subsetted serif TrueType font with a `ToUnicode` map, which is what makes the text selectable and the diacritics correct. The DOCX contains the equivalent structure expressed with the `Title`, `Heading1`, `Heading2`, `Normal`, `Quote` and `TOC1` styles, page breaks between chapters, footer page numbering, and a real table-of-contents field with a cached result computed from the same layout engine, so the numbers are correct before a word processor refreshes the field.

### Input requirements

The renderer reads the chapter files named `chapters/NNNN-<slug>.md`, sorted by chapter number, and requires at least one; otherwise it fails with `NO_CHAPTERS`. The chapter title is the first heading of the file, with a fallback built from the file slug and, when that is empty, the localized untitled label. The accepted Markdown subset is the same one the narrative skill writes: level one and level two headings, with deeper levels treated as level two, paragraphs separated by a blank line, blockquotes, scene separators written as `---`, and bold or italic emphasis. Tables, images, code, raw HTML and links are not accepted.

### Fonts

The renderer searches system font locations in a fixed order: the Liberation Serif folder, then Liberation families under the TrueType tree, then Noto Serif in the Google Noto variable-font folder, and finally any serif `.ttf` file under the system font tree. Coverage is checked per face, against the characters the layout actually asks that face to render: the bold face renders the headings and the emphasised runs, the italic face the quotes, the bold-italic face both, and the regular face must additionally cover the essential baseline — printable Latin, the Romanian diacritics and the typographic punctuation the labels, the page numbers and the table of contents are built from. A style with no file of its own falls back to the regular face, and that substitution is accepted only when the substituted face covers the characters that style renders. 

There is no partial-font success path: a character with no glyph is never replaced by `?` or by a dropped run. When no family covers the edition, the command fails with `MISSING_FONT` and exit code 1, naming the family, the face and the missing characters, which is the failure mode an operator sees on a machine without a suitable serif font: the remedy is to install one or to pass `--fonts <folder>` pointing at a folder of `.ttf` files with `glyf` outlines. OpenType CFF fonts and font collections are ignored by the search. The dependency record states the acceptance rule, the licence position, and the removal opportunity for this soft dependency; fonts are never bundled or redistributed with the repository, and only glyph subsets are embedded in a produced file.

### Output contract and exit codes

On success the single JSON line carries `ok`, the edition `title`, the `chapters` count, the `words` count, the chapter inventory the edition was rendered from, the `source_version` it is bound to, the file name of the edition record, and an `outputs` array whose entries carry `format`, an absolute `path`, `bytes`, `sha256` and `pages`, where `pages` is an integer for a PDF and `null` for a DOCX. On failure it carries `ok: false` with an `error` message and a `code` such as `USAGE`, `MISSING_UNIVERSE`, `NO_CHAPTERS`, `MISSING_FONT`, `BAD_JSON`, `IO_ERROR`, `BAD_PDF`, `BAD_DOCX`, `EDITION_CHANGED` or `INTERNAL`.

Exit statuses are part of the contract: 0 for success, 2 for a usage failure, and 1 for a processing failure. A caller must therefore treat a nonzero status as a failed edition and surface the JSON code, and it must not infer success from the existence of the process or from partial output. The agent is required to report the paths, formats, page counts and sizes it read from that JSON line and to invent nothing.

### The edition record and its verification

A produced document is only accepted together with the content it came from. Before writing anything the renderer reads the role files of the accepted version (`chapters/*.md`, `chapters/NNNN-offer.json`, `canon.md`, `threads.json`, `atlas.json`) and recomputes the identity of `docs/contracts.md` §8.2; a chapter that changed between that read and the render is refused with `EDITION_CHANGED` instead of being recorded as if it had been rendered. When every document has been written and read back, the run writes `exports/edition-manifest.json` (schema `edition-manifest.v1`) next to it:

```jsonc
{
  "schema_version": "edition-manifest.v1",
  "universe_id": "arhiva-cenusii",
  "generated_at": "2026-09-22T16:40:00.000Z",
  "format": "both",                       // the format this run requested
  "language": "en",                       // the language the edition was labelled in
  "source_version": "sha256:9f2c…",       // §8.2 over chapter, offer, canon, threads and atlas
  "documents": [                          // one honest entry per produced document
    { "format": "pdf", "path": "the-ash-archive-20260922.pdf", "bytes": 812345, "sha256": "…", "pages": 96 },
    { "format": "docx", "path": "the-ash-archive-20260922.docx", "bytes": 38412, "sha256": "…", "pages": null }
  ]
}
```

Document paths are relative to the folder that holds the record, so a record never points outside its own folder. The record is written in one step and only after a complete, readable edition exists: a failed run leaves no record claiming documents it does not have. The renderer never edits it again, and an agent never writes it by hand.

`scripts/verify-edition.mjs` is the read-only acceptance step:

```sh
node skills/scripta-book-export/scripts/verify-edition.mjs \
  --universe <universe-folder> [--format both|docx|pdf] [--since <epoch-ms>] [--fonts <folder>] [--language <code>]
```

`--format` is the format the run requested (`both` by default). `--since` is the start of the run in epoch milliseconds: only files written at or after it count as this run's products, so an older edition cannot pass as the product of a run that produced nothing. `--fonts` and `--language` are the rendering options the caller used; the verifier repeats the font resolution over the accepted text with them, so a document whose text the font set cannot render — a character with no glyph in the face that must render it — is refused with `MISSING_FONT` rather than accepted because the regular face covers the Latin essentials.

The verifier reads each requested document twice over: as a document, through the same structural code the renderer used (a PDF header with a cross-reference table, a trailer and a page tree whose page objects are all present; a DOCX whose ZIP members inflate and whose `[Content_Types].xml`, `word/document.xml` and `word/_rels/document.xml.rels` parse as XML and whose relationships resolve inside the archive), and as a record, comparing the file's size, hash and page count with the manifest entry. A document whose recorded `source_version` differs from the accepted version of the universe on disk is reported with `historical: true` and a `HISTORICAL_EDITION` warning: an older edition stays readable and verifiable, but it is visibly not the current book. A missing or unusable record is an error for a document of the run, never a silent pass.

The result is one JSON line, `{"schema_version":"edition-verification.v1","ok":…,"errors":[…],"warnings":[…],"documents":[…]}`, where every accepted document carries `format`, `path` relative to the universe, `bytes`, `sha256`, `pages`, `source_version` and `historical`. The exit status is 0 when `ok` is true and 2 otherwise, including invalid arguments; the command writes nothing.

| Code | Meaning |
| --- | --- |
| `USAGE`, `MISSING_UNIVERSE` | the arguments are invalid, or `--universe` is not a folder |
| `DUPLICATE_CHAPTER` | two chapter files carry the same number, so no single chapter set can be bound to the edition |
| `NO_EXPORT` | a requested format has no document produced by this run |
| `MISSING_MANIFEST` | a document exists but no edition record binds it to a source version |
| `INVALID_MANIFEST` | the record is unreadable, malformed, or disagrees with the requested run |
| `INVALID_EXPORT` | the file is not a readable document for its format, or it disagrees with its recorded size, hash or page count |
| `MISSING_FONT` | with `--fonts`, a face cannot render a character the edition text needs |
| `HISTORICAL_EDITION` | warning: the edition was rendered from a version the universe has left |

The boundary between the two commands is deliberate: the renderer knows what it wrote, the verifier knows only what is on disk and what the record claims. A file name, a header or a manifest entry alone never establishes that an edition exists.

### Dependencies and boundary

The skill requires Node.js 20 or later and uses only built-in modules for file access, paths, URL resolution, compression and hashing. It needs no installation step, no build step and no network access at runtime. A system TrueType serif font is an optional runtime requirement that becomes mandatory as soon as any edition is requested, because the renderer resolves the font before it decides which format to write, and the failure is reported rather than worked around. The verifier needs no further capability: it reads the produced files with the same built-in compression and hashing modules, and it writes nothing. No font is downloaded, bundled or redistributed by either command: only a glyph subset of a font the machine already has is embedded in a PDF. The tools used during development to inspect produced files, such as `pdftotext`, `pdffonts`, `pdftoppm`, Ghostscript, `unzip` and LibreOffice, are verification tools and not dependencies of the commands.

The boundary is that the renderer is a producer, not an editor, and that the verifier judges only artifacts: it reads the book, the produced files and the record, and it reports; it never repairs a document, never rewrites the record and never adds a chapter. The renderer fails when the book or the environment cannot support a complete edition, and the verifier fails when what is on disk is not the edition it claims to be. Deciding when an edition is produced belongs to the turn pipeline, and presenting the produced files belongs to the reader interface.
