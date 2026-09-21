---
title: DS009-start-template-library
summary: Defines the library of start templates: what a template is, how the nights of the book become one, the empty template, the index and folder split, how a reader starts a universe from one, and what creationFromTemplate composes.
---

## Introduction

Most readers do not arrive with the rules of a world in mind, so scriptaWorlds offers ready-made ones. The [library](wiki.html#definition-library) is the list of [start templates](wiki.html#definition-start-template) a reader can begin a [universe](wiki.html#definition-universe) from: a world, a prohibition that holds inside it and one problem already under way. Choosing a template does not create anything by itself; it fills the request field of the reader interface with a text that can be edited, and the universe is created only when the reader sends it. `src/library.mjs` reads the library, `scripts/build-library.mjs` builds it from the book, and `library/` holds it. This specification states what a template is, where it lives, how it is produced, what the empty template means, and what the server composes from a template when a universe is created. The creation route that consumes it is in `DS005-http-api`, the resulting universe record in `DS004-universe-storage`, the screen that lists it in `DS006-reader-interface`, and the exact field list in `docs/contracts.md` §7.

## Core Content

### Purpose and scope

The library exists because a universe must state its own rules before its first chapter, and because the project already owns a source of such rules: the [design instrument](wiki.html#definition-design-instrument) `vision/periodic_table.pdf`. The book is a course of nights, and each night opens a memorial sector, states a prohibition, puts one central problem in front of its readers and names the [cells](wiki.html#definition-cell) of the [Periodic Table of Speculative Ideas](wiki.html#definition-periodic-table) that are active in that world. A template is exactly that night turned into data a server can serve and a reader can edit: a world with rules and a story already under way, without an agent run and without a reading of the PDF at request time.

A template is not a prompt and not a universe. It is an input to creation: it contributes a law, a starting situation, a one-line summary and a handful of ingredients, and it contributes no chapter, no canon and no identifier. The library is read-only input for the server; `src/library.mjs` never writes to it, and no route modifies it.

### Where the library lives

The library is the top-level `library/` folder of the repository, resolved by `src/library.mjs` from the module itself (`libraryDir`), never from the working directory:

```
library/index.json                     the list, in the order the screen shows it
library/empty/template.json            the hand-written empty template
library/<slug>/template.json           one full template per night of the book
```

An entry of `library/index.json` carries only what the list needs: `slug`, `kind`, `number`, `title`, `sector`, `genealogy`, `cells` (each with `symbol`, `name`, `family` and `operator`), and `summary`. The file also carries `source` (the PDF the templates come from), `note`, `count` and `cellScenes`, which maps the symbol of a cell to the up to three nights that work it, each with its `slug`, `title`, `sector`, `situation` and `story`. The map exists so that the page of a cell can show the nights that already use it — and let a reader open one of them — without reading seventy-five folders; `scenesForCell` in `src/library.mjs` is the read. `library/<slug>/template.json` carries the whole template: the same fields plus `bookSymbol` and `ingredient` on every cell, `operator`, `references`, `prohibition`, `situation`, `story`, `indications`, `request` and `sourceText`.

`situation` is the paragraph the night really opens with: the builder keeps the sentences that state what is happening and drops the ceremonial lines the course repeats in every night (the announcement of the theme, the name written on a threshold, the sector already in progress). It is the field that becomes the premise of a universe created from the template, which is why it must read as the situation and not as a ritual.

The `indications` field carries the [indications](wiki.html#definition-indications) of the night as a list of labelled entries, each with a `label` and a `text`: `Sector`, `Genealogy`, `Prohibition`, `Active cells`, `Situation`, `Central tension`, `Course references` and `Operator`. It is what the book states about the night in the order the book states it, kept as a list so a client can show the world's conditions one by one instead of re-parsing the prose. `request` is the text that lands in the reader's field, written in the order the agent will read it: the title and the night number with its sector and genealogy, an introduction to the operations the world is built from, the operations themselves, the situation at the moment the story opens, and the central tension. Nothing generic is appended to it, so every line of the field can be traced to what the night says. `sourceText` keeps the night as the book writes it, up to about six thousand characters, so a template can be read back against its page. A template slug matches `^[a-z0-9][a-z0-9-]{1,79}$`, which is the pattern `src/library.mjs` validates before it touches the file system.

The cells of a template are cells of the table, so each of them also carries the `prompt` sentence of the table (`A universe where organisms live in degenerate matter.`) and the `ingredient` sentence that names it for a reader (`Neutron Life: a universe where organisms live in degenerate matter (life and evolution, extension).`). The two-letter address of a cell never appears in the composed prose of a universe: `request`, the `Active cells` indication, the composed law, the `Ingredients` section of `canon.md`, the ingredient list of the universe's own `AGENTS.md` and the prompts all write the ingredient sentences, and the symbol stays the address of the cell in the table and the key of the structured data.

### How the library is built from the book

`scripts/build-library.mjs` is the only producer of the library, and it is run with `npm run library`:

```sh
node scripts/build-library.mjs            # rebuild the whole library
node scripts/build-library.mjs --check    # verify the index against the book, write nothing
```

A rebuild reads the PDF through `pdftotext -layout`, which is therefore required for it, splits the text into one block per `NIGHT n`, and turns each block into a template: the sector from the `Memorial sector:` line, the genealogy from the `Genealogy:` line, the active cells from the analytical sentence that names them (resolved against `data/periodic-table.json`, so every cell carries the canonical symbol, its [family](wiki.html#definition-family), its [operator](wiki.html#definition-operator) and its one-line gist), the prohibition, the references, the operator the night is linked to, the situation, the central problem as `story`, the `summary` (the central problem, or the prohibition, or the title), and the `request` text assembled from all of them. A night that carries no situation, no story and no prohibition produces no template.

A rebuild removes only the folders it generates (`night-*`) and writes them again with `index.json`, so an entry that was written by hand stays on disk. The `empty` template is the exception to generation: it is authored by hand in `library/empty/template.json`, is read and never generated, and is always placed first in the index, which is why the count in `index.json` is the number of nights plus one. A rebuild stops with `the hand-authored template is missing: <path>` when that file is absent, instead of writing an index without it. The index is written after the folders, so `index.json` and the folders are produced by the same run and cannot drift.

`--check` writes nothing and compares the index with the book: it reports the number of indexed templates next to the number of templates found in the PDF, and fails with exit status 1 when the two differ or when a cell of the book has no matching symbol in the table. The server-side counterpart is `auditLibrary()` in `src/library.mjs`, which compares the index with the folders on disk and reports the folders missing from the index and the indexed slugs that have no folder.

`data/periodic-table.json`, the table the templates resolve their cells against, is produced the same way by `scripts/build-table.mjs` (`node scripts/build-table.mjs`, with `--check` to compare without writing). It reads the cell tables of the book for the systematic symbols — the family letter followed by the operator letter — and the isotope sections for each cell's name, its one-line mechanism, its literary landmark, the `prompt` and `ingredient` sentences that state the cell as a world, and the family note that the table serves with the family. Both builders need `pdftotext`; neither runs as part of the server, and the library keeps working from the committed data when the PDF tool is absent.

### The empty template

The empty template is the world the reader writes. Its `kind` is `empty`, its `number` is `0`, it has no sector, no genealogy, no cells and no prohibition, and its `request` invites the reader to say what exists in the new world, what sustains life, who holds power, what cannot be done and what is true from the first page. Its summary states the contract of that world: the first request the reader sends becomes its first law, and the story follows from it without exception.

Inside the universe, that promise is implemented rather than declared: when a template is `empty`, has no cells and states no prohibition, `creationFromTemplate` uses the reader's own request text as the law of the new universe (bounded to 2000 characters). A reader who starts from the empty template therefore writes the [fundamental law](wiki.html#definition-fundamental-law) of the book in the same text that opens its first chapter.

### The index and the folder split

The split between `index.json` and one folder per template exists so that listing the library costs one file read. The start screen shows the list whenever a reader has no universe loaded, and reading seventy-five folders to draw it would mean seventy-five file reads on every visit; instead the list is read from `index.json`, which carries the fields the rows show plus the map of which nights work which cell, and `library/<slug>/template.json` is read only when the reader actually picks a template or asks for one of those nights. The request text, the source text and the per-cell mechanisms are therefore absent from the index on purpose, and the index stays a list rather than a copy of the library.

The server applies the same split. `GET /api/library` answers the parsed index (`source`, `note`, `count`, `templates` and `cellScenes`) without touching a folder, and `GET /api/library/:slug` reads one `template.json` and answers it under `template`. Both reads are cached in the process: the index once, the individual templates by slug, so a page that lists the library and opens one template reads two files in total. A slug that does not match the slug pattern is refused with `BAD_TEMPLATE` (status 400) before any path is built, an unknown slug answers `UNKNOWN_TEMPLATE` (status 404), and a missing `library/index.json` answers `NO_LIBRARY` (status 500), because a server without a library can still serve existing universes but can no longer offer a start.

### How a reader starts from a template

The start screen lists the index, the empty template first, and shows for each row its title, its sector, its genealogy, the symbols of its cells and its one-line summary. Choosing a row fetches that template and puts its `request` text into the request field of the composer; nothing is created, nothing is queued and no universe folder appears until the reader sends that text. The reader may edit it, shorten it or replace it entirely, which is the intended behaviour: the template is a starting point, not a form.

Sending it is one request: `POST /api/universes` with `{library: "<slug>", prompt: "<the edited text>", language: "<code>", start: true}`. The server reads the template named by `library`, builds the universe fields with `creationFromTemplate`, and creates the universe. The first chapter request is the reader's edited text; only when that text is empty does the server fall back to the template's own `request`, and only when there is no template text either does it build the structured `firstChapterRequest` from the title, the law, the premise and the [ingredients](wiki.html#definition-ingredient). Errors of that route appear next to the field, and the ones the library itself can produce are `UNKNOWN_TEMPLATE` for a slug that has no folder and `BAD_TEMPLATE` for a malformed one.

The universe keeps no link back to the template it started from. The template contributes fields once, at creation, and is never read again by that universe; editing the library, or rebuilding it from the book, therefore never changes a book that already exists. A template is also not the old proposed-universe catalog: `templates/universes.json` and `templates/parts/*.json` still exist and are served by `GET /api/templates`, but the interface no longer offers them to the reader, and the library replaces them as the starting point of the product.

### What creationFromTemplate composes

`creationFromTemplate(template, { language, prompt, elements })` in `src/library.mjs` returns the fields `createUniverse` accepts — plus the reader's own text as `prompt` — and its decisions are the contract between the book and a new universe. The reader may start from a template and add operations of their own on top of it: the cells of the template are merged with the submitted elements into one list, a duplicate is dropped by its symbol (or, for a proposed element, by its name), the merged list is cut to six, and one law is composed from all of them. That is why the same request may carry `library` and `elements` at once, and why a world can be a night of the book with two more operations added by its reader.

- `law` — the prohibition of the night, written as `Prohibition that holds in this world: …` when the night states one. For the empty template, which states none and has no cells, the reader's own `prompt` becomes the law (bounded to 2000 characters). The ingredient lines are not added here: `createUniverse` composes the final law from this text plus the ingredients, so a law written by the reader is kept first and the operations follow it.
- `elements` — the merged ingredients: the cells of the template in the order the template lists them, followed by whatever elements the reader added, with a duplicate dropped by its symbol or, for a proposed element, by its name, and the whole list cut to six. They are resolved against the table by `createUniverse`, stored in `universe.json` as the ingredients of the book, listed in `canon.md` under `Ingredients`, named in the universe's own `AGENTS.md`, and repeated in every chapter and rewrite prompt.
- `premise` — the situation and the story of the night joined into one text, which is what the first chapter prompt calls the starting situation.
- `summary` — the one-line summary of the template, bounded to 600 characters; the interface shows it under the short title of the book.
- `title` — deliberately empty, together with the template title as `provisionalTitle`. A universe created from a template therefore has `autoTitle: true` and the template title as a provisional name, and [ALA](wiki.html#definition-ala) names the book with a [short name](wiki.html#definition-short-name) after the first chapter, exactly as it does for any unnamed universe.
- `prompt` — the reader's edited text. The server does not read this field back: it queues `prompt` from the body as the first chapter request and falls back to the template's own `request` only when that text is empty.

The consequence is that a template never writes a chapter and never names a book. It supplies the rules the first chapter must respect — one prohibition and the operations the world is a [compound](wiki.html#definition-compound) of — and everything else is produced inside the universe by the ordinary turn pipeline.

### Dependencies and boundary

A rebuild of the library needs `pdftotext` from Poppler and nothing else; serving it needs no external command at all. The runtime code reads JSON with `node:fs/promises` and resolves the table through `src/periodic.mjs`, which is the same module that resolves the ingredients of a universe created from the ingredients tab, so a cell of the library and a cell chosen by hand resolve to the identical object. The library adds no npm dependency and no build step to the server: `library/` is data committed to the repository, and the server works from that data even on a machine where `pdftotext` is not installed.

The boundary is that the library owns starting points, not books. It does not know which universes exist, it does not track which template a universe came from, it does not run an agent, and it does not validate the literary quality of a night: the builder extracts what the book states and refuses to invent what the book does not say. A template whose text is incomplete produces a smaller template rather than a repaired one, and the reader's editor is where the missing rule gets written.
