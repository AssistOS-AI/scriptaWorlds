# scriptaWorlds: internal contracts (v1)

Coordination document. Every component (server, reader interface, skills, renderer) follows exactly these formats. Any change here obliges an update of all consumers.

## 1. Vocabulary

- **Universe** = one book. Its own folder, its own canon, its own chapters.
- **Chapter (episode)** = one narrative unit written by the ALA agent inside the universe folder.
- **Turn** = one client request plus the agent execution that produced a chapter or an edition.
- **Edition (export)** = a DOCX or PDF produced from the chapters of a universe.
- **Offer** = the teaser and the concrete decisions ALA writes for the reader after a chapter.
- **Job** = the in-memory handle of a turn while the server process is running.

## 2. Disk layout

```
scriptaWorlds/
  package.json                    # "npm run server" starts the server, "npm run check" verifies the environment
  src/                            # server and store (Node.js ESM, no external dependencies)
  public/                         # static reader interface (index.html, app.js bootstrap, markdown.js, ui/**, styles/**)
  templates/universes.json        # catalog of proposed universes, localized
  templates/parts/*.json          # additional catalog files, merged by id
  skills/<name>/SKILL.md          # product skills (canonical source, real folders)
  scripts/check.mjs               # environment and technology-chain check
  scripts/check-store.mjs         # its store, queue, rewrite and export group
  scripts/check-data.mjs          # its design-instrument data-contract group
  universes/<universe-id>/        # one folder per universe
  docs/                           # design documentation and specifications
```

### 2.1 The folder of one universe

```
universes/<universe-id>/
  universe.json           # metadata (see 2.2); written by the server
  universe-title.txt      # the name ALA gives the universe when it has none; written by the agent
  charter.md              # permanent rules for ALA (editable by a client)
  canon.md                # the canonical state of the world (maintained by the agent)
  threads.json            # open and closed threads, promises, deferred answers (maintained by the agent)
  atlas.json              # which thematic axes were touched (maintained by the agent)
  AGENTS.md               # permanent instructions for the agent running in this folder
  chapters/NNNN-slug.md   # chapters; NNNN = 4 digits, zero padded; slug = [a-z0-9-]
  chapters/NNNN-offer.json      # ALA's offer after that chapter
  chapters/.history/NNNN-vK.md  # previous versions of a rewritten chapter
  drafts/NNNN-plan.md     # the episode plan, written before the prose (not canonical)
  turns/NNNN.json         # the durable record of each turn (see 2.4)
  turns/NNNN.prev/        # full copy of the accepted book before that turn: canon, threads, atlas and every accepted chapter plus its offer
  exports/edition.json    # editorial metadata written by the agent (see 2.5)
  exports/*.docx|*.pdf    # the produced editions
  .agents/skills/<name>   # symlink to ../../../../skills/<name>
```

`<universe-id>`: `[a-z0-9][a-z0-9-]{2,63}`, unique, derived from the title at creation (for example `arhiva-cenusii`).

Project-level data, outside the universes: `data/periodic-table.json` — the Periodic Table of Speculative Ideas extracted from `vision/periodic_table.pdf` (twelve families, fifteen operators, one hundred and eighty cells). It is the design instrument a new universe is composed from; `src/periodic.mjs` reads it, serves it through `GET /api/table` and resolves the reader's ingredient selection.

### 2.2 `universe.json`

```json
{
  "id": "arhiva-cenusii",
  "title": "The Ash Archive",
  "autoTitle": false,
  "law": "Every thinking being consumes the light of another being; the stars are fed by forgetting, and those who remember too much extinguish the sky.",
  "premise": "An empire reads only books written by vanished civilizations.",
  "elements": [
    { "symbol": "CA", "name": "Alternative Gravity", "family": "COSMOS", "operator": "ALTERATION",
      "gist": "gravity changes anatomy, architecture, and culture", "custom": false }
  ],
  "status": "open",
  "language": "en",
  "model": "deepseek/deepseek-v4-flash",
  "createdAt": "2026-09-21T15:00:00.000Z",
  "updatedAt": "2026-09-21T15:20:00.000Z",
  "chapterCount": 3,
  "lastChapter": { "number": 3, "title": "The Blind Librarian" }
}
```

`title` is the name of the book and is limited to 300 characters when a client sends it. A client may omit it: the universe is then created with a provisional title and `autoTitle: true`, and the first successful chapter names it, because the agent writes a **short name** to `universe-title.txt` and the server adopts it after the turn. An adopted name must have two to seven words and at most 60 characters; a longer descriptive line is refused, `autoTitle` becomes `false`, the previous sentence (or the provisional title, when it is a sentence) moves to `summary`, and `universe-title.txt` is removed.

`elements` are the **ingredients**: cells of the Periodic Table of Ideas the reader chose when the book was created, at most six, each either a cell of the table (`symbol`, `name`, `family`, `operator`, `gist`) or an element the reader proposed (`custom: true`, with `name`, optional `family` and `operator`, and a `note`). They are resolved by `src/periodic.mjs` before anything is written, they are listed in `canon.md` under `Ingredients` and they are repeated in every chapter prompt.

`law` is the **fundamental law of the universe** at the metaphysical level: how the world exists, what sustains life, which constraints are absolute (physics, magic, debt, hunger, time, memory). It is composed from the ingredients (`composeLaw`): a law written by the client comes first, the ingredient lines follow it. A universe is refused with `BAD_LAW` when neither a law nor an ingredient is sent; the composed law must be at least 24 characters long and is limited to 4000 characters. When a client creates a universe from a proposed universe without sending a law, the law of that template is used. The law is copied into `charter.md`, into the first section of `canon.md` and into every prompt, and the agent derives consequences from it without ever breaking it. `premise` is the starting situation, optional, limited to 2000 characters; when a client creates a universe from a proposed universe without sending an opening, the first proposed opening of that template is used. A civilization, a character or a single idea does not define a universe; the law does.

`status` ∈ `open` | `closed`. `closed` means the universe is concluded; it can be reopened and returns to `open`. A chapter turn for a closed universe is refused with `CLOSED`; export turns are still accepted.

`language` is the language of the **fiction** of the book (lowercase ISO 639-1 code), chosen at creation and changeable through `POST /api/universes/:id/settings` only while the book has no chapters; once a chapter exists the language is fixed and a change is refused with `LANGUAGE_LOCKED`. A change before that rewrites the guidance the server generated (`universe.json`, the universe's own `AGENTS.md` and the generated language line of `charter.md`) so permanent instructions never contradict the book. The accepted list comes from `GET /api/config`. Schema vocabulary (folder names, plan keys, canon sections, JSON fields, thread kinds and statuses, atlas axes and node states) stays English regardless of the language of the book; only narrative text and edition labels are localized.

`chapterCount` and `lastChapter` are derived and rewritten by the server on every scan.

### 2.3 Chapters: `chapters/NNNN-slug.md`

Every accepted chapter has its `chapters/NNNN-offer.json` beside it — the reader's decisions after that chapter — and a chapter whose offer is missing or unusable is refused by the validator, so the turn fails with `INVALID_CHAPTER`.

Plain Markdown. The title is mandatory on the first line as `# Title`. Content accepted by both renderers: `#`/`##` headings, paragraphs separated by a blank line, `> ` quotes, `---` scene separators, `**bold**` / `*italic*` emphasis. No tables, images, code, HTML or links. Narrative text is written in the language of the book.

### 2.4 Turns: `turns/NNNN.json`

```json
{
  "number": 4,
  "kind": "chapter",
  "rewrite": false,
  "instructions": null,
  "dropLater": null,
  "ancestryTurn": null,
  "targetSha256": null,
  "authorizedLaterChapters": null,
  "status": "done",
  "createdAt": "2026-09-21T15:20:00.000Z",
  "startedAt": "2026-09-21T15:20:01.000Z",
  "finishedAt": "2026-09-21T15:24:10.000Z",
  "durationMs": 249000,
  "request": "What happens if I make death optional?",
  "model": "deepseek/deepseek-v4-flash",
  "format": "both",
  "chapterNumber": 4,
  "chapterFile": "chapters/0004-the-voice-of-the-council.md",
  "chapterTitle": "The Voice of the Council",
  "context": { "version": "sha256:9f2c…", "chapters": ["chapters/0003-a.md", "chapters/0004-b.md"], "omittedChapters": [1, 2] },
  "sourceChapter": 3,
  "findings": [{ "id": "continuity.integrity.3", "claim": "…", "evidence": ["…"] }],
  "preserve": ["the flat voice of the keeper"],
  "findingsVersion": "sha256:9f2c…",
  "answer": "the final text of the agent, without the tool log",
  "agentLog": "the complete log: the prompt sent, the tools used, the text of the agent",
  "exports": [],
  "warnings": [],
  "offer": { "teaser": "…", "options": [{ "label": "…", "prompt": "…" }] },
  "error": null
}
```

`kind` ∈ `chapter` | `import` | `export` (a `rewrite` is a `chapter` turn with `rewrite: true`). An `import` turn carries no chapter number: it covers a window of the imported book's extraction chapters, `chapterTitle` records that window and the universe chapters it wrote, and its completion is verified by the import skill's validator rather than by the chapter validator. `status` ∈ `queued` | `running` | `done` | `error` | `interrupted` | `recovery_required`. A turn whose snapshot could not be restored becomes `recovery_required`: the book then refuses every new turn with `RECOVERY_REQUIRED` until the accepted state is established by hand, and a retry is refused while the snapshot stays unusable. `rewrite` is `true` for a rewrite turn and `instructions` then carries the reader's complaint. `dropLater` is `true` when the rewrite also removes later chapters; `ancestryTurn` is the turn whose snapshot holds the state that preceded the rewritten chapter, which stays fixed through successive rewrites of that chapter; `targetSha256` is the hash of the chapter the request was written for; `authorizedLaterChapters` lists the later chapters that existed when the request was made. All three are `null` for an ordinary chapter turn. A queued rewrite is revalidated against the book when it reaches the front of its queue, and a target that changed, or a later chapter that appeared without authorisation, fails as `STALE_REQUEST` instead of being reinterpreted. `warnings` collects non-fatal observations such as a chapter outside the configured word band, an option label that is long, or a thread whose due date stays far ahead. `sourceChapter` records the chapter the reader was reading when the request was sent; `findings`, `preserve` and `findingsVersion` carry the revision an author asked for and the version its evidence came from, which is not always the chapter the turn writes. `context` records what the turn was written from: the content identity of the accepted version it selected, the chapter files it named for the agent to read, and the earlier chapters it left out. It is `null` for an export turn. `directions` carries the [approved directions](wiki.html#definition-approved-direction) the request was sent with, and `approval` names where they were accepted (the path and hash of the approval record and the accepted version it was written against), so a chapter can always be traced back to the decision it followed.

### 2.5 `exports/edition.json` (written by the agent before running the renderer)

```json
{
  "title": "The Ash Archive",
  "subtitle": "Three episodes about a library that survives its readers",
  "author": "scriptaWorlds · ALA",
  "year": 2026,
  "dedication": "For those who read to the last shelf.",
  "preface": "## Preface\n\nText…",
  "afterword": "## Afterword\n\nText…",
  "language": "en"
}
```

All fields except `title` are optional; missing values are completed from `universe.json`.

### 2.6 `threads.json` and `atlas.json`

```json
{
  "open": [{ "id": "thread-0001", "kind": "mystery", "question": "…", "created_chapter": 1, "due_chapter": 4, "status": "open" }],
  "closed": [{ "id": "thread-0002", "kind": "promise", "question": "…", "created_chapter": 1, "closed_chapter": 3, "status": "closed", "resolution": "…" }],
  "promises": [{ "id": "promise-0001", "promise": "…", "created_chapter": 2, "due_chapter": 5, "status": "open" }],
  "deferred_answers": [{ "id": "answer-0001", "question": "…", "reason": "…", "asked_chapter": 2, "due_chapter": 4 }]
}
```

`kind` ∈ `promise` | `mystery` | `decision` | `question`. `status` ∈ `open` | `deferred` | `closed` | `abandoned`.

```json
{
  "version": 1,
  "axes": [
    {
      "id": "mind-identity",
      "name": "Mind and identity",
      "nodes": [{ "id": "memory-editing", "label": "Editable memory", "state": "dramatized", "chapters": [3] }]
    }
  ]
}
```

Node `state` ∈ `mentioned` | `dramatized` | `decision` | `recontextualized`. The twelve axis identifiers are `mind-identity`, `life-death`, `time-causality`, `ai-autonomy`, `civilization-power`, `abundance-scarcity`, `alien-alterity`, `reality-simulation`, `body-evolution`, `knowledge-truth`, `cosmos-scale` and `culture-meaning`.

## 3. CLI contract of the book renderer

It lives in the `scripta-book-export` skill:

```
node skills/scripta-book-export/scripts/build-book.mjs \
  --universe <universe-folder> [--out <folder>] [--format both|docx|pdf] [--fonts <folder>] [--language <code>]
```

- `--out` defaults to `<universe-folder>/exports`.
- `--language` is resolved in this exact order: the flag itself when given, then `language` in `exports/edition.json`, then `language` in `universe.json`, then `ro`. Edition labels are localized: table of contents, default preface and afterword headings, the "Chapter N" label and the title page. Romanian and English are required; any other code uses the English labels. Chapter text is never translated.
- File names: `<slug>-<YYYYMMDD>.pdf` / `.docx`, where `slug` is the title normalized to `[a-z0-9-]` with diacritics transliterated.
- Output: ONE single JSON line on stdout, at the end, in both cases:

```json
{"ok":true,"title":"The Ash Archive","chapters":3,"words":7412,
 "source_version":"sha256:9f2c…","manifest":"exports/edition-manifest.json",
 "outputs":[{"format":"pdf","path":"/abs/...pdf","bytes":812345,"pages":96,"sha256":"…"},
            {"format":"docx","path":"/abs/...docx","bytes":38412,"pages":null,"sha256":"…"}]}
```

```json
{"ok":false,"error":"clear message","code":"MISSING_FONT"}
```

- Exit code `0` on success, `2` on a usage error, `1` on a processing error. Error codes: `USAGE`, `MISSING_UNIVERSE`, `NO_CHAPTERS`, `MISSING_FONT`, `BAD_JSON`, `IO_ERROR`, `EDITION_CHANGED`, `INTERNAL`.
- A run renders one consistent version: the accepted content identity of the chapters it renders is computed before the model is read, and a chapter that changes during the render is refused with `EDITION_CHANGED` instead of being recorded as a version that was not rendered.
- No npm dependencies. Node.js built-ins only. System fonts. Every used face — regular, bold, italic and bold-italic — must cover every character it is asked to set, and a missing glyph fails the run with `MISSING_FONT` rather than being replaced.

### 3.1 `exports/edition-manifest.json`

The renderer writes this record after the documents verify and before it answers, atomically (a temporary file then one rename), so a manifest never describes files that do not exist:

```jsonc
{
  "schema_version": "edition-manifest.v1",
  "universe_id": "arhiva-cenusii",
  "generated_at": "2026-09-22T16:40:00.000Z",
  "format": "both",
  "language": "en",
  "source_version": "sha256:9f2c…",     // §8.2 over chapter, offer, canon, threads and atlas
  "documents": [
    { "format": "pdf", "path": "arhiva-cenusii-20260922.pdf", "bytes": 812345, "pages": 96, "sha256": "…" },
    { "format": "docx", "path": "arhiva-cenusii-20260922.docx", "bytes": 38412, "pages": null, "sha256": "…" }
  ]
}
```

Paths are relative to the folder that holds the manifest. The manifest is what makes a later review possible: an edition whose `source_version` no longer matches the current accepted version is reported as historical rather than mistaken for the current book.

### 3.2 Server acceptance: `verify-edition.mjs`

The server never accepts an edition because a file exists. It runs the skill's verifier, which reads the manifest, re-opens every document and writes nothing:

```
node skills/scripta-book-export/scripts/verify-edition.mjs \
  --universe <universe-folder> [--format both|docx|pdf] [--since <epoch-ms>] [--fonts <folder>] [--language <code>]
```

It prints one JSON line, `{"schema_version":"edition-verification.v1","ok":…,"errors":[…],"warnings":[…],"documents":[{…}]}`, and exits `0` only when `ok` is true. A PDF must open as a document (header, `startxref`, trailer, at least one page); a DOCX must be a valid archive whose `[Content_Types].xml`, `word/document.xml` and relationship part parse and whose declared relationships resolve. `--since` restricts the run to files written at or after that time. Error codes: `NO_EXPORT` (a requested format produced no file), `MISSING_MANIFEST`, `INVALID_MANIFEST`, `INVALID_EXPORT`, `DUPLICATE_CHAPTER`, `MISSING_FONT`, `USAGE`, `MISSING_UNIVERSE`; `HISTORICAL_EDITION` is a warning. The server maps a pure `NO_EXPORT` answer to its own `NO_EXPORT` and every other refusal to `INVALID_EXPORT`, and copies the warnings onto the turn record.
- PDF: table of contents with correct page numbers, title on a separate page, footer page numbering, bookmarks, correct Romanian diacritics, selectable text (`ToUnicode`).
- DOCX: `Title`/`Heading1`/`Normal`/`Quote` styles, table of contents as a real `TOC \o "1-1" \h \z \u` field, with a visible cached result (titles and page numbers computed by the layout engine).

## 4. HTTP API (JSON, UTF-8)

Server: `node src/server.mjs`, by default on `0.0.0.0:8787` (override with `HOST` and `PORT`). Errors: `{"error":{"code":"NOT_FOUND","message":"..."}}` with the matching HTTP status (400 invalid request, 404 missing, 405 wrong method, 409 conflict or refused state, 413 body too large, 500 internal, 502 failed agent run). An error may carry additional machine-readable fields next to `code` and `message`, currently `laterChapters` on `LATER_CHAPTERS` and `details` when a handler attaches them.

### 4.1 Universes

| Method | Route | Effect |
| --- | --- | --- |
| GET | `/api/config` | `{"model":"…","languages":[{"code":"ro","label":"Română"},…],"formats":["docx","pdf","both"],"maxConcurrentJobs":null,"chapterWords":{"min":900,"max":2400}}` |
| GET | `/api/health` | `{"ok":true,"omp":"omp","ompVersion":"…","model":"…","maxConcurrentJobs":null,"uptimeMs":123456}` |
| GET | `/api/templates?language=ro` | `{"templates":[{"id":"…","tags":["…"],"title":"…","law":"…","openings":["…"]}],"count":N}`: the catalog of proposed universes, localized (fallback `en`, then `ro`). `openings` holds three to four concrete openings of the story (who, which problem, what is at stake) |
| GET | `/api/table` | `{"families":[{"name":"COSMOS","label":"COSMOS","letter":"C","cells":["CA",…]}…12],"operators":[{"name":"ALTERATION","does":"…","letter":"A"}…15],"elements":[{"id":"01.01","symbol":"CA","bookSymbol":"Cg","name":"Alternative Gravity","family":"COSMOS","operator":"ALTERATION","gist":"…","prompt":"A universe where gravity changes anatomy, architecture, and culture.","landmark":"Stephen Baxter — Raft"}…180]}`: the Periodic Table of Speculative Ideas (`data/periodic-table.json`), small enough to load at once |
| GET | `/api/table/cells/:symbol` | `{"cell":{"id","symbol","bookSymbol","name","family","familyLabel","operator","operatorDoes","gist","prompt","landmark","sections":{"Nucleus":"…","Genealogy":"…","Periodic position":"…","Propagation":"…","Instability":"…","Compounds":"…"}}}`: everything the book says about one cell, read only when a reader opens it; unknown symbol → `404 UNKNOWN_ELEMENT` |
| GET | `/api/library` | `{"source":"…","note":"…","count":75,"templates":[{"slug":"empty","kind":"empty","number":0,"title":"…","sector":"…","genealogy":[…],"cells":[{"symbol":"LE","name":"…","family":"LIFE","operator":"EXTENSION"}],"summary":"…"},…]}`: the index of start templates, empty template first (see §7) |
| GET | `/api/library/:slug` | `{"template":{…,"prohibition":"…","situation":"…","story":"…","indications":[{"label":"Sector","text":"…"},…],"request":"…","sourceText":"…"}}`; unknown slug → `404 UNKNOWN_TEMPLATE`, malformed slug → `400 BAD_TEMPLATE` |
| GET | `/api/universes` | list: `{"universes":[Universe...]}` sorted descending by `updatedAt` |
| POST | `/api/universes` | body `{"library":"night-08-…","elements":["CA",{"custom":true,…}],"templateId":"…","title":"…","law":"…","premise":"…","opening":"…","prompt":"…","language":"ro","start":true}` → `201 {"universe":Universe,"job":Job\|null}`. With `library` the universe is built from that template of §7 (law from its prohibition and cells, premise from its situation and central problem, provisional title from its title, `autoTitle: true`); with `elements` the law is composed from the chosen cells and any element the reader proposed. The first chapter request is `prompt` (the text the reader edited), then the template's own `request`, then the structured `firstChapterRequest`. `title` is optional; when it is missing the universe gets a provisional title and `autoTitle: true`, and the first chapter names it. A missing `law` is filled from the template named by `templateId`, a missing `opening` from that template's first opening, and a missing `prompt` from the opening; a law shorter than one sentence is `BAD_LAW`. With `start: true` the server immediately queues the first chapter |
| GET | `/api/universes/:id` | `{"universe":Universe,"chapters":[Chapter...],"turns":[TurnSummary...],"threads":{...},"canon":{"summary":"..."},"exports":[ExportFile...],"activeJob":Job\|null,"queuedJobs":[Job...]}` |
| GET | `/api/universes/:id/ideas` | `{"ideas":[{"label":"...","prompt":"...","source":"promise\|thread\|deferred\|latest\|timejump"}]}`: concrete suggestions derived from the open threads and the last chapter, without an agent |
| POST | `/api/universes/:id/close` | `{"universe":Universe}` (status `closed`) |
| POST | `/api/universes/:id/open` | `{"universe":Universe}` (status `open`) |
| POST | `/api/universes/:id/settings` | body `{"language":"en"}` → `{"universe":Universe}`; an empty body answers the current record |
| POST | `/api/universes/:id/chapters/:number/rewrite` | body `{"instructions":"what is wrong and what should change","dropLater":false,"findings":[{"id":"continuity.integrity.3","claim":"…","evidence":["…"]}],"preserve":["the flat voice of the keeper"],"sourceVersion":"sha256:…"}` → `202 {"job":Job,"droppedChapters":[3,4]}`. The handler only validates and enqueues; the rewrite itself runs under the per-universe execution lock and archives the old text and offer, drops later chapters and restores the pre-chapter state before the agent runs. The old version is archived in `chapters/.history/`. When later chapters exist and `dropLater` is not `true` → `409 {"error":{"code":"LATER_CHAPTERS","message":"…","laterChapters":[3,4]}}` |
| POST | `/api/universes/:id/turns/:number/retry` | restarts an `interrupted` or `error` turn with the same request → `202 {"job":Job}`; any other status → `409 NOT_RETRYABLE` |

```jsonc
// Universe
{"id":"arhiva-cenusii","title":"The Ash Archive","autoTitle":false,"law":"…","status":"open","premise":"…","language":"en",
 "summary":"…","elements":[{"symbol":"CA","name":"Alternative Gravity","family":"COSMOS","operator":"ALTERATION","gist":"…","custom":false}],
 "model":"deepseek/deepseek-v4-flash","createdAt":"…","updatedAt":"…",
 "chapterCount":3,"lastChapterTitle":"The Blind Librarian"}

// Chapter (as returned by GET /api/universes/:id)
{"number":3,"slug":"the-blind-librarian","title":"The Blind Librarian",
 "createdAt":"…","words":1840,"bytes":10231,"turnNumber":4,
 "offer":{"teaser":"…","options":[{"label":"…","prompt":"…"}]}}   // or null

// Chapter (as returned by GET /api/universes/:id/chapters/:number) adds:
{"rewritten":true,"versions":2,"markdown":"# Title\n\n…"}

// TurnSummary
{"number":3,"kind":"chapter","status":"done","createdAt":"…","durationMs":211000,
 "request":"…","chapterNumber":3,"chapterTitle":"The Blind Librarian","error":null,"exports":[]}

// ExportFile
{"name":"the-ash-archive-20260921.pdf","format":"pdf","bytes":812345,"createdAt":"…",
 "url":"/api/files/arhiva-cenusii/the-ash-archive-20260921.pdf"}
```

`turnNumber` on a chapter is the turn that produced it, or `null` when no turn records it; after a rewrite the newest turn for that chapter wins.

### 4.2 Content

| Method | Route | Response |
| --- | --- | --- |
| GET | `/api/universes/:id/chapters/:number` | `{"chapter":{...,"markdown":"# Title\n\n…"}}` |
| GET | `/api/universes/:id/turns/:number` | `{"turn":{...,"agentLog":"…","answer":"…"}}`: `:number` is the **turn** number, not the chapter number; the mapping is `chapters[].turnNumber` |
| GET | `/api/files/:id/:name` | the file from `exports/` (attachment, `application/pdf` or DOCX); the name must match `[A-Za-z0-9._-]+\.(pdf\|docx)`, otherwise `400 BAD_NAME` |

### 4.3 Jobs (chapter and edition generation)

`POST /api/universes/:id/turns`

```jsonc
// body
{"message":"Continue the story","kind":"chapter"}
{"message":"Continue the story","kind":"chapter","sourceChapter":3}
{"message":"Continue the story","kind":"chapter","directions":["Keep the voice flat in the aftermath."],
 "approval":{"path":"assessments/<id>/<version>/<run>/approval.json","sha256":"…","version":"sha256:…"}}
{"message":"Generate the printed edition","kind":"export","format":"both"} // format ∈ docx|pdf|both
```

- `findings` and `preserve` are optional: they carry the findings an author chose from an external review (at most eight, each with the stable identifier the review published, e.g. `continuity.integrity.3`, an optional claim and up to three evidence quotes) and up to six qualities the revision must keep. A malformed list answers `400 BAD_FINDINGS`. When `sourceVersion` is given with findings, the request is refused with `409 STALE_REQUEST` if the accepted version has moved on, so a revision never acts on evidence from another book state. The revision is one candidate pass: the prompt states the findings, their evidence and the qualities to preserve, and asks for a single new version.
- `sourceChapter` is optional and names the accepted chapter the reader was looking at when the request was sent; a number that is not an accepted chapter answers `400 BAD_NUMBER` before anything is queued. Sending from an older chapter continues the book from its accepted end rather than changing what is on screen; the interface says so and points at the rewrite route.
- `directions` is optional and carries at most eight short instructions (400 characters each) that a separate design or craft phase produced and a human accepted; `approval` names where they were accepted. A malformed list answers `400 BAD_DIRECTIONS` before anything is queued, and an empty list is the same as sending none.
- Response `202 {"job":Job}`: **always accepted**, even when the universe already has turns in progress: requests enter a FIFO queue per universe and start in order. There is no `409 BUSY`. A chapter turn for a closed universe is the one exception and answers `409 CLOSED`.
- `GET /api/jobs/:jobId` → `{"job":Job}`. Jobs live as long as the server process; the durable state is in `turns/NNNN.json`. A job identifier created by a new turn is a random `j_<hex>`; a retried turn reuses `<universeId>#<turnNumber>`.
- `GET /api/universes/:id/events[?job=<jobId>]` → `text/event-stream`. Without `job` the stream covers **all** turns of the universe (the ones running now and the ones started later), and every event carries `jobId`. With `job` it covers that job only and validates that it belongs to the universe. One `data: <json>` event per line:

```jsonc
{"type":"job","job":Job}
{"type":"phase","phase":"agent","text":"ALA is writing chapter 4"}
{"type":"delta","text":"a fragment of the agent text"}
{"type":"tool","state":"start","name":"read","detail":"chapters/0003-…md"}
{"type":"tool","state":"end","name":"write","detail":"chapters/0004-…md","ok":true}
{"type":"done","job":Job}
{"type":"error","message":"…","job":Job}
{"type":"refresh","universeId":"arhiva-cenusii","jobId":"j_7f3a91"}
```

`refresh` is emitted on the universe stream after a turn finished, so a client can reload the universe. At most 800 events are buffered per job.

```jsonc
// Job
{"id":"j_7f3a91","universeId":"arhiva-cenusii","kind":"chapter","format":"both","status":"running",
 "createdAt":"…","startedAt":"…","finishedAt":null,"turnNumber":4,"chapterNumber":4,
 "request":"…","queuePosition":0,
 "result":{"chapterNumber":4,"chapterTitle":"The Voice of the Council","exports":[],"warnings":[],"offer":{…},"durationMs":211000},
 "error":null}
```

`status` ∈ `queued` | `running` | `done` | `error` | `interrupted`. `chapterNumber` is the chapter the job writes: the target of a rewrite as soon as it is queued, and the next chapter number once a chapter turn starts running; it is `null` for an export job. `queuePosition` is the position inside that universe's queue for a waiting job and `0` otherwise. There is no implicit ceiling on simultaneous jobs: each universe has at most one `running` turn (the rest wait in its queue), while different universes run in parallel. `MAX_CONCURRENT_JOBS` can cap the server globally when set explicitly (`0` or unset means unlimited).

**Durability.** The queue does not live only in memory:

- on `POST /turns` the server immediately writes `turns/NNNN.json` with `status: "queued"` and the request;
- when the job starts, the record becomes `running`;
- when the server stops, `queued` turns are resumed automatically on the next start (same request, same order), while `running` turns become `interrupted` with the canon rolled back to the last accepted state and can be resumed manually through `POST /turns/:number/retry`;
- reloading the page loses nothing: `GET /api/universes/:id` lists `activeJob` and `queuedJobs`, and the event stream resumes for any job still in progress.

## 5. Agent execution rules

- One turn = one separate headless `omp` instance, started by the server in the universe folder: `omp -p --mode json --no-session --no-title --auto-approve --model <model> --cwd <universe> --max-time <seconds>`, with the prompt written to stdin (never as a shell argument).
- The prompt sent by the server contains: the kind of the turn, the client request, the chapter number, the file to write, the constraints (resources, words), the **language of the fiction** (`language` in `universe.json`) and the reference to `skill://scripta-ala` or `skill://scripta-book-export`. Narrative text is written in the language of the book; schema vocabulary (plan keys, file names, canon sections, JSON fields) stays English, and the agent's final report to the system is in English.
- The agent is the only writer of `canon.md`, `threads.json`, `atlas.json`, `chapters/*`, `drafts/*`, `exports/edition.json` and, while the universe still has no name, `universe-title.txt`. The server writes only `universe.json`, `turns/*` and the symlinks.
- While `universe.json` still has `autoTitle: true` — or while the displayed title is still a whole sentence (more than seven words, for example an older descriptive auto-title) — the prompt adds a naming duty: after the chapter the agent writes a **short name** to `universe-title.txt` in the language of the fiction: 2–7 words, at most 60 characters, no final period, no metaphor, not a sentence. A long descriptive line is refused. After a successful turn the server adopts the first valid name, clears `autoTitle`, deletes `universe-title.txt` and, when the previous title or the template description was a whole sentence, keeps it as `summary`; the interface shows `summary` as a discreet line under the short title.
- Before every chapter or rewrite turn the server copies the whole accepted book — `canon.md`, `threads.json`, `atlas.json`, every accepted chapter and its offer — into `turns/NNNN.prev/`. The snapshot is kept after a successful turn because a later rewrite of that chapter needs it; it is consumed only when a restore happens, for a rewrite or for the recovery of an interrupted turn, and it is retained so a restore is repeatable.
- After the run the server verifies the result at the boundary: the chapter file must exist (`NO_CHAPTER`) and be unique (`DUPLICATE_CHAPTER`), the skill's own validator must pass (`INVALID_CHAPTER`), an export must have produced one non-empty valid file for every requested format (`NO_EXPORT`, `INVALID_EXPORT`), and a failed, timed-out or unstarted agent is `AGENT_FAILED`. A rewrite that has no pre-chapter snapshot is refused with `NO_SNAPSHOT`. On failure the accepted book is restored, partial chapter files are deleted and the turn record is stored with status `error`, keeping the agent's narration tail.

## 6. Reader interface: the living book (v3)

The principle: **the interface is the story**. The user does not administer a panel; they read, and ALA talks to them and proposes what could happen next. The interface is in **English**; the content of the book stays in the language of the universe.

### 6.1 Simplicity rules (mandatory)

- No dashboard, no statistics panels, no technical badges inside the flow (duration, model, turn numbers). Anything that does not help reading stays out of the flow.
- **Nothing unfolds in the flow.** Every secondary layer is a **dialog**: a fixed overlay drawn above the page, with a dimmed backdrop, a visible `×`, closed on `Esc`, on a click on the backdrop and through the `×`; it is centred on the screen on both axes, it never takes layout space and it never pushes the content. The dialogs are `Universes`, `Edition` (the `⋯` button), `What you asked for` (the `i` link of a chapter) and `Rewrite chapter`.
- Reading is never a dialog: a chapter always occupies the page. Under the header the only content is the chapter itself.
- The edition (DOCX/PDF) is a **discreet feature**: it has no button of its own in the header and never appears as a slice in the flow. It is reached from the `Edition` dialog.
- The carousel walks **only chapters**, in the order of the book (1…N). Editions are not slices; a turn that is running or queued is a numbered slice, carrying the number of the chapter it will write.

### 6.2 Structure

1. **Sticky header**, two short rows, with English labels:
   - row 1: the **short** universe title with a discreet line underneath (`universe.summary`, falling back to `premise`, one line, ellipsis); on the right the `Universes` button and a compact `⋯` button (disabled while no universe is loaded);
   - row 2 (book navigation): `‹` followed by one number per slice and then `›`. The numbers are the chapters of the book plus the turns that are running or queued, each carrying the number it will write and marked as in progress; after the numbers, the label of the current slice and the position indicator `6/11`.
2. **`Universes` dialog** (opened from the header button): the universes on disk, most recently updated first, each with its short title, language and chapter count. Clicking one loads it and closes the dialog. The exploration panel of §6.3 lives in the flow, not in this dialog.
3. **`Edition` dialog** (the `⋯` button): `Download PDF` and `Download DOCX` (shown as `not yet` and disabled until the edition exists), `Generate edition`, a separator and `New universe`, which returns to the exploration panel of §6.3. There is no `Close`/`Reopen` in the interface; `POST /api/universes/:id/close` and `/open` remain available as API calls only.
4. **The flow**: one slice per chapter, in chronological order. A chapter slice contains the chapter and nothing else:
   - the head: `Chapter N · Title`, with the short links `i`, `Rewrite` and `Console` on the same row;
   - `i` opens the `What you asked for` dialog with the request of the turn that wrote that chapter;
   - `Console` unfolds the agent log of that turn inside the card, collapsed by default;
   - `Rewrite` opens the `Rewrite chapter` dialog (`POST /api/universes/:id/chapters/:number/rewrite`);
   - the chapter as a book page: title plus rendered text, serif, justified;
   - `running`/`queued` turns appear as their own numbered slice with a live line (`Writing chapter 5…`, `Waiting (1 in queue)`); `interrupted`/`error` appear with `Retry`.
   The reader's request is never rendered inside a chapter slice; it is read from the `i` dialog.
5. **Composer** (bottom, sticky): a single card containing
   - ALA's voice for the current chapter: the `teaser` from `chapters/NNNN-offer.json`, clamped to two lines with an inline `more`/`less` when it is longer;
   - up to three compact links with the decisions from `offer.options`: clicking one **fills** the field with its `prompt`, it does not send it;
   - the request field (`What do you want to happen next?`) with the `Send` button on the same row.
   If a chapter has no `offer`, the area shows the input field plus a suggestion derived from `GET /api/universes/:id/ideas`.

### 6.3 First contact: writing a world, or starting from a template

The product is not a text editor: it is the **exploration of possible universes**, and a universe is not a prompt — it is a **compound** (see §7) of operations taken from the Periodic Table of Speculative Ideas.

When no current universe is set, the flow shows the **start screen** with three tabs:

1. **`Custom`** — one large field and one `Start` control, and the tab that is open first. The text written there is the specification of a new universe; `Start` validates it (at least one sentence), sends `POST /api/universes` with `{prompt, language, start: true}`, no template and no ingredient, so the text becomes the fundamental law of the new world, and the first chapter is queued from the same text. A refusal appears under that field without clearing it.
2. **`Library`** — the start templates read from the book (`GET /api/library`): the empty template first, then the seventy-four nights, each shown with its title, sector, genealogy, cell symbols and the one-line summary of the problem it puts at the centre. Choosing a template (`GET /api/library/:slug`) puts its `request` text into the request field of the composer; nothing is created yet.
3. **`Ingredients`** — the table itself (`GET /api/table`): twelve families as rows, fifteen operators as columns, one cell per symbol, with search, a legend of the operators, at most six choices and the possibility of proposing an element the table does not contain. Every change composes the request text in the field below.

For a world that is already open the **input of the interface is the request field**: the reader edits the text a template put there, or the text the chosen ingredients composed, and sends it with `Send`. The **language of the fiction is chosen in the header** (from `GET /api/config`, remembered in `localStorage`), together with the `Universes` dialog and the `Edition` dialog; the start screen itself holds no selector and no title field.

Creating a universe is one request built from what the reader sent:

- from a template: `POST /api/universes` with `{library, prompt, language, start: true}`, where `prompt` is the edited text of the request field;
- from ingredients: `POST /api/universes` with `{elements, prompt, language, start: true}`;
- from text alone: `POST /api/universes` with `{prompt, language, start: true}`, where the request the reader wrote becomes the law of the new world, the same composition the empty start template produces.

The server composes the universe from it (`creationFromTemplate` or `composeLaw`): the law from the template's prohibition plus the operations it is built from, from the chosen operations, or from the reader's own text when neither was given; the starting situation from the template; the title left empty so ALA names the book after the first chapter, exactly as for any unnamed universe. The first chapter request is the reader's own edited text; the template's own `request` is the fallback, and the structured `firstChapterRequest` the last resort. Errors (`BAD_LAW`, `UNKNOWN_TEMPLATE`, `BAD_ELEMENTS`, `UNKNOWN_ELEMENT`, `BAD_ELEMENT_FAMILY`, `BAD_ELEMENT_OPERATOR`) appear next to the field.

The ingredients travel with the book: they are stored in `universe.json` (`elements`), listed in `canon.md` under `Ingredients`, named in `AGENTS.md`, sent to the agent in `firstChapterRequest` and repeated in every chapter and rewrite prompt, so the recipe — not a summary of it — defines what the world can do.

### 6.4 Selecting a universe

The `Universes` button in the header opens the dialog described in §6.2: the universes on disk, most recently updated first, each with short title, language and chapter count, closed universes grouped at the end under `Closed`. Clicking one loads it and closes the dialog. The dialog never opens by itself.

### 6.5 Closing a universe (API only)

The interface does not expose closing: `New universe` in the `Edition` dialog returns to the exploration panel instead. `POST /api/universes/:id/close`, `POST /api/universes/:id/open` and `GET /api/universes/:id/ideas` stay available for API clients; the continuation ideas are still used by the composer when a chapter has no `offer` file.

### 6.6 Technical structure and language

- A single document, no build step, no CDN: `index.html` loads `app.js` as a module, which imports `markdown.js` and the modules under `ui/**`; the six style sheets under `styles/**` are linked directly from the page, in the order base, reader, live, explore, composer, overlays.
- The current universe and the reading position are kept in `localStorage` (`scriptaWorlds.currentUniverse`, `scriptaWorlds.currentChapter.<universe>`) and mirrored into the URL query.
- SSE: `GET /api/universes/:id/events` (without `job`) for all turns of the universe; on `done` the universe is reloaded and, when a new chapter appeared while the reader was elsewhere in the book, a discreet button `New chapter ready — read it` is shown without pulling the reader out of the current page. When the stream cannot be kept open, the client falls back to a per-job stream plus polling of `GET /api/jobs/:id`.
- Interface texts in English; narrative texts in the language of the book.

## 7. The library of start templates

`library/` holds the worlds a reader can start from. They are not invented by the server: they are read from `vision/periodic_table.pdf`, whose nights each open a memorial sector, state a prohibition, put one central problem in front of the children and name the cells of the Table that are active in it — a world with rules and a story already under way.

- `library/index.json` — one entry per template (slug, kind, number, title, sector, genealogy, cell symbols, summary). The start screen lists this file only, so the list loads without reading seventy-five folders. The first entry is the empty template.
- `library/<slug>/template.json` — the template itself: `slug`, `kind` (`night` or `empty`), `number`, `title`, `sector`, `genealogy`, `cells` (book symbol, name, canonical symbol, family, operator, gist), `operator`, `references`, `prohibition`, `situation`, `story`, `summary`, `request` (the text that lands in the reader's field, with nothing generic added), `indications` (the same material as a labelled list: sector, genealogy, prohibition, active cells, situation, central tension, course references, operator) and `sourceText` (the night as the book writes it, up to six thousand characters).
- `scripts/build-library.mjs` rebuilds the whole library from the PDF (`npm run library`); `node scripts/build-library.mjs --check` compares the index with the folders and the book without writing anything. `pdftotext` is required for a rebuild. The index also carries `cellScenes`: for every cell, up to three nights that work it, so a cell can be opened from the table with the scenes that use it. Each night's `situation` is a real paragraph of that night, not the ceremony lines the book repeats (the theme, the threshold, the memorial).
- The `empty` template is written by hand: a world with no fixed law, where the first request the reader sends becomes the first law.

`src/library.mjs` reads the index, reads one template and turns it into the fields `createUniverse` accepts (`creationFromTemplate`): the law from the prohibition, the premise from the situation and the central problem, the cells of the template **plus** the ingredients the reader added on top (deduplicated, at most six), and no title, because ALA names the book after the first chapter. The empty template has no prohibition and no cells, so the request the reader sends becomes the first law of that world.

`scripts/build-table.mjs` rebuilds `data/periodic-table.json` from the same PDF (`node scripts/build-table.mjs`, `--check` to compare without writing): it reads the cell tables for the systematic symbols and the isotope sections for the names, the one-line mechanisms, the landmarks and the prose, and writes the `prompt` line of every cell ("A universe where …").

## 8. The separate design and review phases

Two phases exist beside the writing turn, and they own different artifacts.

| Phase | Who runs it | Reads | Writes |
| --- | --- | --- | --- |
| **Writing** | one ALA turn (`scripta-ala`, `scripta-book-export`) | `universe.json`, `charter.md`, the accepted canon, threads, atlas, the last accepted chapters, the reader request | `canon.md`, `threads.json`, `atlas.json`, `chapters/*`, `drafts/NNNN-plan.md`, `exports/edition.json` |
| **Design and review** | a separate session, by hand or by the host, using `scripta-story-design`, `scripta-prose-craft`, `scripta-continuity-review`, `scripta-metrics-report` | a frozen packet of one accepted version | only files inside the external workspace, never a universe |

The rules of the separation are absolute. A writing turn never invokes a design or review skill and never reads its output; the chapter prompt names `scripta-ala` (and `scripta-book-export` for an edition) and nothing else. A design or review phase never writes into `universes/`, never mutates the packet it reads, and never changes the accepted version. The two halves meet only through an explicit, human-approved transfer (§8.4) that a later writing request carries as input.

### 8.1 The external workspace

Design and review artifacts live outside the universe, under a workspace root that the operator chooses and states explicitly on every command line:

```
<workspace>/<universe-id>/<accepted-version>/<run-id>/
  input/          the frozen packet: manifest.json plus the referenced files at their relative paths
  proposal/       what a design or craft phase proposes (story-design.json, prose-profile.json)
  approval.json   the human decision on a proposal: approved, declined, reviewer, timestamp
  result/         the published result of a review (continuity-result.json, assessment.json, the views)
  run.json        the run record: phase, skill, profile hash, status, timestamps, errors
```

`<universe-id>` is the identifier of the universe the version was captured from. `<accepted-version>` is the content identity defined in §8.2, with `:` replaced by `-` so it is usable as a directory name. `<run-id>` is `<YYYYMMDDTHHMMSS>-<phase>-<4 random hex>`, unique inside that version. Nothing in this layout is required by the skills' command lines — they take explicit `--input` and `--out` paths, so a standalone user may supply any authorized equivalent workspace — but the host uses this layout, and a result written here is never confused with narrative state.

`proposal/` is a proposal and never evidence: a planned event, an arc destination or a voice change recorded there is not part of the book until an accepted chapter shows it, and a proposal that contradicts the accepted version is reported as stale rather than applied.

### 8.2 The accepted version

An accepted version is the narrative content of a universe at one moment, identified by its content rather than by its folder or by a timestamp.

`accepted_version = "sha256:" + sha256hex(entries)`, where each entry is `` `${path}\t${sha256}\t${bytes}\n` `` for every file whose role is `chapter`, `offer`, `canon`, `threads` or `atlas`, sorted by `path` in byte order. Only those roles take part: `meta` (`universe.json`) is excluded because the server rewrites it on every turn, and `design`, `profile`, `annotations`, `corpus`, `rules` and `timing` are inputs to an assessment rather than accepted narrative content. Two versions of the same universe therefore have different identities whenever their chapters or state differ, and the same identity whenever they do not.

A packet captured while a turn is running is not an accepted version. The host captures a packet either from a stable accepted book, meaning no turn of that universe is running or queued, or from the immutable snapshot of a finished turn (`turns/NNNN.prev/`, which is a full copy of the accepted book). A packet whose state does not match an accepted version is refused by the consumers with a structured error rather than reviewed.

### 8.3 The assessment packet (`assessment-input.v2`)

`manifest.json` at the root of `input/` describes the frozen version:

```jsonc
{
  "schema_version": "assessment-input.v2",
  "universe_id": "arhiva-cenusii",
  "version": "sha256:9f2c…",          // §8.2, recomputed by every consumer
  "captured_at": "2026-09-22T16:40:00.000Z",
  "book": { "title": "The Ash Archive", "language": "en", "last_accepted_chapter": 3 },
  "scope": {
    "kind": "complete",               // complete | partial | textual_only
    "chapters": [1, 2, 3],            // the chapter numbers this packet contains
    "omitted": [],                    // declared omissions, required when kind is not complete
    "note": "…"
  },
  "files": [
    { "path": "chapters/0001-x.md", "sha256": "…", "bytes": 1234, "role": "chapter", "artifact_id": "chapter-0001", "chapter": 1 },
    { "path": "canon.md", "sha256": "…", "bytes": 512, "role": "canon", "artifact_id": "canon" }
  ]
}
```

Roles are `chapter`, `offer`, `canon`, `threads`, `atlas`, `meta`, `design`, `profile`, `annotations`, `corpus`, `rules` and `timing`. A `chapter` entry carries its `chapter` number and the artifact identifier `chapter-NNNN`; an `offer` entry carries `offer-NNNN`; the state roles carry `canon`, `threads`, `atlas` and `meta`. Every declared path is relative, uses forward slashes, stays inside `input/` after symlinks are resolved, and matches its declared `sha256` and `bytes`.

What a consumer must reject, in the same way and with the same codes as every other consumer, is: a missing or unreadable manifest; an unknown `schema_version`; a duplicate `path` or `artifact_id`; a path that is absolute, contains `..`, or escapes `input/` after resolution; a missing file; a byte count or hash that does not match; a `version` that does not equal the recomputed §8.2 identity; a `role` outside the vocabulary above; a file whose bytes are not valid UTF-8; and a `scope.kind` of `complete` that omits an interior chapter or a required role.

The rejection codes are fixed, so a host can act on a refused packet without knowing which skill produced the answer. Every consumer returns one of these, with a human-readable message and the offending path where there is one: `MISSING_CONTEXT` (no packet was supplied), `MISSING_MANIFEST`, `BAD_JSON`, `INVALID_MANIFEST`, `SCHEMA_VERSION`, `PATH_ESCAPE`, `DUPLICATE_PATH`, `DUPLICATE_ARTIFACT_ID`, `DUPLICATE_CHAPTER`, `MISSING_FILE`, `BYTE_MISMATCH`, `HASH_MISMATCH`, `VERSION_MISMATCH`, `ROLE_UNDECLARED`, `INVALID_ENCODING`, `SCOPE_INCOMPLETE` and `SCOPE_INCONSISTENT`. A skill may add codes for its own concerns — a missing profile, an unsupported language, an unwritable result directory — but it never renames a shared code, and it never reports the same case under two names.

`scope.kind` is the declared honesty of the packet. `complete` requires every chapter from 1 to `last_accepted_chapter` and the state roles `canon`, `threads` and `atlas`. `partial` declares the chapters it contains in `scope.chapters` and lists the rest in `scope.omitted`; a missing interior chapter is then a declared omission rather than an error, and the coverage note of every result names what was left out. `textual_only` contains chapter prose and no state containers: it exists for a review of language and craft alone, and the continuity and metrics reports state that no continuity context was available instead of implying a clean book.

### 8.4 Approval and transfer

An approval record is the only bridge between a phase and a later writing request. It carries the proposal's path and hash, the accepted version it was written against, a decision of `approved` or `declined`, the reviewer, the timestamp and the concrete directions that were accepted. The host records it with `POST /api/universes/:id/approvals` (body `{"proposal":{…}|"path","decision":"approved|declined","reviewer":"…","directions":["…"],"version":"sha256:…"}` → `201 {"approval":Approval}`), keeps it at `<workspace>/<universe-id>/<version>/approvals/approval-<proposal-hash>.json`, and lists it with `GET /api/universes/:id/approvals`. A proposal written against another version answers `409 STALE_REQUEST`; a second decision on the same proposal and version answers `409 ALREADY_DECIDED`, because an approval that could be quietly rewritten is not a decision; a declined proposal carrying directions answers `400 BAD_DECISION`; a missing proposal answers `400 BAD_PROPOSAL`. A later writing request carries the approved directions as input data of that request; it does not ask ALA to read a skill or a handbook during the chapter.

Staleness is checked by hash: a proposal written against a version that is no longer accepted, or an approval whose proposal changed, cannot be applied silently. Declined directions stay declined and are not re-proposed. A host that lists findings for revision carries their stable finding IDs and evidence with the version they came from (§8.2), so a rewrite that changes that version makes the earlier result historical rather than current.

### 8.5 Requested and arc-end assessments

The host freezes a packet (§8.3) and runs one phase over it, in the workspace of §8.1, outside the book:

| Route | What it does |
| --- | --- |
| `POST /api/universes/:id/assessments` | body `{"phase":"continuity|metrics","mode":"generic|deterministic|supplied","profile":{…},"annotations":{…},"corpus":{"manifest":{…},"files":{"<path>":"<text>"}},"fromTurn":4,"force":false,"scope":{"kind":"book|chapter","chapters":[1,2]},"aggregate":false,"intention":"…","weights":{"cs":0.4,"oi":0.3,"emotional_fit":0.3}}` → `202 {"run":Run}`. A metrics review without a `profile` uses the host's generic profile, and without `annotations` it asks the configured evaluator for them, so ordinary requests need no hand-authored JSON |
| `GET /api/universes/:id/assessments` | the runs of that book, newest first, plus the arc events |
| `GET /api/universes/:id/assessments/:runId` | one run, with `historical: true` when its version is no longer the accepted one |
| `GET /api/universes/:id/assessments/:runId/report/:file` | one published file of that run: `assessment.json`, `index.md` or one of the five views, served only for a name the run itself lists in `outputs`, and only as a plain file name |
| `POST /api/universes/:id/assessments/:runId` | body `{"action":"cancel"}` → the run is cancelled and a settled one answers `NOT_CANCELLABLE`; `{"action":"retry"}` → the same frozen packet runs again |
| `POST /api/universes/:id/arc-events` | body `{"arcId":"arc-ledger","note":"…","profile":{…}}` → `202 {"event":Event,"run":Run|null}` |
| `GET /api/universes/:id/arc-events` | the declared arc-completion events |

`mode` decides who produces the semantic observations — the judgements a model can make about the text: `supplied` means the caller brought an `annotations` document, `generic` (the operator default, set by `ASSESSMENT_MODE=generic|deterministic`) means the host asks the configured evaluator, and `deterministic` means nobody does, so those results stay unavailable with their reason. Supplied annotations and a generated mode are mutually exclusive and answer `400 BAD_MODE`, as does an unknown mode. In `generic` mode the host writes the prompt from the vocabulary the report skill publishes at `skills/scripta-metrics-report/schema/annotations.v1.json`, runs `OMP_BIN` once in the run workspace with the model from `SCRIPTAS_MODEL`, and validates the answer itself before the phase sees it: the schema version, the source version, evidence that resolves to exact bytes in the frozen packet, and bounds on every field. A rejected answer gets exactly one repair call whose prompt names the fields that failed. The answer is read out of whatever the evaluator said: a document wrapped in prose, fenced, or followed by further chatter is taken (the host scans for the balanced object rather than trusting the first and last brace), while an answer that begins a document and stops before closing it is recorded as `truncated` — the repair call then asks for a smaller document — and an answer with no document at all is recorded as `no-object`. The prompt states the bounds the host enforces (items, segments, findings, quote length and total size) so that an answer is not cut off by the evaluator's own output limit. The document it accepts is stored at `generated/annotations.json` beside the run and passed to the phase by absolute path, so the frozen packet keeps exactly the bytes the review was asked about and `packet_intact` records whether it still hashes to them. The model work happens **inside the run, not inside the request**: `POST /api/universes/:id/assessments` captures the packet, writes the run record and answers at once with the run `queued` (or already `running`), and the annotation stage runs before the phase, so a caller never holds an HTTP request open for the two minutes an evaluator may take and the interface can show the run's state from the first moment. A model that answers with no usable document ends the run as an `error` whose message begins `annotation stage:` — the record keeps every attempt, its exit code, its answer length and the validation errors, and no phase runs and no file is published, instead of a report whose judgements are missing. A retry of such a run, or of a run whose phase failed after the observations were accepted, reuses the accepted document and does not pay for another reading. The metrics phase itself never calls a model.

The inputs a phase declares are frozen into the packet and passed to it explicitly: `annotations` to both phases, a `corpus` to the metrics phase, a `profile` to the metrics phase. An input a phase does not consume answers `400 UNSUPPORTED_INPUT` instead of being ignored. A declared corpus must arrive with the text of every reference it names — captured beside its manifest, so the review can read what it compares — and a manifest without that text answers `400 MISSING_RESOURCE`; a supplied text whose bytes do not match the hash its reference declares answers `400 HASH_MISMATCH` before any phase runs. The packet's own inventory lists the declared files; the corpus reference texts travel beside the manifest, which is the artifact of role `corpus` and declares each text's hash, recomputed by the review.

A run is identified by a fingerprint (`input_fingerprint`) over the phase, the accepted version, the resolved scope, the trigger and its arc, the mode that produced its observations, the profile hash, the annotation hash, the corpus manifest hash and the hash of every captured resource. Two requests with the same fingerprint are the same assessment and the second returns the first with `deduplicated: true`; requests are created under a per-universe lock so simultaneous identical ones converge on one record; a record written before fingerprints existed carries none and is never treated as a duplicate. The host says `requested|arc` and the report bundle says `request|arc`; the mapping is explicit here and in the run record.

A packet is captured only from a **stable accepted version**: a turn of that universe that is queued or running makes the capture fail with `409 UNSTABLE_VERSION`, and the caller either waits or captures from the immutable snapshot of a finished turn with `fromTurn`. The metrics phase needs a `profile` (`NO_PROFILE` without one), an unknown phase answers `BAD_PHASE`, an unknown arc identifier answers `BAD_ARC`, and an unknown action answers `BAD_ACTION`.

`run.json` is the durable record of one run: `run_id` (independent of turn and chapter numbering), `universe_id`, `phase`, `trigger` (`requested` or `arc`), `arc_id`, `version`, `scope`, `requested_scope`, `profile_source` (`supplied`, `generic` or `none`), `profile_sha256`, `annotation_mode`, `annotation_model`, `annotation_prompt_version`, `annotation_attempts` (one entry per call with the exit code, the validation errors, the child's stderr and how many characters came back), `annotation_errors`, `generated_annotations`, `packet_intact`, `inputs`, `resources`, `annotations_sha256`, `corpus_manifest_sha256`, `input_fingerprint`, `status` (`queued`, `running`, `done`, `error`, `cancelled`, `interrupted`), timestamps, `exit_code`, `error`, `outputs`, `attempts` and the captured `envelope`. A run that ends with a nonzero exit is `error` and names the reason the phase printed; a run that was still `queued` when the process stopped resumes at the next start with the same `run_id`, and one that was `running` becomes `interrupted` and is retried over the same frozen packet. No run ever writes inside `universes/`, so a failed assessment cannot roll back a chapter.

Two runs are the same assessment when `phase`, `version`, `profile_sha256`, the presence of annotations and `arc_id` all match; a second request returns that run with `deduplicated: true` instead of reviewing one version twice. Findings an author selects travel into one later rewrite as input data of that request (§4.3) together with the version they were reported against, so stale evidence is refused instead of applied and the revision stays a single candidate pass.

An **arc-completion event** is a record, not a plan: it names the arc identifier and the accepted version it was declared against, and it is written outside the universe. A `completed` flag inside a design proposal stays a proposal; only this event starts the assessment its profile implies.

### 8.6 Book import

A book that was not written here enters the same store through the import pipeline. The upload is stored in the workspace of §8.1 rather than in `universes/`, its text is extracted without a model, and the universe it becomes is written by an import turn, so an imported book can afterwards be reviewed, analysed, rewritten chapter by chapter and exported exactly like a written one.

| Route | What it does |
| --- | --- |
| `POST /api/imports` | the body is the file itself (`application/octet-stream`), with its name in the `X-Filename` header and optionally `X-format: pdf|docx`; the bytes are streamed to the workspace while they are hashed and counted, and a body larger than `IMPORT_MAX_BYTES` (64 MiB unless the environment says otherwise) is refused during the transfer with `413 IMPORT_TOO_LARGE`. Answers `202 {"import":Import}` |
| `GET /api/imports` | the imports, newest first, with the size limit the deployment accepts |
| `GET /api/imports/:id` | one import with its progress: how many of the book's chapters are in the store, which window the next turn will carry, and whether the import is complete |
| `POST /api/imports/:id/extract` | starts the extraction in the background and answers `202 {"import":Import}`; the reader follows the record's `state` instead of holding a request open |
| `POST /api/imports/:id/universe` | creates the universe of a ready import, or continues an import that already has one, and queues the next import turn. The body may carry `title` and `language`; answers `202 {"universe":…,"turn":…,"range":…,"progress":…}` with `turn: null` when every extraction chapter is imported or skipped |

An import record is `book-import.v1`: `import_id` (a timestamp and four hex digits), `filename`, `format` (`pdf`, `docx` or `null` when the extension says neither), `sha256`, `bytes`, `state` (`received`, `extracting`, `ready` or `error`), `source` (the file inside the workspace), `created_at`, `extracted_at`, `universe_id`, `detected` (`title`, `author`, `language`), `chapters` (number, title, words per chapter), `words`, `warnings` and `error`. The record's `detected.title_source` says whether the title was read out of the file (`file`) or taken from the name the reader uploaded (`filename`), so a reader is never told that a file named itself when it did not. Creating or continuing an import in a universe that is closed answers `409 CLOSED`, like every other turn that would write into it. A record that fails extraction keeps the reason in `error` and answers `410 IMPORT_MISSING` when its file is gone, `409 NOT_EXTRACTED` when a later step asks for an extraction that never succeeded, and the extractor's own codes — `IMPORT_UNSUPPORTED`, `IMPORT_EMPTY`, `IMPORT_UNREADABLE`, `IMPORT_NO_TEXT` for a PDF with no text layer — are what the reader sees on the record.

One turn carries a bounded part of the book: the import skill publishes that bound in `skills/scripta-import/schema/import.v1.json` (`turn_limits`), and the host plans the window with it — at most `max_chapters` extraction chapters and at most `max_words` of their prose, always at least one chapter, so a single long chapter travels alone. Where the import continues is recorded in `drafts/import-progress.json` inside the universe, written by the import turn and authoritative over the chapters on disk: a chapter file does not carry the number of the extraction chapter it came from, so the store alone cannot say what has been imported. The host reads that record's `next_source_chapter`, plans the next window from it, and reports the import as complete when it is `null`. Each finished turn is verified by the skill's own validator — `node skills/scripta-import/scripts/validate-import.mjs --universe <universe> --import <extracted.json> --chapters <from>-<to>` — which checks the chapters of that window against the extraction they came from, the state files the import wrote, and the record that claims them.

The extraction itself is `book-import.v1` too and is written beside the upload as `extracted.json`, with `book.md` as its readable twin: `source` (filename, format, sha256, bytes, pages), `detected`, `chapters` (number, title, words, text — paragraphs separated by blank lines, headings kept out of the text) and `warnings`. Chapters are segmented at the boundaries the file itself shows — a DOCX heading style, or a short standalone heading line in a PDF — and a book whose boundaries cannot be detected arrives as one chapter with a warning that says so, because the segmentation of that book is then a judgement the import turn makes and declares rather than one the extractor invents. Extracting the same file twice yields the same text, which is what the import turn, the review and a later rewrite all read.

### 8.7 Reader feedback

Team readers say what they think of a book, and what they say is stored beside the reviews rather than inside the book: it is about a version of the text, it belongs to the people who read it, and it must survive every retry, rewrite and re-import of the store.

**Where it lives.** The workspace of §8.1, under the universe it is about:

```
<workspace>/<universe-id>/feedback/
  targets/<target-id>/target.json      the immutable reading context, `reader-feedback-target.v1`
  targets/<target-id>/text/<file>       the frozen text that was displayed, byte for byte
  entries/<feedback-id>/feedback.json   one reader's response, `reader-feedback.v1`
  readers/<reader-id>.json              one reader identity, `reader-identity.v1`
```

Only directories whose name matches a frozen version (`sha256-…`) are run records of an assessment; `feedback/` is never enumerated as one, so a file written here can never be mistaken for a review.

**A target** is a book (or an arc, or a chapter) as one reader saw it, frozen when the reader opened the form, and it is the only thing the text of a response is anchored to. `target.json` carries `schema_version` (`reader-feedback-target.v1`), `target_id`, `universe_id`, `source_version` (the accepted version the reader was shown), `scope` (`kind`, `chapters`), `language`, `created_at`, `displayed` (`hash` of the text bundle, `files` with their `path`, `sha256` and `bytes`), `chapters` (number, title, `sha256` of each chapter file as displayed), optional `run_id` and `finding_ids` of a report the reader was looking at, and `context` (`note`, `display`). A target is written once and never rewritten; a second session against the same version and scope returns the same target instead of a new one. The frozen text is what makes a response reopenable years later: no quotation from a response is ever applied to prose that changed, and a target whose text cannot be reproduced answers `STALE_TARGET` rather than attaching a silent reading.

**The questionnaire** is owned by the backend and frozen into every target, so a response is read against exactly the questions its reader saw: `questionnaire.version` and `questions`, each question with `id`, `label`, `low`, `high` and its `options` (the numbers 1 to 5). The questions are `interest`, `clarity`, `voice`, `emotion` and `continue`. A response's `questionnaire_version` must equal its target's, an option must be one the target declares (the number or its string form), and `null` means the reader skipped that question — a skipped answer stays visible as skipped and is never counted as a low score. A `target_id` is deterministic: the first 16 hexadecimal characters of the hash of the universe, the accepted version, the scope kind and the chapters, which is what makes a second session against the same version and scope reopen the same target instead of freezing another copy.

**A response** is `reader-feedback.v1` and carries: `schema_version`, `feedback_id` (issued by the server), `target_id`, `universe_id`, `reader_id`, `reader_kind` (`team_human` for a real submission, `model` for an annotation, `synthetic` for a fixture), `questionnaire_version`, `created_at`, `accepted_source_version`, `scope`, `language`, `run_id` and `finding_ids` when the reader was looking at a report, `answers` (each answer is `null` or a value from the questionnaire's declared options, with its own `comment`), `comments` (free text, with `evidence` ranges quoted from the target's frozen files), `conditions` (`where` the reader read, how long, on what device — recorded, never required), and `revision_of` (`feedback_id` of the response this one corrects, or `null`) plus `revision` (an integer starting at 1). A correction is a new entry that points at the one it replaces; nothing is edited in place, so the history of what a reader said is the history of files.

Every real response is `reader_kind: team_human`. A model's annotations and a synthetic fixture are stored with their own kind and never enter a count that says how many readers said something.

**Limits.** A comment is at most 4 000 characters; an answer's own comment at most 1 200; a free-text list at most 20 entries; a quoted evidence range must resolve inside the target's frozen file and be at most 600 characters; `note` and `where` at most 200 characters. A response whose quotes do not resolve, whose target is not frozen, or whose answers name options the questionnaire does not declare is refused with `400 INVALID_FEEDBACK` and nothing is written.

**Identity.** A reader is an entry under `readers/`, created once by the server with `reader_id`, `display_name`, `kind`, `created_at` and `last_seen_at`. The identifier is stable across sessions and machines; a reader may withdraw a response or ask for their identity to be deleted, and the deletion is recorded as an entry too, so a withdrawal is visible rather than silent.

**What a listing reports.** `GET /api/universes/:id/feedback` answers the responses, the targets and the counts of that book. The counts separate provenance: a response whose `reader_kind` is `model` or `synthetic` is never added to the number of team readers or team responses, because the difference between what a reader said and what a model annotated is the whole point of keeping both.

**The dataset (`reader-feedback-export.v1`).** One command and one route produce the whole feedback of a book as one JSON document another tool can read: `node scripts/export-feedback.mjs --universe <universe-id> [--out <file>]`, which prints the document on stdout or writes it and answers one JSON line naming the file, byte count and `sha256`; and `GET /api/universes/:id/feedback/export`, which serves the same bytes as a download named `<universe-id>-feedback-export.json`. The document carries its own `schema_version`, the `universe_id`, the `book` (`title`, `language`, `chapters`, `accepted_version`, `version_stable`), the `counts` of §8.7 with the three kinds reported apart, the frozen `questionnaires` it was read against, the `readers`, the `targets` they were given against — each with its accepted version, scope, displayed file hashes and chapter hashes — and the `responses` with their reader and kind, target, accepted version, scope, language, questionnaire version, answers (a skipped answer stays `null`), comments with their evidence ranges, conditions, revision lineage (`revision_of`, `revision`), state (`withdrawn`, `superseded`) and `historical`. Identity deletions are listed apart in `identity_deletions`, so a dataset always says who was deleted and never silently drops them.

Two rules make the dataset reusable. It is **reproducible**: every list is ordered by the identifiers and timestamps the store recorded, the keys are written in a fixed order, and the document carries no timestamp of its own, so exporting one book twice with nothing changed yields byte-identical bytes — a diff of two exports shows only what the readers changed. And it **never carries the text of the book**: only paths, byte counts and `sha256` hashes of the frozen files travel, plus the reader's own words — which include the quotations of up to 600 characters the responses already carry as their evidence, each resolvable inside the frozen text of the target it names. The prose itself stays where it was frozen, under `targets/<target-id>/text/`. `historical` is `null` and `version_stable` is `false` while a turn of the book is queued or running, because the accepted version cannot be read then and the document does not guess. The export writes nothing anywhere.

**The summary (`reader-feedback-summary.v1`)** is the same evidence stated honestly, at `GET /api/universes/:id/feedback/summary` (`--summary` on the command above prints it too). It reports how many readers answered, per question and per accepted version and per provenance the number of responses, the answers, the skips and the responses that left the question unmentioned, and the **distribution of every declared option** — never a mean alone. A mean is reported beside its distribution from three answered responses on, and below that the place of the mean carries the reason instead of a number. Nothing is added across the three kinds: a model's annotation or a synthetic fixture has its own numbers in every question, and the number of readers counts only real responses. Nothing is added across versions either: every number about answers — the responses, the answers, the skips, the unmentioned ones, the distribution and the mean — lives inside the accepted version it was written against, which `versions` names one by one, and a question no response answered is reported as zero answered with the responses that left it unmentioned. The book-level `counts` and a reader's own totals count records and answers, never a rating added to another version's. `historical` marks the versions that are no longer accepted. A correction is not counted twice: the response it replaces is `superseded`, a withdrawn response has no body left, and both are reported apart from the answers that count.

The summary **refuses** three claims with the reason it refuses and the counts that would be needed, and it states no number for them: a **comparison** between two accepted versions of the book (the answers are ordinal ratings given by different readers to different texts; the summary reports the two versions side by side and refuses the ordering, and while a version holds fewer than three answered responses for the question it says the comparison is not supported at all), a **trend** (the store holds readings of a text, not repeated measurements of the same readers over time), and a **claim about what the team thinks** (the store records who answered, never who read the book and did not answer). Where it cannot know something, it says so in place of the number: a reader who answered one question of five is listed with what they answered and what they skipped, a target that holds a single response carries a note that nothing more can be read from it, and what the withdrawn, superseded or deleted records no longer count is stated in `limitations`. An unknown book answers `404 NOT_FOUND`, and a book whose readers have not responded yet answers `404 NO_FEEDBACK` for both the dataset and the summary; neither writes anything.

**The comparison (`reader-feedback-comparison.v1`).** One question, two accepted versions of the same book, and the rule the summary already states: `GET /api/universes/:id/feedback/comparison?question=interest&from=sha256:…&to=sha256:…` answers `{"comparison":Comparison}` while each of the two versions holds at least three answered team responses for that question. The document names the question with the questionnaire that declared it, states its `basis` — the rule, the bound, that only current responses are counted (a withdrawn response, or one a correction replaces, is not) and that the three provenances are kept apart — and reports the two sides side by side: for each side the accepted version, whether it is `historical`, the responses per provenance, and per provenance the responses, the answers, the skips, the responses that left the question unmentioned, the whole distribution of every declared option and the mean beside it (from three answered responses on, with the reason in its place below that). Each side also names the identities behind it: `readers` carries the team readers who answered it, `annotations` the model annotations and synthetic fixtures, each with its `reader_kind`, so what was said is never separated from who said it. The comparison states **no ordering and no difference**: `ordering.difference` is `null` and `ordering.reason_code` is `ORDINAL_RATINGS`, the refusal the summary reports, because the answers are ordinal ratings given by different readers to different texts. The two sides are the versions the caller named, in the order it named them; the store does not turn two content identities into a sequence and invents no chronology. While either version holds fewer than three answered team responses the route answers `409 COMPARISON_NOT_SUPPORTED` with the reason the summary states for that question — or, when the summary reports none, the same shape of sentence — the counts that would be needed, and no distribution, no mean and no difference anywhere. A version that is not a version of this book — another book's, or one the store keeps no text and no response of — answers `409 COMPARISON_UNKNOWN_VERSION` naming the versions it does know, and a request that does not name one question and two different versions answers `400 BAD_COMPARISON`.

**Carrying feedback into a revision.** `POST /api/universes/:id/feedback/revisions` turns a selection of stored feedback into a revision proposal: body `{"selections":["fb-…",{"feedbackId":"fb-…","commentIndex":0}],"chapterNumber":2,"note":"…","preserve":["…"]}` → `201 {"proposal":Proposal}` (`reader-feedback-revision-proposal.v1`). A selection names responses, or single comments of them by their position in `comments` (`commentIndex`, counting from 0) — at most eight of either. The proposal carries `version` (the accepted version the feedback was given against, and every item must be an item of it), `chapter_number`, the `scope` the selection was read at, `note`, and per item the `feedback_id`, what it `selected`, what it `replaces`, the `target_id`, its own `version`, `scope` and `language`, the reader with their `reader_kind` and their `attribution` (`reader`, `annotation` or `fixture`), the answers, and the comments with the quotations the responses carry. It also carries the `readers` counts per kind, the `findings` and the `preserve` in the shape a rewrite request consumes, and the `instructions` that quote the readers' words verbatim. Nothing is carried from a withdrawn response (`409 WITHDRAWN_FEEDBACK`); a correction is carried in place of the response it replaces and the item names the responses it replaces; a model's annotation or a synthetic fixture is carried with its own kind and is never presented, counted or quoted as what a reader said. A response of a version that is no longer accepted is refused as stale (`409 STALE_REQUEST`) rather than reinterpreted, and an unknown response (`404 NOT_FOUND`), a selection that names no chapter, an unknown chapter, and a selection a single revision cannot carry (`400 BAD_SELECTION`, for more than eight items, a comment position that does not exist, the same response twice, or more of a reader's words than one revision can quote) are each refused with nothing written. The proposal is a document, not a decision.

Approving it is the approval of §8.4 and nothing else: the proposal travels as the body of `POST /api/universes/:id/approvals` with `decision`, the reviewer, the accepted directions and the `version` it is about, and the host records that decision beside the approvals it already keeps for design and craft proposals. From an approved proposal, `POST /api/universes/:id/feedback/revisions/rewrite` (body `{"proposal":Proposal,"approval":Approval,"dropLater":false}`) answers `202 {"request":Request,"job":Job}` with a `reader-feedback-revision.v1` request whose `instructions` quote the readers' words, whose `findings` name the evidence under the stable identifier of the response each came from, whose `preserve` carries the qualities the author named, and whose `source_version` is the version the feedback was about, with `proposal` and `approval` naming the document that was decided and the decision it received. The request is performed by the existing rewrite path (§8.4), which re-checks the chapter, its recorded ancestry and that version, so a proposal whose version has moved on is refused as `409 STALE_REQUEST` instead of being applied to the newer text, and a proposal without an approved decision answers `409 NOT_APPROVED`. Neither the selection nor the request writes anything into `universes/`, and neither writes into the feedback tree: the revision itself is the rewrite the existing path performs, and this feature only prepares it.

**Ownership and errors.** Feedback is written by the server, never by the agent, and never inside `universes/`. An unknown target answers `404 NOT_FOUND`; a response for a target whose version is no longer accepted is accepted and marked `historical: true` in the listing rather than refused, because a reader's opinion of an older text is evidence about that text; a response naming an unknown reader answers `404 READER_NOT_FOUND`; a second submission with the same `feedback_id` and the same content answers `200` with the existing entry (`deduplicated: true`), while a different content under the same identifier answers `409 CONFLICT`; a withdrawn response stays readable with `withdrawn: true` and an empty body of answers. Reading the dataset or the summary of a book that does not exist answers `404 NOT_FOUND`; reading either of a book that holds no response answers `404 NO_FEEDBACK`.

**Routes.**

| Route | What it does |
| --- | --- |
| `POST /api/universes/:id/feedback/targets` | body `{"scope":{…},"runId":null,"note":null}` → `201 {"target":Target}`; freezes the displayed text, or returns the existing target for that version and scope |
| `GET /api/universes/:id/feedback/targets/:targetId` | one target, with its frozen files listed |
| `GET /api/universes/:id/feedback` | the responses of that book, newest first, each with `historical` and `withdrawn` |
| `GET /api/universes/:id/feedback/export` | the whole feedback of the book as one `reader-feedback-export.v1` document, served as a download (`<universe-id>-feedback-export.json`); the same bytes the command writes |
| `GET /api/universes/:id/feedback/summary` | `{"summary":Summary}` (`reader-feedback-summary.v1`): the counts, the per-question distributions per version and provenance, the skips and the refusals with their reasons |
| `GET /api/universes/:id/feedback/comparison` | `?question=interest&from=sha256:…&to=sha256:…` → `{"comparison":Comparison}` (`reader-feedback-comparison.v1`): the two accepted versions side by side, each with its whole distribution per provenance and the identities behind it; `409 COMPARISON_NOT_SUPPORTED` with the summary's reason and no number while a version holds fewer than three answered team responses, and `409 COMPARISON_UNKNOWN_VERSION` for a version that is not a version of this book |
| `POST /api/universes/:id/feedback/revisions` | body `{"selections":["fb-…",{"feedbackId":"fb-…","commentIndex":0}],"chapterNumber":2,"note":null,"preserve":["…"]}` → `201 {"proposal":Proposal}` (`reader-feedback-revision-proposal.v1`); `409 WITHDRAWN_FEEDBACK` for a withdrawn response, `409 STALE_REQUEST` for one given against a version that is no longer accepted |
| `POST /api/universes/:id/feedback/revisions/rewrite` | body `{"proposal":Proposal,"approval":Approval,"dropLater":false}` → `202 {"request":Request,"job":Job}`: the approved proposal becomes a `reader-feedback-revision.v1` rewrite request bound to the version the feedback was about, which the existing rewrite path performs; `409 NOT_APPROVED` without an approved decision, `409 STALE_REQUEST` once that version has moved on |
| `POST /api/universes/:id/feedback` | body `{"targetId":…,"readerId":…,"answers":[…],"comments":[…],"conditions":{…}}` → `201 {"feedback":Response}` |
| `POST /api/universes/:id/feedback/:feedbackId` | body `{"action":"withdraw"}` → the response is withdrawn; a correction is a new `POST` with `revision_of` |
| `GET /api/universes/:id/feedback/:feedbackId` | one response |
| `GET /api/universes/:id/readers`, `POST /api/universes/:id/readers` | the reader identities of that book; the body `{"displayName":"…"}` creates one and answers `201 {"reader":Reader}` |
| `GET /api/universes/:id/readers/:readerId` | one identity |
| `POST /api/universes/:id/readers/:readerId` | `{"displayName":"…"}` renames a reader; `{"action":"delete"}` records a deletion request and answers `201 {"reader":Reader,"entry":Response}`, which marks the identity without erasing it and refuses a later response from it with `404 READER_NOT_FOUND` |

`targets`, `export`, `summary`, `comparison` and `revisions` are reserved segments of the feedback route: a response whose identifier is one of those five words is not readable through `GET /api/universes/:id/feedback/:feedbackId`.

Nothing in this section changes a chapter, a canon file or a review: a response is evidence about a version, and turning it into a revision is an approval (§8.4) that a human makes.
