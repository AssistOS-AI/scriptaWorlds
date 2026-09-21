# Dependencies

## Scope

This record covers the whole scriptaWorlds project: the Node.js server (`src/`), the static interface
(`public/`), the project skills (`skills/`), the universe template catalogue (`templates/`) and the data in
`universes/`. Each skill keeps its own local record (`skills/scripta-ala/dependencies.md`,
`skills/scripta-book-export/dependencies.md`).

## Runtime prerequisites

- **Node.js ≥ 20** (developed and tested on 24.9.0). Used by the server, the `scripta-ala` chapter validator
  and the book renderer. Check: `node --version`.
- **`omp` (Oh My Pi) ≥ 18.2** — required. The server starts one headless instance per turn and refuses to
  start when the binary is missing (`src/config.mjs:requireOmp`, with install instructions in the message).
  Override with `OMP_BIN`. Check: `omp --version`. Default model: `deepseek/deepseek-v4-flash`
  (override with `SCRIPTAS_MODEL`).

## External dependencies

| Component | Role | Status | Justification / rejected alternatives |
| --- | --- | --- | --- |
| `omp` CLI | the coding agent that writes chapters, rewrites and editions | required | It is the mechanism the product asks for (an orchestrated coding agent, not direct model calls). Rejected alternative: calling a model SDK from the server, which would move narrative logic into the server and drop the agent's file tools. |
| System serif fonts (Liberation Serif, Noto Serif) | PDF/DOCX rendering of editions | optional for the server, required for export | Avoids vendoring a font and its licence; the renderer searches installed fonts and reports `MISSING_FONT` with remediation steps. |
| LibreOffice (`soffice`), `pdftotext`, `pdftoppm`, `gs` | manual review of editions, during development only | optional | Not called by the code; used as inspection tools while testing. |

There are no npm dependencies: the server, the interface and the skill scripts use only Node built-ins,
as required by `AGENTS.md`.

## Maintenance

Record every new dependency here with purpose, version, licence, startup check and removal opportunity.
Global installs need explicit authorization. When the model or the `omp` binary changes, update this record,
the README and `docs/contracts.md` together.
