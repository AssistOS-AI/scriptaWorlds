#!/usr/bin/env node
// Dependency-free validator for a scriptaWorlds prose profile (profile.v1).
// Built with Node.js >= 20 built-in modules only. This skill never imports src/.
//
// Usage:
//   node validate-profile.mjs --input <profile.json> [--context <packet-dir|manifest.json>]
//
// `--input` names the profile; nothing writes into a universe and no default path is
// derived from a repository root. The profile lives in the `proposal/` directory of an
// external assessment workspace (`docs/contracts.md` §8.1).
//
// `--context` accepts an `assessment-input.v2` packet (`docs/contracts.md` §8.3): either
// the packet directory that contains `manifest.json` or that `manifest.json` file itself.
// The manifest is verified — schema version, path containment through real paths, byte
// counts, hashes, duplicate paths and artifact ids, the recomputed accepted-version
// identity (§8.2) and the declared `scope.kind` — and then `based_on_version` is compared
// with the packet's `version`, never with `book.universe_id`. The quoted support of every
// expressive component is located in the packet file it names. Without `--context`, a
// profile that names a source version or quotes evidence is reported as a warning because
// neither can be checked.
//
// stdout: exactly one JSON object (the result envelope), which also carries the checked
//         packet's `version` and the `scope` it covered, or null when no packet was given.
// stderr: human-readable diagnostics only.
// Exit codes: 0 = structurally valid, 2 = invalid arguments/input/schema,
//             1 = execution failure (I/O or unexpected error).
//
// Read-only by construction: the validator publishes nothing, so it takes no output path
// and refuses one (`--out`, `--output`, `--emit`, `--write`, `--publish`) before it reads
// anything. That is what keeps an output from aliasing back into the profile or the packet;
// the accepted proposal is published by the crafting session (§8.1, §8.4).

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isPlainObject } from './lib/packet.mjs';
import { uncheckedEvidenceWarning } from './lib/components.mjs';
import {
  PROFILE_SCHEMA,
  uncheckedVersionWarning,
  validateContext,
  validateProfile,
} from './lib/profile.mjs';

const USAGE = [
  'usage: node validate-profile.mjs --input <profile.json> [--context <packet-dir|manifest.json>]',
  '',
  '--input <path>    path to the prose-profile JSON to validate (required); the profile',
  '                  lives in the proposal/ directory of an external assessment',
  '                  workspace (docs/contracts.md §8.1) and no path is derived from a',
  '                  repository root',
  '--context <path>  optional assessment-input.v2 packet directory or its manifest.json;',
  '                  when given, based_on_version is compared with the packet version',
  '                  identity of docs/contracts.md §8.2, never with book.universe_id, and',
  '                  the quoted support of every expressive component is located in the',
  '                  packet file it names',
  '',
  'The validator writes nothing: its inputs are never modified. It accepts no output path, so',
  'an output argument is a usage error and cannot alias back into the input or the packet.',
].join('\n');

/** Arguments that would make this read-only validator an output or publication command. */
const OUTPUT_FLAGS = new Set(['--out', '--output', '--emit', '--write', '--publish']);

function parseArgs(argv) {
  const result = { input: null, context: null, help: false, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' || arg === '--context') {
      const value = argv[i + 1];
      if (value === undefined || value === '') {
        result.errors.push(`USAGE: ${arg} requires a value`);
        i += 1;
        continue;
      }
      if (arg === '--input') {
        result.input = value;
      } else {
        result.context = value;
      }
      i += 1;
    } else if (OUTPUT_FLAGS.has(arg)) {
      result.errors.push(
        `OUTPUT_NOT_SUPPORTED: ${arg} is refused; this validator publishes no bundle and writes nothing, ` +
          'so it needs no output path and no output can be placed inside --input or --context ' +
          '(docs/contracts.md §8.1)',
      );
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      result.errors.push(`USAGE: unknown argument: ${arg}`);
    }
  }
  if (!result.input) {
    result.errors.push('USAGE: missing required --input <profile.json>');
  }
  return result;
}

// Reads and JSON-parses a CLI-provided file. On failure it pushes a structured
// message onto `errors` and returns the exit code to use (2 = bad input, 1 = I/O).
async function readJsonFile(pathArg, label, errors) {
  let resolved;
  try {
    resolved = resolve(pathArg);
  } catch (err) {
    errors.push(`PATH_ERROR: ${label}: cannot resolve path "${pathArg}": ${err.message}`);
    return { ok: false, exit: 2 };
  }
  try {
    const st = await stat(resolved);
    if (st.isDirectory()) {
      errors.push(`INVALID_INPUT: ${label} "${pathArg}" is a directory, expected a JSON file`);
      return { ok: false, exit: 2 };
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      errors.push(`MISSING_FILE: ${label} file not found: ${pathArg}`);
      return { ok: false, exit: 2 };
    }
    errors.push(`IO_ERROR: ${label}: failed to inspect "${pathArg}": ${err.message}`);
    return { ok: false, exit: 1 };
  }
  let text;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'EISDIR') {
      errors.push(`INVALID_INPUT: ${label} "${pathArg}" is a directory, expected a JSON file`);
      return { ok: false, exit: 2 };
    }
    errors.push(`IO_ERROR: ${label}: failed to read "${pathArg}": ${err.message}`);
    return { ok: false, exit: 1 };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    errors.push(`BAD_JSON: ${label} is not valid JSON: ${err.message}`);
    return { ok: false, exit: 2 };
  }
}

function emit(result, exitCode) {
  const envelope = {
    schema_version: PROFILE_SCHEMA,
    ok: result.ok,
    errors: result.errors,
    warnings: result.warnings,
    context: result.context ?? null,
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  for (const e of result.errors) {
    process.stderr.write(`error: ${e}\n`);
  }
  for (const w of result.warnings) {
    process.stderr.write(`warning: ${w}\n`);
  }
  process.exitCode = exitCode;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const warnings = [];

  if (args.help) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 0;
    return;
  }

  if (args.errors.length > 0) {
    errors.push(...args.errors);
    emit({ ok: false, errors, warnings }, 2);
    return;
  }

  const inputRead = await readJsonFile(args.input, '--input', errors);
  if (!inputRead.ok) {
    emit({ ok: false, errors, warnings }, inputRead.exit);
    return;
  }
  const profile = inputRead.value;

  if (!isPlainObject(profile)) {
    errors.push('INVALID_PROFILE: profile must be a JSON object');
    emit({ ok: false, errors, warnings }, 2);
    return;
  }

  const { components } = validateProfile(profile, errors);

  let context = null;
  if (args.context) {
    try {
      context = await validateContext(resolve(args.context), profile, components, errors, warnings);
    } catch (err) {
      errors.push(`IO_ERROR: execution failure while validating context: ${err.message}`);
      emit({ ok: false, errors, warnings }, 1);
      return;
    }
  } else {
    const unchecked = uncheckedVersionWarning(profile);
    if (unchecked !== null) {
      warnings.push(unchecked);
    }
    const unverified = uncheckedEvidenceWarning(profile);
    if (unverified !== null) {
      warnings.push(unverified);
    }
  }

  emit({ ok: errors.length === 0, errors, warnings, context }, errors.length === 0 ? 0 : 2);
}

main().catch((err) => {
  const message = err && err.message ? err.message : String(err);
  emit({ ok: false, errors: [`INTERNAL: unexpected failure: ${message}`], warnings: [] }, 1);
});
