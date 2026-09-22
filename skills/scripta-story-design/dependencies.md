# Dependencies

## Scope

This record covers the whole `scripta-story-design` folder: the skill instructions (`SKILL.md`), three
Markdown references, catalog metadata (`skill.json`), one dependency-free Node.js validator
(`scripts/validate-design.mjs`) with its two rule modules (`scripts/lib/design.mjs` for the design brief and
`scripts/lib/packet.mjs`, the duplicated `assessment-input.v2` loader required by `docs/contracts.md` §8.3)
and its tests (`tests/design.test.mjs` for the brief, `tests/context.test.mjs` for the packet,
`tests/cli.test.mjs` for the command-line surface, sharing fixtures in `tests/helpers/fixtures.mjs`).

## Runtime prerequisites

- **Node.js ≥ 20** — required only for `scripts/validate-design.mjs` and `tests/design.test.mjs`. They use
  only `node:` built-ins (`node:fs/promises`, `node:path`, `node:crypto`, `node:os`, `node:url`,
  `node:assert/strict`, `node:test`, `node:child_process`); no npm packages and no build step. The rest of
  the skill (instructions and references) is plain Markdown and remains usable without Node.js.

## External dependencies

None. No npm packages, vendored code, third-party CLI tools or runtime downloads. The references are
original material adapted from the user-provided guide identified in `references/source-map.md`; the
private DOCX is not a runtime resource.

## Maintenance

Any future dependency (library, CLI tool, dataset, font) must be recorded here with justification,
rejected alternatives, source, license, a startup probe and a removal opportunity. Nothing is installed
globally without explicit authorisation.
