---
title: DS008-scripta-book-export-skill
summary: Defines the print skill: its command-line contract, the editorial metadata it consumes, the language and naming rules, the accepted chapter Markdown, the font requirement, the produced DOCX and PDF characteristics, and its exit codes.
---

## Introduction

`skills/scripta-book-export/` turns a universe folder into a printable [edition](wiki.html#definition-edition). The agent writes the editorial metadata and then runs one command, which produces a DOCX file, a PDF file or both, inside the universe's `exports/` folder. This specification states the command-line contract, what the renderer reads and writes, how the edition language is resolved, what the produced files contain, and which failures the caller has to handle. The export turn that invokes it is in `DS003-main-behavior`, the metadata file in `DS004-universe-storage`, and the browser surface that offers the downloads in `DS006-reader-interface`.

## Core Content

### Purpose and scope

The skill exists so that a book written as Markdown chapters can be read as a printed edition without any external toolchain: the renderer contains its own TrueType font parser and subsetter, its own A5 layout engine, its own PDF writer and its own DOCX writer built on `node:zlib` and `node:crypto`, and it depends on no npm package, no Python, no browser library and no external command. The folder contains `SKILL.md` with the agent procedure and the CLI reference, `DS.md` with the design summary, `dependencies.md` with the dependency record, `skill.json` as the catalog manifest, and `scripts/build-book.mjs` as the single executable.

The skill has one command and no subcommands. Its output contract is a single JSON line on standard output, which makes it usable both by the agent that runs it and by `npm run check`, which parses that line to prove the renderer still works.

`scripts/build-book.mjs` is the single executable and holds only the entry point: the option parsing, the render pipeline and the single JSON line. The engines it uses are native ES modules in `scripts/lib/`: `errors.mjs` (exit codes, `fail`, file readers and text/byte helpers), `truetype.mjs` (the font parser and subsetter), `fonts.mjs` (the font search, the family ranking and `BookFace`), `markdown.mjs` (the accepted Markdown subset), `book.mjs` (the edition language, the labels and the book model), `layout.mjs` (pagination, table of contents and title page), `pdf.mjs` (the PDF writer) and `docx.mjs` (the ZIP and OOXML writer). The split is internal and descriptive only: the command, the flags, the JSON line and the exit codes below are unchanged.

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

An edition file is named `<slug>-<YYYYMMDD>.<ext>`, where the slug is the normalized title reduced to lowercase letters, digits and hyphens with diacritics transliterated, and the date is the build date. The extension is `pdf`, `docx` or both, according to `--format`. The renderer creates the output folder when it does not exist and writes nothing else: it never touches chapters, `universe.json`, `turns/` or `exports/edition.json`.

The PDF contains a separate title page, the optional dedication, a table of contents whose titles and page numbers are computed by the layout engine, chapters that start on a new page under the localized chapter label, footer page numbering that omits the title page, bookmarks for the titles, and a subsetted serif TrueType font with a `ToUnicode` map, which is what makes the text selectable and the diacritics correct. The DOCX contains the equivalent structure expressed with the `Title`, `Heading1`, `Heading2`, `Normal`, `Quote` and `TOC1` styles, page breaks between chapters, footer page numbering, and a real table-of-contents field with a cached result computed from the same layout engine, so the numbers are correct before a word processor refreshes the field.

### Input requirements

The renderer reads the chapter files named `chapters/NNNN-<slug>.md`, sorted by chapter number, and requires at least one; otherwise it fails with `NO_CHAPTERS`. The chapter title is the first heading of the file, with a fallback built from the file slug and, when that is empty, the localized untitled label. The accepted Markdown subset is the same one the narrative skill writes: level one and level two headings, with deeper levels treated as level two, paragraphs separated by a blank line, blockquotes, scene separators written as `---`, and bold or italic emphasis. Tables, images, code, raw HTML and links are not accepted.

### Fonts

The renderer searches system font locations in a fixed order: the Liberation Serif folder, then Liberation families under the TrueType tree, then Noto Serif in the Google Noto variable-font folder, and finally any serif `.ttf` file under the system font tree. A family is accepted only when its regular face covers, through its character map, every character of the book; otherwise the next family is tried. Missing styles fall back to the regular face. When no family covers at least the Latin set plus the Romanian diacritics, the command fails with `MISSING_FONT` and exit code 1, which is the failure mode an operator sees on a machine without a suitable serif font: the remedy is to install one or to pass `--fonts <folder>` pointing at a folder of `.ttf` files with `glyf` outlines. OpenType CFF fonts and font collections are ignored by the search. The dependency record states the acceptance rule, the licence position, and the removal opportunity for this soft dependency; fonts are never bundled or redistributed with the repository, and only glyph subsets are embedded in a produced file.

### Output contract and exit codes

On success the single JSON line carries `ok`, the edition `title`, the `chapters` count, the `words` count and an `outputs` array whose entries carry `format`, an absolute `path`, `bytes` and `pages`, where `pages` is an integer for a PDF and `null` for a DOCX. On failure it carries `ok: false` with an `error` message and a `code` such as `USAGE`, `MISSING_UNIVERSE`, `NO_CHAPTERS`, `MISSING_FONT`, `BAD_JSON`, `IO_ERROR` or `INTERNAL`.

Exit statuses are part of the contract: 0 for success, 2 for a usage failure, and 1 for a processing failure. A caller must therefore treat a nonzero status as a failed edition and surface the JSON code, and it must not infer success from the existence of the process or from partial output. The agent is required to report the paths, formats, page counts and sizes it read from that JSON line and to invent nothing.

### Dependencies and boundary

The skill requires Node.js 20 or later and uses only built-in modules for file access, paths, URL resolution, compression and hashing. It needs no installation step, no build step and no network access at runtime. A system TrueType serif font is an optional runtime requirement that becomes mandatory as soon as any edition is requested, because the renderer resolves the font before it decides which format to write, and the failure is reported rather than worked around. The tools used during development to inspect produced files, such as `pdftotext`, `pdffonts`, `pdftoppm`, Ghostscript, `unzip` and LibreOffice, are verification tools and not dependencies of the command.

The boundary is that the renderer is a producer, not an editor: it reads the book, it produces files, and it fails when the book or the environment cannot support a complete edition. Deciding when an edition is produced belongs to the turn pipeline, and presenting the produced files belongs to the reader interface.
