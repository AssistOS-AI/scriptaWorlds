# Dependencies

## Scope

This record covers the complete `scripta-import` skill folder: `SKILL.md` (the import workflow),
`skill.json` (the catalog manifest), the six `references/*.md` documents (the extraction format, the
turn discipline, segmentation, prose cleaning, the state files, the validator contract),
`schema/import.v1.json` and `schema/import-progress.v1.example.json` (the published vocabulary and
the canonical import record), the executable `scripts/validate-import.mjs`, the modules it imports
from `scripts/lib/` (`limits.mjs`, `problems.mjs`, `text.mjs`, `extraction.mjs`, `record.mjs`,
`turns.mjs`, `chapters.mjs`, `state.mjs`, `validate.mjs`) and the `node --test` suites under
`tests/`.

## Runtime prerequisites

- **Node.js ≥ 20** (checked with `node -v`; developed and verified on `v24.9.0`). Required. The
  validator uses ECMAScript modules, top-level `await`-free synchronous file access, `node:fs`
  (`readFileSync`, `readdirSync`, `statSync`), `node:path`, `node:url`, Unicode property escapes in
  regular expressions (`\p{L}`, `\p{N}`) and `String.prototype.normalize`.
- It runs inside the project's stated engine range (`package.json` → `engines.node: ">=20"`) and
  outside it: it takes all of its input from its arguments, so it works on a copied universe folder
  and a copied extraction file.
- Invocation, from a universe folder through the project symlink:
  `node .agents/skills/scripta-import/scripts/validate-import.mjs --universe . --import .agents/import/extracted.json --chapters 4-6`.
- No installation step, no build step, no network access at runtime.

## External dependencies

**None.** No npm package, no vendored third-party code, no Python, no browser library and no external
command is used or required. The tokenizer, the run-overlap measure, the word band, the import
record's schema checks, the chapter-set checks and the state-file checks are original code inside
this skill's own modules and use Node.js built-ins only.

The skill needs no runtime dependency beyond Node.js itself, and it deliberately has none: it is the
part of the pipeline that a host runs on every import turn without spending model budget, so a
dependency would put a network install, a version range and an update procedure between the host and
a file it must validate.

### The host's extraction (an input contract, not a dependency)

The skill reads `.agents/import/extracted.json`, written by the host, and the plain-text twin
`.agents/import/book.md`. Their shape is fixed in `docs/contracts.md` and published machine-readably
in `schema/import.v1.json`; both files belong to the host, and this skill only reads them. An
extraction that does not match the published shape is refused with a structured code rather than
adapted to.

## Verification tools used (not dependencies)

`node --test` and `node:assert/strict` from the Node.js runtime run the suites under `tests/`; no
external test framework is added. During development the validator was also exercised by hand against
temporary universes built by the suites' own fixtures. The fixtures write real universe folders in
the system temporary directory and remove them again, so no test depends on a checked-in universe.

## Maintenance

Keep this record with the copied skill folder: nothing here has to be installed for the skill to
work, and a copy of `skills/scripta-import/` carries everything it needs. If a future change
introduces an accepted dependency, record its purpose, scope, required or optional status, version or
immutable revision, location, accepted rationale, rejected alternatives, upstream source and update
procedure, license and bundled notices, startup check, and remaining removal or replacement
opportunity here, using the repository's dependency-record structure as a model. Any change to the
turn limits, the word band, the overlap measure or the state vocabulary must update
`schema/import.v1.json`, `scripts/lib/limits.mjs` and the references together; the suite
`tests/schema.test.mjs` fails when the published vocabulary and the code name different values.
