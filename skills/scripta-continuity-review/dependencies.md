# Dependencies

No external dependencies; Node.js 20 or later built-in modules only. The scope
covers the whole skill:

- `SKILL.md`, `skill.json`, the two Markdown references and this record
- `scripts/review-continuity.mjs`
- `scripts/lib/manifest.mjs` (packet loading and the shared §8.3 refusal codes),
  `scripts/lib/scope.mjs` (the declared scope and what it obliges),
  `scripts/lib/json-spans.mjs` (position-aware JSON parsing),
  `scripts/lib/evidence.mjs` (evidence.v1 building and verification),
  `scripts/lib/checks.mjs` (deterministic integrity checks),
  `scripts/lib/claims.mjs` (annotations.v1 semantic claims),
  `scripts/lib/annotations.mjs` (annotations.v1 file envelope),
  `scripts/lib/ledger.mjs` (the comparison ledger and the derived indices),
  `scripts/lib/paths.mjs` (real-path input/output separation),
  `scripts/lib/publish.mjs` (atomic publication),
  `scripts/lib/result.mjs` (the continuity-result.v1 envelope)
- `tests/helpers.mjs` and the focused suites `tests/packet.test.mjs`,
  `tests/checks.test.mjs`, `tests/annotations.test.mjs`, `tests/ledger.test.mjs`,
  `tests/output.test.mjs`, `tests/continuity.test.mjs`

Built-ins used: `node:fs/promises`, `node:path`, `node:crypto`, `node:util`,
`node:child_process`, `node:os`, `node:url`, `node:assert/strict`, `node:test`.

The CLI resolves paths from its arguments or `import.meta.url`, never from the
repository root or `process.cwd()`. A semantic annotation provider
(`annotations.v1`) is optional and supplied by the host; the reviewer never
invokes a model, downloads a corpus, or performs network access. No npm
packages, no vendored code, no build step. Nothing outside the skill folder is
imported, so the folder runs unchanged when it is copied elsewhere.

Local references identify the source documents by hash. No private document is
needed at runtime.
