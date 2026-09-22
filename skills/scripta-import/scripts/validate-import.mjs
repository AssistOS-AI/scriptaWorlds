#!/usr/bin/env node
// Validate a scriptaWorlds universe after one import turn, without spending model budget.
//
//   node validate-import.mjs --universe <universe-folder> --import <extracted.json>
//                            [--chapters <from>-<to>]
//
// `--universe` is the folder of the universe the import wrote into; `--import` is the extraction
// file the host wrote, `<universe>/.agents/import/extracted.json` by default. `--chapters` names the
// range of *extraction* chapters one import turn covered — the range the host planned and the range
// the record's own turn journal carries — so an import of a twelve-chapter book can be accepted turn
// by turn; without it the whole import is checked.
//
// Standard output carries exactly one JSON envelope, printed as the last line, and nothing else:
// `{ schema_version, ok, code, errors, warnings, ... }`. `ok` is true when the checked range holds,
// `code` is the most severe defect found (`INVALID_IMPORT`, `MISSING_CHAPTER`, `WORD_COVERAGE`,
// `UNPARSEABLE_JSON`, `NO_EXTRACTION`) or null, `errors` carries one `<CODE>: <message>` string per
// defect, and `warnings` reports what does not refuse the import. Exit status is 0 when `ok` is
// true and 2 in every other case. The command never writes a file, never calls a model and never
// reaches the network; a missing chapter is refused rather than reported as an empty one.

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CODE_USAGE, EXTRACTION_PATH, VALIDATION_SCHEMA_VERSION } from './lib/limits.mjs';
import { EXIT_FAILED, EXIT_OK } from './lib/problems.mjs';
import { validateImport } from './lib/validate.mjs';

const USAGE = 'Usage: node validate-import.mjs --universe <universe-folder> --import <extracted.json> [--chapters <from>-<to>]';
const RANGE = /^(\d+)-(\d+)$/;

class UsageError extends Error {}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function parseArgs(argv) {
  const options = { universe: null, extraction: null, range: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--universe') {
      const value = argv[index + 1];
      if (!value) throw new UsageError(`--universe needs a folder argument\n${USAGE}`);
      options.universe = resolve(value);
      index += 1;
    } else if (arg === '--import') {
      const value = argv[index + 1];
      if (!value) throw new UsageError(`${arg} needs a file argument\n${USAGE}`);
      options.extraction = resolve(value);
      index += 1;
    } else if (arg === '--chapters') {
      const value = argv[index + 1];
      const match = value ? RANGE.exec(value.trim()) : null;
      if (!match) throw new UsageError(`--chapters needs a range such as 1-3\n${USAGE}`);
      const from = Number.parseInt(match[1], 10);
      const to = Number.parseInt(match[2], 10);
      if (from < 1 || to < from) throw new UsageError(`--chapters must be an ascending range of chapter numbers\n${USAGE}`);
      options.range = { from, to };
      index += 1;
    } else {
      throw new UsageError(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`);
    }
  }
  if (!options.universe) throw new UsageError(`--universe is required\n${USAGE}`);
  if (!options.extraction) options.extraction = join(options.universe, EXTRACTION_PATH);
  let stats = null;
  try {
    stats = statSync(options.universe);
  } catch {
    stats = null;
  }
  if (!stats || !stats.isDirectory()) throw new UsageError(`the universe folder does not exist: ${options.universe}\n${USAGE}`);
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const result = validateImport({ universeDir: options.universe, extractionPath: options.extraction, range: options.range });
  emit(result);
  return result.ok ? EXIT_OK : EXIT_FAILED;
}

function runCli() {
  let status;
  try {
    status = main(process.argv.slice(2));
  } catch (error) {
    const usage = error instanceof UsageError;
    emit({
      schema_version: VALIDATION_SCHEMA_VERSION,
      ok: false,
      code: usage ? CODE_USAGE : 'INTERNAL',
      errors: [error?.message ?? String(error)],
      warnings: [],
    });
    status = EXIT_FAILED;
  }
  process.exitCode = status;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMainModule()) runCli();
