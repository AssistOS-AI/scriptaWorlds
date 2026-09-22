# scriptaWorlds: agent guidance

## Scope

This file applies to the whole repository: the Node.js server and store in `src/`, the static reader interface in `public/`, the proposed-universe catalog in `templates/`, the design instrument in `data/periodic-table.json`, the product skills in `skills/`, the check script in `scripts/`, the book data in `universes/`, and the documentation in `docs/` and `docs/specs/`. It also states the rules an agent must follow while it runs inside a universe folder, which is a different working context with a narrower permission set.

`AGENTS.md` is the single root guidance file. It is not a compatibility duplicate of anything else, and no second guidance file is added at the repository root.

## Mandatory Reading Order

1. `docs/specs/DS001-coding-style.md` for coding style, source layout, dependency policy, file-size limits and the way verification is organized. It is the canonical source for these rules.
2. `docs/contracts.md` for the exact internal contracts: the disk layout of a universe, the fields of every file, the HTTP payloads, the renderer command line and the agent execution rules.
3. The specification that owns the area being changed, from `docs/specs/`, starting at `docs/specs/matrix.md`.
4. `dependencies.md` at the repository root before adding, changing or removing any dependency, and the `dependencies.md` of an affected skill folder before changing that skill.
5. `docs/wiki.html`, the canonical terminology page, whenever a term in the change has an entry there.
6. The HTML documentation pages under `docs/` that describe the affected area, so that they can be updated in the same change.

The design specifications under `docs/specs/` are the source of truth for documented behavior and structure. When a specification and the code disagree, the code defines current behavior and the specification is corrected in the same change.

## Current Skill Catalog

The repository implements six product skills. Two of them write a book and are read during a turn; four of them are chosen only in a separate design or validation phase and are never invoked while a chapter is being written. All six belong to the product documentation:

| Skill | What it is |
| --- | --- |
| `scripta-ala` | The narrative skill the agent reads before writing an episode: the mandatory working order, the narrative invariants, the file schemas, the creative palette and the chapter validator. Specified in `docs/specs/DS007-scripta-ala-skill.md`, documented on `docs/scripta-ala-skill.html`. |
| `scripta-book-export` | The print skill: one dependency-free command that produces the DOCX and PDF editions of a universe. Specified in `docs/specs/DS008-scripta-book-export-skill.md`, documented on `docs/scripta-book-export-skill.html`. |
| `scripta-story-design` | The design skill: the tentative brief that gives a book or an arc its purpose before any prose is written, plus its validator. A separate-phase skill, never read during chapter writing. Specified in `docs/specs/DS010-scripta-story-design-skill.md`, documented on `docs/scripta-story-design-skill.html`. |
| `scripta-prose-craft` | The craft skill: focalization, voice, subtext, blocks and rhythm, plus the validator of the prose profile that records them. A separate-phase skill, never read during chapter writing. Specified in `docs/specs/DS011-scripta-prose-craft-skill.md`, documented on `docs/scripta-prose-craft-skill.html`. |
| `scripta-continuity-review` | The continuity reviewer: deterministic integrity checks over a frozen assessment packet, plus re-verified semantic annotations, producing evidence-backed findings without editing the book. A separate-phase skill. Specified in `docs/specs/DS012-scripta-continuity-review-skill.md`, documented on `docs/scripta-continuity-review-skill.html`. |
| `scripta-metrics-report` | The measurement skill: one validated assessment bundle and the five reports rendered from it, with advisory scores and honest unavailable results. A separate-phase skill. Specified in `docs/specs/DS013-scripta-metrics-report-skill.md`, documented on `docs/scripta-metrics-report-skill.html`. |

Update this table, `docs/index.html`, the affected specification and the specification matrix in the same change whenever this catalog changes.

Skills that are imported for engineering work are not product artifacts. They get no page under `docs/`, no specification under `docs/specs/`, no entry in the matrix and no chapter in the documentation, and their guidance stays inside their own folders. Downstream projects that only consume skills keep their `docs/` tree focused on the host project for the same reason.

## Repository Rules

Runtime code is Node.js ECMAScript modules in `.mjs` files with `node:` imports, explicit exports, `async`/`await` and resources resolved from the module itself rather than from the working directory. The browser interface is plain ES modules with no build step, no framework and no CDN. The default is built-in modules plus local code; a new dependency needs a recorded justification, alternatives, license and removal opportunity in the owning `dependencies.md` before it is used, and a required dependency needs a startup or entry-point probe that fails with an actionable message before side effects.

Every statement in this repository is written in English: code identifiers, comments, log lines, error codes and messages, documentation, specifications, HTML pages and page content. The one exception is the content of a book, which is written in the language of that universe, and the labels of a printed edition, which follow the edition language. Schema vocabulary, meaning file names, plan keys, canon section names, JSON fields, thread kinds and statuses, and atlas identifiers, is always English.

A code change that alters behavior, a file format, an HTTP payload or a command-line interface updates `docs/contracts.md`, the affected specification under `docs/specs/` and the affected HTML pages under `docs/` in the same change set. Documentation and specifications are never left to describe an earlier state.

Specification numbering stays gap-free and contiguous: `DS000`, `DS001`, `DS002`, `DS003-main-behavior.md` and then consecutive numbers. Exactly one `DS003-main-behavior.md` exists. Every ordinary specification uses `Introduction` and `Core Content` as its only top-level sections, carries exactly the `title` and `summary` frontmatter fields with the title equal to the file name stem, and records rationale, limitations, assumptions and contract boundaries as declarative statements inside `Core Content` rather than in a separate decision log. Regenerate `docs/specs/matrix.md` from the specification files instead of editing it by hand.

Before creating or updating `DS003-main-behavior.md`, re-derive the accepted main behaviors from the implementation rather than from the previous text: trace the primary paths from the public entry points and commands, confirm each behavior against source and against `npm run check`, keep only behaviors that are user-impacting, project-defining, major hidden mechanisms or essential interfaces, and move lower-level detail into the specialized specifications that own it.

Documentation rules for every page and specification follow the same standard. Write for a reader who has no prior knowledge of the project, and say what a feature is for before explaining how it works. Name the real actor, file, route, command, variable or outcome instead of an abstract noun. Use concrete, defensible statements: if a claim cannot be confirmed in the code, narrow it or remove it until it can be. Keep project-specific terms defined once on `docs/wiki.html` with a stable anchor and link the first eligible occurrence of each term in `README.md`, the HTML pages and every specification to that exact anchor using the form `wiki.html#definition-...`, which resolves both inside `docs/specsLoader.html` and in a raw Markdown reader; titles and headings stay unlinked. Keep every paragraph on one logical source line and let it wrap naturally in the container, and never narrow a text container to force early wrapping. Remove repository-status commentary, planned-interface language and progress notes, and never mention the authoring tools used to produce the documentation.

## Runtime Defaults

Node.js 20 or later is the runtime prerequisite for the server, the check script and both skill scripts. The `omp` command-line agent is mandatory: the server probes it with `OMP_BIN` or the bare `omp` name before it listens and exits with status 1 with the code `OMP_MISSING` when the probe fails, and every turn runs one headless agent process in the universe folder with the prompt on standard input.

The model comes from `SCRIPTAS_MODEL` and defaults to `deepseek/deepseek-v4-flash`; it is recorded in the universe metadata and in every turn record. Timeouts are `CHAPTER_TIMEOUT_MS` and `EXPORT_TIMEOUT_MS`, the chapter target length is `CHAPTER_MIN_WORDS` to `CHAPTER_MAX_WORDS`, and `MAX_CONCURRENT_JOBS` optionally bounds turns across the server, where `0` means unlimited and each universe always runs at most one turn.

The repository has no npm dependencies. `dependencies.md` at the root records the two runtime requirements and the optional system font, and each skill folder keeps its own record. Behavior is verified with `npm run check`, which runs `scripts/check.mjs` against temporary universes without spending model budget, and a change is not complete until that check passes together with a scoped reproduction of the changed path.

Inside a universe folder the rules are narrower. Work only in that folder. Do not run `git` and do not touch another universe. Narrative content is written only through the workflow of `scripta-ala`, and printed editions only through `scripta-book-export`. Write only `canon.md`, `threads.json`, `atlas.json`, `chapters/*`, `drafts/*` and `exports/edition.json`; `universe.json`, `turns/*` and `.agents/` belong to the server, and `charter.md` is edited only by a human or a client that intends to change the permanent rules of the universe. A design or validation pass is a separate phase: it selects `scripta-story-design`, `scripta-prose-craft`, `scripta-continuity-review` or `scripta-metrics-report`, it reads a frozen copy of the accepted version, and it writes nothing into the universe.

## Key Paths

- `docs/index.html`: the documentation entry point and its map of pages.
- `docs/architecture.html`: components, the lifecycle of a turn, and which component writes which file.
- `docs/operations.html`: requirements, configuration, the environment check and the failure reference.
- `docs/api.html`: every route, the error envelope and the live event stream.
- `docs/reader-interface.html`: the browser reader and its in-flow surfaces.
- `docs/scripta-ala-skill.html`, `docs/scripta-book-export-skill.html`: the two product skills that write a book.
- `docs/scripta-story-design-skill.html`, `docs/scripta-prose-craft-skill.html`, `docs/scripta-continuity-review-skill.html`, `docs/scripta-metrics-report-skill.html`: the four separate-phase design and review skills.
- `docs/wiki.html`: the canonical terminology page for every project-specific term.
- `docs/specs/`: the specification set; `docs/specs/matrix.md` is its generated index and `docs/specsLoader.html` is the viewer.
- `docs/contracts.md`: the internal contract reference for formats, payloads and command lines.
- `src/`: the server and the store; `public/`: the reader; `skills/`: the product skills; `templates/universes.json`: the catalog; `data/periodic-table.json`: the 180 cells of the Periodic Table of Ideas a new universe is composed from; `universes/`: the books; `scripts/check.mjs`: the environment check.
