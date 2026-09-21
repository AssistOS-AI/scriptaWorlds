---
title: DS000-vision
summary: States what scriptaWorlds is for, who uses it, the principles that shape every other specification, and the boundaries of the product.
---

## Introduction

scriptaWorlds is a place to explore possible universes and to read the story that each one produces. A universe is a persistent science-fiction book defined by one [fundamental law](wiki.html#definition-fundamental-law): the rule about how the world exists, what sustains life, and which constraints can never be broken. That law is built from the project's [design instrument](wiki.html#definition-design-instrument), the [Periodic Table of Speculative Ideas](wiki.html#definition-periodic-table): a reader either starts from a [start template](wiki.html#definition-start-template) that comes with a world already under way, or composes a [compound](wiki.html#definition-compound) of a few [ingredients](wiki.html#definition-ingredient) taken from the table, and the law is what those rules become. A coding agent named ALA writes the chapters inside the universe folder. The whole product is the loop of choosing a world, reading what happened, and deciding what should happen next.

This specification fixes the purpose of the product, the people it serves, the principles that constrain every design decision, and the boundaries that later specifications rely on. Detailed contracts live in the numbered specifications that follow and in `docs/contracts.md`, which remains the reference for exact file formats, HTTP payloads and command-line interfaces.

## Core Content

### Purpose and users

The product serves two kinds of people with one interface. A reader wants a story that responds to what they ask for, without learning any tool: they open the address in a browser, enter a universe, read chapters as pages, and type what should happen next. An operator runs the Node.js server on a machine that has an authenticated coding agent installed, and keeps the universes on disk.

The result of using the product is a folder per universe that contains a complete book: its law, its canon, its chapters, its reading history, its version archive and its printed editions. Nothing that matters lives only in server memory, so an operator can stop the server, copy the folder, restart, and continue reading.

### Product principles

The fundamental law is the identity of a universe. A civilization, a character or a single idea does not define a universe, and neither does one cell of the table on its own: a world is the compound the reader composed, so a world built from two operations is a different world from one built from either of them alone. The law is either written by the reader or composed from the ingredients they chose — the prohibition of a start template first, the lines of the chosen operations after it — and the product rejects creation without either: `POST /api/universes` answers with the error code `BAD_LAW` when the composed law is shorter than 24 characters. The law is copied into `charter.md`, into the first section of `canon.md`, into the universe's own `AGENTS.md`, and into every prompt sent to the agent, and the ingredients are repeated in every chapter and rewrite prompt, so no chapter can quietly contradict the recipe the world was built from.

Every universe is a book, and the reader's position in it is the main navigation. The interface shows one chapter at a time in reading order; work in progress appears as one of the numbered slices of the same reading flow, not as a separate administrative view.

Asking for something is the normal way to continue. A request can be free text or one of the concrete decisions in the offer that ALA writes after each chapter, and every request is accepted and queued instead of being rejected while the universe is busy.

Content language and interface language are separate. The interface, the error messages, the log lines and the schema vocabulary of the files are English. The narrative text, the chapter titles, the offer text and the printed-edition labels are written in the language of the book (`universe.json` → `language`), which is chosen at creation and can be changed through `POST /api/universes/:id/settings`.

The product works with the file system as its only durable state. There is no database, no account system and no session store. `universes/<id>/` is owned jointly: the server writes `universe.json` and `turns/*`, the agent writes `canon.md`, `threads.json`, `atlas.json`, `chapters/*`, `drafts/*` and `exports/edition.json`, and no component writes outside its own share.

The product has no npm dependencies. The server, the static interface, the checks and both skill scripts use only Node.js built-in modules, which keeps installation to a Node.js runtime plus the agent binary. Coding rules are stated in `DS001-coding-style` and dependency records live in `dependencies.md` at the repository root plus one record inside each skill folder.

### Scope

The repository contains the HTTP server and universe store in `src/`, the static reader interface in `public/`, the design instrument in `data/periodic-table.json`, the library of start templates in `library/`, the older proposed-universe catalog in `templates/universes.json`, the two product skills in `skills/`, the check script in `scripts/check.mjs`, and the design documentation under `docs/`.

The product covers: starting a universe from a start template or from chosen ingredients and cataloguing it, queueing and executing agent turns, producing chapters and offers, rewriting chapters with canon rollback, generating printed editions, and serving the reader interface with live progress. The exact storage format is specified in `DS004-universe-storage`, the HTTP surface in `DS005-http-api`, the reader interface in `DS006-reader-interface`, the library in `DS009-start-template-library`, the narrative skill in `DS007-scripta-ala-skill`, and the print renderer in `DS008-scripta-book-export-skill`.

### Boundaries and non-goals

The product does not call a model API directly. It starts the `omp` command-line agent for each turn, and refuses to start at all when that binary cannot be executed (`OMP_MISSING`), because the agent's file tools are part of how a chapter is written. Details are in `DS002-model-and-agent-execution`.

The product has no user accounts and no access control: any client that can reach the listening address can read, create, close, rewrite and export. An operator restricts access by choosing `HOST` or by placing the server behind a reverse proxy.

The repository keeps engineering tooling for agents under `.agents/skills/`. That tooling supports development of this repository, is not part of the product, receives no documentation page and no specification, and is not required to run the server.

A universal catalog of every possible universe, semantic retrieval over the canon, and alternative clients for the same API are outside this contract: the agent reads `canon.md`, `threads.json` and the last chapter files directly from the folder it works in. An extension is added by extending the affected specification rather than by weakening the rules stated here.
