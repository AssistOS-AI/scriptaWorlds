# Dependencies

## Scope

This record covers the complete `scripta-book-export` skill folder: `SKILL.md`, `skill.json`,
`DS.md`, this file, the executable entry point `scripts/build-book.mjs`, and the engine modules it
imports from `scripts/lib/` — `errors.mjs`, `truetype.mjs`, `fonts.mjs`, `markdown.mjs`, `book.mjs`,
`layout.mjs`, `pdf.mjs` and `docx.mjs`.

## Runtime prerequisites

- **Node.js ≥ 20** (checked with `node -v`; developed and verified on `v24.9.0`). Required. The
  script uses ECMAScript modules, `node:fs`, `node:path`, `node:url`, `node:zlib`, `node:crypto`,
  Unicode property escapes in regular expressions, and BigInt-free 32-bit table arithmetic. It runs
  on the project's stated engine range (`package.json` → `engines.node: ">=20"`).
- Invocation (from a universe folder, resolved through the project symlink):
  `node .agents/skills/scripta-book-export/scripts/build-book.mjs --universe . --format both`.
- No installation step, no build step, no network access at runtime.

## External dependencies

**None.** No npm package, no vendored third-party code, no Python, no browser library, no external
CLI is used or required by the renderer. The PDF engine, the DOCX/OOXML writer, the ZIP writer, the
CRC32 implementation, the TrueType parser and subsetter, and the Markdown parser are all original
code inside the skill's own modules (`scripts/build-book.mjs` for the CLI and `scripts/lib/*.mjs` for
the engines) and use Node.js built-ins only (`node:zlib` for
`deflateSync`/`deflateRawSync`, `node:crypto` for the PDF file identifier and the font subset tag).

### Optional system fonts (soft dependency, with fallback)

- **Purpose:** supply the TrueType outlines embedded (subsetted) in the PDF.
- **Required or optional:** optional. Without a usable font the CLI still runs and fails with a clear
  diagnostic (`{"ok":false,"code":"MISSING_FONT"}`) instead of producing a broken file.
- **Resolution order:** `/usr/share/fonts/liberation-serif-fonts/` (Regular/Bold/Italic/BoldItalic),
  then any `/usr/share/fonts/truetype/liberation*`, then `/usr/share/fonts/google-noto-vf/NotoSerif*`,
  then any other serif TrueType family under `/usr/share/fonts`. `--fonts <folder>` replaces the
  whole search with that folder.
- **Acceptance rule:** a family is used only if its regular face covers, through its parsed `cmap`,
  every character of the book; missing styles fall back to the regular face. A family that covers at
  least printable ASCII plus the Romanian diacritics is used as a last resort, and unmapped
  characters are written as `?` with a warning on stderr.
- **Accepted formats:** TrueType with `glyf` outlines (`.ttf`). CFF/OpenType (`.otf`) and font
  collections (`.ttc`) are skipped, because the subsetter operates on `glyf`/`loca`.
- **Verified environment:** Liberation Serif (used for the reference build) and Noto Serif variable
  fonts (`/usr/share/fonts/google-noto-vf/NotoSerif[wght].ttf`, exercised through `--fonts`).
- **License:** system fonts are not redistributed by this skill; only glyph subsets of the local
  font files are embedded into the generated PDF, and the PDF names the source family in each
  `FontDescriptor` (`/BaseFont /XXXXXX+LiberationSerif` style subset tags).
- **Removal opportunity:** the font search and the whole font-embedding path are self-contained in
  `scripts/lib/truetype.mjs` (parser and subsetter) and `scripts/lib/fonts.mjs` (search order, family
  ranking and `BookFace`); a different outline source would only need those two modules.
- **Installation guidance (only if no serif TrueType exists):** install the distribution package that
  provides `liberation-serif-fonts` (e.g. `sudo dnf install liberation-serif-fonts` on Fedora) or
  pass `--fonts` pointing at a folder with a serif `.ttf`.

## Verification tools used (not dependencies)

`pdftotext`, `pdffonts`, `pdftoppm`, `gs`, `unzip`, `soffice`, and `python3` were used to verify the
produced files during development (text extraction, diacritics, page numbers, rendering, DOCX
structure and LibreOffice round-trip). They are verification tools, not runtime dependencies of the
skill.

## Maintenance

Keep this record with the copied skill folder: the script has no external dependency, so nothing
here has to be installed for the skill to work. If a future change introduces an accepted
dependency, record its purpose, scope, version or revision, justification and rejected alternatives,
source and update URL, local changes, license and notices, transitive requirements, startup check,
and removal opportunity here, using the catalog's dependency-record structure as a model.
