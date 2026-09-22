# Dependencies

No external dependencies; Node.js ≥20 built-ins only.

## Scope

This record covers the complete `scripta-prose-craft` skill folder: `SKILL.md`, `skill.json`, this file,
the two references (`references/voice-and-revision.md`, `references/narrative-blocks.md`), the executable
validator `scripts/validate-profile.mjs` with its rule modules `scripts/lib/packet.mjs`,
`scripts/lib/profile.mjs` and `scripts/lib/components.mjs`, and the test suites under `tests/` with their
shared fixtures in `tests/helpers/fixtures.mjs`.

## Runtime prerequisites

- **Node.js ≥ 20** — required only for `scripts/validate-profile.mjs` and its tests. The script uses
  ECMAScript modules and `node:fs/promises`, `node:path`, `node:crypto` (SHA-256 for the accepted-version
  identity and the packet hashes) and `node:util` (`TextDecoder` with `fatal: true` for strict UTF-8
  validation); no packages. Check with `node --version`. Without Node the CLI cannot run, but the rest of
  the skill (instructions + references) stays usable.
- Invocation: `node scripts/validate-profile.mjs --input <profile.json> [--context <packet-dir|manifest.json>]`.
- No installation step, no build step, no network access at runtime. The validator writes nothing and
  refuses any output argument (`--out`, `--output`, `--emit`, `--write`, `--publish`).

## External dependencies

**None.** No npm package, no vendored third-party code, no external CLI, no CDN, and no import from `src/`.
The language-code list is duplicated from `src/config.mjs` `LANGUAGES` inside the script (with a comment
noting it must stay in sync) so the validator stays fully self-contained.

## Verification tools used (not dependencies)

The test suite uses the built-in `node --test` runner and `node:assert/strict`; these are part of Node.js,
not external dependencies.

## Maintenance

If a future change introduces an accepted dependency, record its purpose, scope, version or revision,
justification and rejected alternatives, source and update URL, local changes, license and notices,
transitive requirements, startup check, and removal opportunity here. The skill currently needs nothing to
be installed to work.
