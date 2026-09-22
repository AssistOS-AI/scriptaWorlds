#!/usr/bin/env node
/**
 * validate-design.mjs — dependency-free CLI validator for a scriptaWorlds story-design brief.
 *
 * CLI:
 *   node validate-design.mjs --input <design.json> [--context <packet-dir|manifest.json>]
 *
 * `--input` names the brief; nothing writes into a universe and no default path is derived
 * from a repository root. The brief lives in the `proposal/` directory of an external
 * assessment workspace (`docs/contracts.md` §8.1).
 *
 * `--context` accepts an `assessment-input.v2` packet (`docs/contracts.md` §8.3): either the
 * packet directory that contains `manifest.json` or that `manifest.json` file itself. The
 * manifest is verified — schema version, path containment through real paths, byte counts,
 * hashes, duplicate paths and artifact ids, the recomputed accepted-version identity (§8.2)
 * and the declared `scope.kind` — and then `based_on_version` is compared with the packet's
 * `version`, never with `book.universe_id`. Without `--context`, a brief that names a source
 * version is reported as a warning because the version cannot be checked.
 *
 * Exit codes:
 *   0 — the brief is valid (warnings are observations, never failures)
 *   2 — invalid arguments, malformed JSON, or a schema/consistency violation
 *   1 — unexpected execution failure (I/O or otherwise)
 *
 * stdout is exactly one JSON object:
 *   { "schema_version": "design.v1", "ok": bool, "errors": [...], "warnings": [...] }
 *
 * The design brief schema, the context rules and all validation rules are documented in
 * scripts/lib/design.mjs; the packet contract lives in scripts/lib/packet.mjs.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateDesign, validateContext, uncheckedVersionWarning, DESIGN_SCHEMA } from './lib/design.mjs';

function parseArgs(argv) {
  const args = { input: null, context: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '--context') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for ${arg}`);
      }
      args[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  if (args.input === null) {
    throw new Error('missing required --input argument');
  }
  return args;
}

function finish(code, errors, warnings) {
  const envelope = { schema_version: DESIGN_SCHEMA, ok: errors.length === 0, errors, warnings };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  for (const error of errors) {
    process.stderr.write(`error: ${error}\n`);
  }
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  process.exit(code);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    finish(2, [err.message], []);
    return;
  }

  const inputPath = resolve(args.input);
  let designText;
  try {
    const info = await stat(inputPath);
    if (info.isDirectory()) {
      finish(2, [`input path is a directory, expected a JSON file: ${inputPath}`], []);
      return;
    }
    designText = await readFile(inputPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      finish(2, [`input file does not exist: ${inputPath}`], []);
      return;
    }
    finish(1, [`execution failure while reading input: ${err.message}`], []);
    return;
  }

  let design;
  try {
    design = JSON.parse(designText);
  } catch (err) {
    finish(2, [`input is not valid JSON: ${err.message}`], []);
    return;
  }

  const { errors, warnings } = validateDesign(design);

  if (args.context !== null) {
    try {
      await validateContext(resolve(args.context), design, errors, warnings);
    } catch (err) {
      finish(1, [`execution failure while validating context: ${err.message}`], []);
      return;
    }
  } else {
    const unchecked = uncheckedVersionWarning(design);
    if (unchecked !== null) {
      warnings.push(unchecked);
    }
  }

  finish(errors.length === 0 ? 0 : 2, errors, warnings);
}

main().catch((err) => {
  finish(1, [`execution failure: ${err && err.message ? err.message : String(err)}`], []);
});
