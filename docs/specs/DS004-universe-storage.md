---
title: DS004-universe-storage
summary: Defines the folder contract for one universe, the fields of every file the server and the agent exchange, the ingredients and the short name of a universe, the version archive, the snapshot mechanism and the older proposed-universe catalog.
---

## Introduction

A [universe](wiki.html#definition-universe) is a folder, and the folder is the product's only durable state. This specification fixes what lives where, which component owns each file, what the server derives instead of storing, and how a book survives a restart. It is the reference for anything that reads or writes a universe, including the two product skills and the print renderer. The queue semantics built on these files are in `DS003-main-behavior`, the agent that writes the agent-owned files in `DS002-model-and-agent-execution`, and the served views of the same data in `DS005-http-api`.

## Core Content

### Repository layout

The repository root holds `package.json` with the `server`, `check`, `catalog` and `library` scripts, `src/` for the Node.js server, `public/` for the static reader, `data/periodic-table.json` for the design instrument, `library/` for the start templates, `templates/universes.json` and `templates/parts/*.json` for the older catalog of proposed universes, `skills/<name>/` for the product skills, `scripts/check.mjs` for the environment and technology-chain check, `scripts/build-library.mjs` and `scripts/build-catalog.mjs` for the data builders, `universes/<id>/` for the books, and `docs/` for the design documentation. Coding rules are in `DS001-coding-style` and dependency records in `dependencies.md`.

`src/paths.mjs` resolves these locations from `import.meta.url`, and the server creates `universes/` at startup when it does not exist. Nothing outside `universes/<id>/` belongs to a book, and no component writes into another universe folder.

### Universe folder

```
universes/<universe-id>/
  universe.json                 server-owned metadata
  universe-title.txt            the name the agent gives an unnamed universe
  charter.md                    permanent narrative rules for the agent
  canon.md                      the world state
  threads.json                  open and closed threads, promises, deferred answers
  atlas.json                    which thematic axes were touched
  AGENTS.md                     working rules for the agent inside this folder
  chapters/NNNN-<slug>.md       one file per chapter
  chapters/NNNN-offer.json      ALA's offer after that chapter
  chapters/.history/NNNN-vK.md  archived earlier versions of a rewritten chapter
  drafts/NNNN-plan.md           the episode plan written before the prose
  turns/NNNN.json               the durable record of one turn
  turns/NNNN.prev/              canon.md, threads.json, atlas.json before that turn
  exports/edition.json          editorial metadata written by the agent
  exports/<slug>-<YYYYMMDD>.pdf printed edition files
  exports/<slug>-<YYYYMMDD>.docx
  .agents/skills/<name>         symlink to ../../../../skills/<name>
```

Ownership is part of the contract. The server writes `universe.json`, `turns/*`, the symlinks and the folder skeleton created at universe creation. The agent writes `canon.md`, `threads.json`, `atlas.json`, `chapters/*`, `drafts/*`, `exports/edition.json` and, while the universe still has no name of its own, `universe-title.txt`, following the workflow required by the prompt and `DS007-scripta-ala-skill`. The print renderer writes only files inside `exports/` and never modifies the book. `charter.md` is created by the server and is meant to be edited by a human or a client that wants different permanent rules; the agent treats it as a constraint.

### Universe identifier and metadata

An identifier matches `^[a-z0-9][a-z0-9-]{2,63}$`. It is derived from the title by `slugify()`, which strips diacritics including the Romanian `ș`, `ț`, `ă`, `â` and `î` forms, lowercases, replaces every other run of characters with a single hyphen, trims hyphens, limits the length and falls back to `universe` when nothing survives. When the resulting folder already exists, the server appends `-2`, `-3` and so on, up to 50 attempts, and answers `ID_TAKEN` when no free identifier is found.

`universe.json` carries `id`, `title`, `autoTitle`, `summary`, `law`, `premise`, `elements`, `status`, `language`, `model`, `createdAt` and `updatedAt`, and the two legacy keys `chapterCount` and `lastChapter` that creation writes as `0` and `null`. The law is trimmed and limited to 4000 characters and must be at least 24 characters long. The premise is optional and limited to 2000 characters. The status is `open` or `closed`; a closed universe can be reopened and returns to `open`. The language is an ISO 639-1 code from the supported list, chosen at creation.

`elements` is the list of [ingredients](wiki.html#definition-ingredient) the reader chose when the book was created: at most six cells of the [Periodic Table of Speculative Ideas](wiki.html#definition-periodic-table), or elements they proposed themselves. Each entry is either a resolved cell — `symbol`, `name`, `family`, `operator`, `gist`, `ingredient` and `custom: false` — or a proposed element with `custom: true`, `symbol: null`, a `name`, an optional `family`, an optional `operator`, a `gist` and a `note`. `ingredient` is the sentence that names the cell for a reader, and it is the form every composed text uses — the stored law, the `Ingredients` section of `canon.md`, the ingredient list of the universe's own `AGENTS.md` and the prompts — while `symbol` stays the address of the cell in the table. They are persisted only here: the server resolves them once through `src/periodic.mjs` before anything is written, composes the law from them, writes the same sentences into `canon.md` and into the universe's `AGENTS.md`, and repeats them in every chapter and rewrite prompt. A universe without ingredients is valid; a reader who chooses none simply states the law by hand.

`summary` is the one-line description of the book, bounded to 600 characters, shown by the reader interface as a discreet line under the title. It is written by creation when the client or a start template supplies one, and it also receives the old descriptive title when a universe with a sentence-like title is renamed while `summary` is still empty: the naming duty replaces such a title with a short name and the sentence is kept as the summary instead of being lost.

The title is optional at creation and is limited to 300 characters. A client that sends a title names the book immediately and `autoTitle` is `false`. A client that sends none gets a universe with a provisional title and `autoTitle: true`, and the book is named by the agent: the prompt carries a naming duty, the agent writes a [short name](wiki.html#definition-short-name) to `universe-title.txt` in the language of the fiction, and after a successful chapter turn the server adopts the first non-empty line only when it has two to seven words and at most 60 characters — a name, not a sentence, with no colon and no final period. It then clears `autoTitle`, keeps the name as the final title and removes the hand-off file, which exists only while the book has no name. A longer line is refused and the duty returns at the next chapter, and a title that is still a whole sentence when a chapter is written is treated the same way, which is how books created before the short-name rule get renamed. The identifier stays based on whatever title existed at creation.

Two fields are derived rather than trusted. The store recomputes the chapter count and the last chapter title from the chapter files on every read, and the public representation exposes them as `chapterCount` and `lastChapterTitle` together with `id`, `title`, `summary`, `autoTitle`, `law`, `premise`, `elements`, `status`, `language`, `model`, `createdAt` and `updatedAt`. The two legacy keys stay in the file but are never read back, so a client never sees a stale count, and the list of universes is sorted by `updatedAt` in descending order, so a book that was just continued appears first.

### Chapters and offers

A chapter file is named `chapters/NNNN-<slug>.md`, where `NNNN` is the chapter number zero-padded to four digits and the slug uses lowercase letters, digits and hyphens. The title is the first line of the file as `# Title`. The accepted Markdown subset is deliberately small and is what the print renderer and the browser renderer both support: level one and level two headings, paragraphs separated by blank lines, blockquotes with `> `, scene separators written as `---`, and `**bold**` or `*italic*` emphasis. Tables, images, code blocks, raw HTML and links are not part of the contract, and the narrative skill's validator rejects them in chapter files. Narrative text, titles, dialogue and place names are written in the language of the book; the schema keys around them stay English.

An [offer](wiki.html#definition-offer) is written as `chapters/NNNN-offer.json` for the same chapter number and holds a `teaser` and an `options` array whose entries have a short `label` and a `prompt`. The store normalizes it on read: the teaser is bounded to 1200 characters, at most four options are kept, an option without a prompt is dropped, a label is bounded to 80 characters and falls back to the first 40 characters of its prompt, and a prompt is bounded to 600 characters. An offer with no teaser and no options is treated as absent, and the same normalized object is exposed on the chapter list item and on a single chapter read.

The plan file `drafts/NNNN-plan.md` is written by the agent before the prose and is not canonical. The narrative skill requires these keys, one per line: `dramatic_question`, `anchor_character`, `character_want`, `primary_idea`, `human_need`, `opening_hook`, `beats`, `decision`, `local_consequence`, `long_horizon`, `payoff`, `return_hook`, `new_entities` and `deferred_answers`.

### Canon, threads and atlas

`canon.md` is the [canon](wiki.html#definition-canon), the world state the agent maintains. Its sections are `## Fundamental laws`, `## Ingredients (from the Periodic Table of Ideas)`, `## World`, `## Recurring characters`, `## Timeline`, `## Stable facts` and `## Mysteries with a fixed cause`. The first section starts as the law text, and the server keeps the translated law block in the prompt so the canon can never contradict it. The ingredients section starts as the ingredient lines of the universe, or as a line saying that no ingredient was chosen yet, and it is the place where the mechanics of the world stay written down. Chapter reads expose only a bounded summary of the canon, not the whole file.

`threads.json` holds four arrays: `open`, `closed`, `promises` and `deferred_answers`. A thread entry carries an `id`, a `kind` from `promise`, `mystery`, `decision` or `question`, the `question` or `promise` text, the chapter that created it, the chapter by which it should pay off, and a `status` from `open`, `deferred`, `closed` or `abandoned`, with the closing chapter and resolution for a closed entry. The server reads this file to list universes, to derive continuation ideas and to expose a thread summary; it never writes it.

`atlas.json` records which thematic axes an episode touched. The shape is a version marker and an `axes` array; each axis has an identifier and a name and contains a `nodes` array whose entries have an `id`, a `label`, the `chapters` that touched them and a `state` from `mentioned`, `dramatized`, `decision` or `recontextualized`. The twelve axis identifiers are `mind-identity`, `life-death`, `time-causality`, `ai-autonomy`, `civilization-power`, `abundance-scarcity`, `alien-alterity`, `reality-simulation`, `body-evolution`, `knowledge-truth`, `cosmos-scale` and `culture-meaning`.

### Turn records and state snapshots

Every [turn](wiki.html#definition-turn) has one durable [record](wiki.html#definition-turn-record) at `turns/NNNN.json`, numbered independently of chapters. The record carries `number`, `kind` (`chapter` or `export`), a `rewrite` flag with the `instructions` when it is a rewrite, `status`, `createdAt`, `startedAt`, `finishedAt`, `durationMs`, the client `request`, the `model`, the requested `format`, the `chapterNumber` and, after success, the `chapterFile` and `chapterTitle`, the agent's `answer`, the composed `agentLog`, the produced `exports` array, the `warnings` array, the normalized `offer`, and `error`. The status is `queued`, `running`, `done`, `error` or `interrupted`.

A turn number is allocated when the request is enqueued, and the record is written with status `queued` before the work starts, which is what makes the queue durable across a restart. Reading turns is exposed as a summary list without the answer and the agent log, and a single turn read returns the full record.

Before each chapter turn the server copies `canon.md`, `threads.json` and `atlas.json` into `turns/NNNN.prev/`. This snapshot is not deleted after a successful turn. It is the state of the world before that chapter existed, and it is what makes a later rewrite of that chapter possible; it is consumed only when `restoreState()` is called, either by a rewrite of that chapter or by the recovery of an interrupted turn, and it is removed then. The deliberate consequence is that the snapshot folder for every chapter remains on disk as the price of rewritable history.

### Version archive and dropped chapters

`archiveChapter()` copies the current text of a [chapter version](wiki.html#definition-chapter-version) to `chapters/.history/NNNN-vK.md`, numbering versions by counting the existing archive entries for that chapter. Archiving happens before a rewrite overwrites the chapter, and also when later chapters are dropped by a confirmed rewrite. The archive is therefore append-only history: the text of every superseded version is recoverable, and a chapter read reports how many archived versions exist.

Dropping later chapters is explicit. `dropChaptersFrom()` removes the chapter and offer files from a given number upwards, and the server calls it only when the client sent `dropLater: true` after a `409 LATER_CHAPTERS` response. Turn records of the dropped chapters are not deleted, so the discussion log of the book stays complete.

### Editorial metadata and editions

`exports/edition.json` is written by the agent before the renderer runs. Its `title` is required and `subtitle`, `author`, `year`, `dedication`, `preface`, `afterword` and `language` are optional; a missing value is completed from `universe.json`, and a missing file is not an error, because the renderer falls back to the universe title. The dedication is set on its own page and the preface and afterword appear in the table of contents.

Edition files are written into `exports/` with the name `<slug>-<YYYYMMDD>.<ext>`, where the slug is the normalized title and the date is the build date. The universe detail lists the editions with their format, size, creation time and download URL, newest first, and the download route accepts only names matching the `.pdf` or `.docx` pattern inside the exports folder of that universe. The renderer's own contract is in `DS008-scripta-book-export-skill`.

### Project skills and per-universe symlinks

The canonical source of a product skill is `skills/<name>/`, discovered by checking for a `SKILL.md` inside each entry of `skills/`. A universe does not copy a skill: `syncUniverseSkills()` creates `.agents/skills/<name>` as a symlink to `../../../../skills/<name>` for every discovered project skill, rewrites a link whose target does not match, and removes a link whose target no longer points at a project skill while leaving real files and directories untouched. The function runs when a universe is created and for every universe at server startup, so a skill added to the repository becomes available inside existing universes after the next restart.

### Proposed-universe catalog

The catalog is the older list of universes a client can start from without writing a law. It is assembled from `templates/universes.json` and from every `templates/parts/*.json` file, merged by template identifier with the first occurrence winning, so the catalog can be split into thematic part files without changing the reader. Each entry carries `id`, `tags`, and localized `title`, `law` and `openings` values keyed by language code, currently `ro` and `en`. Tags are not localized. An entry describes a universe whose law states a single absolute constraint and whose openings give three to four concrete ways for the first chapter to start, each naming who is in the scene, which problem they face and what is at stake. Titles are descriptive: they say what is unique in that universe instead of decorating it, because the title is how a reader chooses between proposals.

`src/templates.mjs` caches the parsed files by their modification stamps and resolves each localized value with the fallback order requested language, then `en`, then `ro`, and drops any entry that has no identifier, title or law, so a partially translated catalog still serves a complete list. The catalog is read-only input for the server. Creating a universe from a proposal copies the chosen title, law and opening into the new book and keeps no link back to the template, so editing the catalog never changes a universe that already exists.

The catalog is no longer the way the product starts a book. The reader interface does not read it at all: a reader starts from the library of start templates specified in `DS009-start-template-library`, which is built from the same book as the design instrument and carries the operations of the world. `GET /api/templates` and the `templateId` field of `POST /api/universes` remain available to API clients, so the catalog is kept and never deleted.

The catalog is data, not code, and its size is not part of the interface: `GET /api/templates` reports a count, and a client reads that count instead of assuming a number. Adding a proposed universe means adding an entry with both languages to an existing catalog file or to a new part file; changing the shape of an entry means updating `src/templates.mjs`, `docs/contracts.md`, the API clients that consume `GET /api/templates` and this specification together.
