# scriptaWorlds

scriptaWorlds is a place to explore possible universes. A universe is a persistent science-fiction book defined by one [fundamental law](docs/wiki.html#definition-fundamental-law): the rule about how its world exists, what sustains life, and which constraints can never be broken. A reader writes that law or picks one from a [catalog](docs/wiki.html#definition-template-catalog) of proposed universes, and a coding agent named [ALA](docs/wiki.html#definition-ala) writes the chapters inside the folder of that universe. The product exists so that a story can respond to a reader's own decisions without the reader learning a tool: you enter a universe, read what happened, and say what should happen next.

The interface is a reader, not a dashboard. One chapter is shown at a time with the request that produced it above it, ALA speaks at the bottom of the page and offers two or three concrete ways to continue, and work in progress appears where the next chapter will be as a numbered slice that carries the phase of its run, and everything the agent displayed is read in the durable [console](docs/wiki.html#definition-console) of the `ALA sessions` dialog behind the `⋯` menu. Every universe is a folder on disk, so nothing that matters lives only in the memory of the server.

## How it works

A universe starts from its law. A reader picks one of the proposed universes, each of which carries a descriptive title, a law that states one absolute constraint and three or four concrete openings of the story, and can either accept one of those openings or write what should happen first. The law is copied into the charter, into the first section of the canon and into every prompt, and the agent may not break it or introduce another one without a cause already established in the canon. A universe created this way has no title yet: the first chapter names it, and the agent writes that name as one descriptive line saying what is unique about the world it just wrote. The catalog in `templates/universes.json` and `templates/parts/*.json` is data, so proposals are added without changing the server.

Requests are queued per universe. A request never fails because a book is busy: it enters a FIFO queue for that universe, the server records it on disk with the status `queued`, and only then acknowledges it. Each universe runs one turn at a time and different universes run in parallel, so a second reader can write in another book while the first one is being written. Because the queue is on disk, restarting the server resumes waiting turns in order, and a turn that was running becomes `interrupted` with the canon rolled back and the partial chapter removed; it can then be retried with the same request.

Each turn is one headless agent process. The server starts `omp` in the universe folder with the law, the reader's request, the required file names and the language of the book in the prompt, journals everything the agent displayed to `universes/<id>/turns/NNNN.events.jsonl` as the turn runs and streams the same events to the interface, and then verifies the result: a chapter turn must have written exactly one chapter file and must pass the skill's own validator, an export turn must have produced a document that the print skill's own verifier accepts as a PDF or a DOCX, and a chapter outside the expected word band is reported as a warning. That journal is the durable console of the turn: the reader watches it live in the `ALA sessions` dialog, and every run is read back through `GET /api/universes/:id/turns/:number/console` while it runs and after it settled. Before every turn the server publishes a verified snapshot of the accepted book, so a failed or interrupted turn restores its bytes and its membership exactly; a turn whose snapshot cannot be restored blocks the book with `RECOVERY_REQUIRED` instead of writing on top of an unknown state, and a rewrite whose target changed while it waited is refused as stale rather than reinterpreted. The agent is the only writer of the canon, the thread list, the atlas, the chapters and the editorial metadata; the server is the only writer of the universe record, the turn records and the skill links.

Every chapter ends with an [offer](docs/wiki.html#definition-offer). ALA writes a short teaser addressed to the reader plus two or three concrete decisions, each with the exact request it would send. Pressing a decision sends it; editing it puts the same text in the input field. When a chapter has no offer, the server derives continuation ideas from the open threads and promises of the book without running the agent, so a reader always has something concrete to press.

A chapter can be rewritten. The reader says what is wrong and what should change; the current version is archived, the canon is rewound to the state before that chapter, and the agent writes a new version of the same chapter under the same law and the same continuity. When later chapters exist, the server refuses the rewrite until the client confirms that those chapters will be removed, and the confirmation discards them into the same archive rather than deleting them silently.

A book can be printed. An export turn asks the agent to write the editorial metadata and then run the print renderer, which produces a DOCX file, a PDF file or both in the `exports/` folder of the universe, with a title page, a table of contents, page numbering and edition labels in the language of the book. The turn fails when no file appeared, so a reported edition always exists on disk. Downloads are reached from the small menu next to the universe title, never from the reading flow.

## Requirements

- Node.js 20 or later. The server, the check script, the browser interface and the skill scripts use only built-in modules.
- The `omp` command (Oh My Pi, 18.2 or later) available and authenticated for the configured model. The server probes it with `omp --version` before it starts listening and exits with a clear error when it cannot run; set `OMP_BIN` when the binary is installed elsewhere.
- A system serif TrueType font for printed editions (for example Liberation Serif or Noto Serif). The renderer resolves the font before it decides which format to write, so every edition format needs one; without a suitable font it fails with `MISSING_FONT` instead of producing a broken file.

There is no install step and no build step: the runtime has no npm dependencies, and the browser interface is served as plain ES modules.

## Starting the server

```sh
npm run check     # verify Node.js, the agent, the store, the queue, the skills, the edition verifier, the phases and the failure paths
npm run server    # start the API and the reader interface
```

The server listens on `0.0.0.0:8787` by default and prints the loopback address plus every reachable address of the machine, so the book can be opened from a phone on the same network. Open the address in a browser, accept a proposed universe or write the law yourself, and the first chapter is queued immediately. The [check script](docs/wiki.html#definition-check-script) needs no model budget, always removes the temporary universes it creates, and is the fastest way to find out whether a machine can run the product at all.

```sh
PORT=9000 HOST=127.0.0.1 npm run server
```

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `8787` | The listening port. |
| `HOST` | `0.0.0.0` | The address the server binds; set a loopback address for a private instance. |
| `OMP_BIN` | `omp` | The agent binary used by the startup probe and by every turn. |
| `SCRIPTAS_MODEL` | `deepseek/deepseek-v4-flash` | The model used for every turn and recorded in the universe and in each turn. |
| `MAX_CONCURRENT_JOBS` | `0` | Optional global limit on turns running at the same time; `0` means unlimited. Each universe always runs at most one turn. |
| `CHAPTER_TIMEOUT_MS` | `1200000` | Deadline of a chapter or rewrite turn, in milliseconds. |
| `EXPORT_TIMEOUT_MS` | `1200000` | Deadline of an export turn, in milliseconds. |
| `CHAPTER_MIN_WORDS` | `900` | Lower bound of the target chapter length, stated in the prompt and used for warnings. |
| `CHAPTER_MAX_WORDS` | `2400` | Upper bound of the target chapter length. |

Configuration is read once at startup, so a change requires a restart. The effective model, concurrency limit, edition formats, accepted languages and word band are also reported by `GET /api/config`.

## Reading and writing

1. Open the printed address. With no universe selected, the page offers one proposed universe: choose from the catalog of descriptive titles or let the random control pick one, read the law of that world as plain text, and choose one of the three or four openings ALA proposes for the first chapter. The only field you write in is the input at the bottom of the page, where you can either accept the chosen opening or say what should happen first. The language selector sits in the header next to the universe selector; it decides the language of the new book and the language of the proposals, and the browser remembers your choice. The first chapter starts immediately and names the universe when it is finished, and the name appears in the header.
2. Read a chapter. Use the previous and next controls, the position counter and, on a wide screen, the chapter rail. Above each chapter is the request that produced it; below the book, ALA's teaser and its decisions appear, with a free-text field for anything else.
3. Continue the story. Press a decision, or type what should happen next. The request is queued and the running slice shows `Writing chapter N…` and the phase the server last published, and the `ALA sessions` dialog behind the `⋯` menu shows what the agent wrote and the tools it used; when the chapter is finished the page reloads the book.
4. Use the universe selector to switch books. It lists every universe on disk with open ones first, and a closed universe can be reopened from its row.
5. Use the compact menu next to the title for the printed edition. It shows the newest PDF and DOCX download when they exist, a generation action, and the option to close or reopen the universe. Closing a universe opens a panel in which ALA proposes what could still be explored.
6. Rewrite a chapter from the control on its own metadata row: describe what is wrong and what should change. If later chapters exist, the panel states which ones would be removed and asks for confirmation.

## Repository structure

| Path | Role |
| --- | --- |
| `src/` | The server: routing and process lifecycle, HTTP and event-stream helpers, configuration and the agent probe, repository paths and skill links, the proposed-universe catalog, the universe store, and the turn queue with the agent process. |
| `public/` | The static reader interface: one HTML document, the application module, the Markdown renderer and the stylesheet. |
| `templates/` | The catalog of proposed universes: `universes.json` plus optional `parts/*.json` files, localized in Romanian and English, each entry with a descriptive title, a law and several openings. |
| `skills/scripta-ala/` | The narrative skill: the working order, the narrative invariants, the file schemas, the creative palette and the chapter validator. |
| `skills/scripta-book-export/` | The print skill: the dependency-free DOCX and PDF renderer. |
| `skills/scripta-story-design/` | The design skill: the tentative book or arc brief, and its validator. A separate phase, never read while a chapter is written. |
| `skills/scripta-prose-craft/` | The craft skill: focalization, voice, subtext and rhythm, and the validator of the prose profile. A separate phase. |
| `skills/scripta-continuity-review/` | The continuity reviewer: deterministic integrity checks and re-verified semantic annotations over a frozen assessment packet. A separate phase. |
| `skills/scripta-metrics-report/` | The measurement skill: one assessment bundle and the five reports rendered from it. A separate phase. |
| `universes/<id>/` | One folder per book, with its metadata, charter, canon, threads, atlas, chapters, plans, turn records, archives and editions. |
| `scripts/check.mjs` | The environment and technology-chain check run by `npm run check`. |
| `docs/` | The documentation: HTML pages, the specification set under `docs/specs/`, and the internal contract reference `docs/contracts.md`. |
| `vision/` | The narrative specification the ALA rules and the atlas palette were derived from. |

## API

The server exposes JSON routes under `/api` and serves the reader on every other path. The short version:

| Method and path | Effect |
| --- | --- |
| `GET /api/config` | Model, accepted languages, edition formats, concurrency limit and chapter word band. |
| `GET /api/health` | Liveness with the agent, its version, the model and the uptime. |
| `GET /api/templates?language=ro` | The catalog of proposed universes: descriptive title, law and three to four openings, localized. |
| `GET /api/universes` | Every universe on disk, newest change first. |
| `POST /api/universes` | Create a universe from `templateId`, an optional `title`, `law`, `opening`, `prompt`, `language` and `start`; a law is required, and a missing law or opening is completed from the template. A universe created without a title is named by its first chapter. |
| `GET /api/universes/:id` | The reading view: chapters, turns, threads, a canon summary, exports and the jobs in progress. |
| `GET /api/universes/:id/ideas` | Continuation ideas derived from the open threads of the book, without running the agent. |
| `POST /api/universes/:id/turns` | Queue a chapter or an export turn. It waits in that universe's queue instead of being refused while the universe is busy; a chapter turn for a closed universe is the one exception and answers `409 CLOSED`. |
| `POST /api/universes/:id/chapters/:number/rewrite` | Rewrite a chapter, with `dropLater` to confirm discarding later chapters. |
| `POST /api/universes/:id/turns/:number/retry` | Restart an interrupted or failed turn with the same request. |
| `POST /api/universes/:id/close`, `/open`, `/settings` | Close, reopen and change the language of a universe. |
| `GET /api/universes/:id/events` | Server-sent events for the live progress of every turn of the universe. |
| `GET /api/universes/:id/chapters/:number`, `/turns/:number` | One chapter with its Markdown, and one full turn record with the agent log. |
| `GET /api/universes/:id/turns/:number/console` | The durable console of one run: `{turn, console:{text, live, updatedAt, source}}`, readable while the run writes and after it settled. |
| `GET /api/files/:id/:name` | Download a produced DOCX or PDF edition. |

Failures are JSON objects with a stable code and an English message, for example `BAD_LAW`, `CLOSED`, `LATER_CHAPTERS`, `NOT_RETRYABLE`, `OMP_MISSING` or `NO_CHAPTER`. The API has no authentication: anyone who can reach the address can read and continue every universe, so an operator restricts access with `HOST` or a reverse proxy.

## Documentation

- `docs/index.html` is the entry point: what the product is, how the parts fit together and the documentation map.
- `docs/architecture.html` follows one request from the reader to the written chapter, and records which component writes which file.
- `docs/operations.html` covers requirements, configuration, the environment check, restarts and the failure codes an operator meets.
- `docs/api.html` documents every route, the error envelope and the live event stream.
- `docs/reader-interface.html` documents the browser reader: reading flow, exploration, composer, live activity, rewrite, closing and editions.
- `docs/scripta-ala-skill.html` and `docs/scripta-book-export-skill.html` document the two skills that write a book; `docs/scripta-story-design-skill.html`, `docs/scripta-prose-craft-skill.html`, `docs/scripta-continuity-review-skill.html` and `docs/scripta-metrics-report-skill.html` document the four separate-phase skills.
- `docs/specs/` holds the numbered design specifications; `docs/specs/matrix.md` lists them and each one opens through `docs/specsLoader.html`.
- `docs/wiki.html` is the canonical terminology page, and `docs/contracts.md` is the internal reference for file formats, HTTP payloads and the renderer command line.

## Boundaries

The product does not call a model API directly: it runs the `omp` command, and it needs that binary to continue a book. It has no user accounts and no per-universe access control. It does not translate existing text: the language of a book is chosen before its first chapter and is fixed once a chapter exists, and the labels of a printed edition can differ from the language of its prose. Semantic retrieval over the canon is not part of the contract, because the agent reads the canon, the threads and the last chapters directly from the folder it works in. The engineering tooling installed for coding agents under `.agents/skills/` supports development of this repository and is not part of the product or of its runtime.
