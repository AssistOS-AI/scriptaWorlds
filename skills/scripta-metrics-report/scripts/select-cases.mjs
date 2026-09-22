#!/usr/bin/env node
/**
 * scripta-metrics-report — select teaching cases from the synthetic library.
 *
 *   node select-cases.mjs --language <ro|en|...> [--max <n>] [--fixtures <dir>]
 *
 * Prefers cases written in the book's language, fills the rest with English,
 * and never returns a case in the declared regression holdout. Standard output
 * is exactly one JSON envelope. Exit 0 means a selection was produced; exit 2
 * means invalid arguments. The command never calls a model and never hits the
 * network.
 */

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CliError, EXIT_PROCESSING, EXIT_USAGE, fail } from './lib/errors.mjs';
import {
  DEFAULT_CASE_LIBRARY,
  SELECTION_SCHEMA_VERSION,
  selectTeachingCases,
} from './lib/case-selection.mjs';

const USAGE = 'Usage: node select-cases.mjs --language <ro|en|...> [--max <n>] [--fixtures <literary-cases-dir>]';

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function parseArgs(argv) {
  const options = { language: null, max: 8, fixtures: DEFAULT_CASE_LIBRARY };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const need = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(`option ${name} requires a value\n${USAGE}`, 'INVALID_ARGUMENTS');
      index += 1;
      return value;
    };
    if (arg === '--language') options.language = need(arg);
    else if (arg === '--max') options.max = Number(need(arg));
    else if (arg === '--fixtures') options.fixtures = resolve(need(arg));
    else if (arg === '--help' || arg === '-h') fail(USAGE, 'INVALID_ARGUMENTS');
    else fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`, 'INVALID_ARGUMENTS');
  }
  if (!options.language) fail(`missing --language\n${USAGE}`, 'INVALID_ARGUMENTS');
  if (!Number.isInteger(options.max) || options.max < 0) {
    fail(`--max must be a non-negative integer\n${USAGE}`, 'INVALID_ARGUMENTS');
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  emit(selectTeachingCases({ language: options.language, maxSize: options.max, libraryRoot: options.fixtures }));
}

function runCli() {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const known = error instanceof CliError;
    emit({
      schema_version: SELECTION_SCHEMA_VERSION,
      ok: false,
      error: known ? error.message : `Internal error: ${error && error.message ? error.message : String(error)}`,
      code: known ? error.code : 'INTERNAL',
      cases: [],
    });
    process.exitCode = known ? error.exitCode : EXIT_PROCESSING;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) runCli();
