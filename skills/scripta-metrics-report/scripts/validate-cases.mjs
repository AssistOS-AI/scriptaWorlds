#!/usr/bin/env node
/**
 * scripta-metrics-report — validate the synthetic literary case library.
 *
 *   node scripts/validate-cases.mjs [--fixtures <literary-cases-dir>]
 *
 * The command reads `index.json`, every case file it names and
 * `model-agreement.json`, and refuses the library when a case breaks its schema,
 * when a pair changes more than the one declared feature, when the language
 * counts or the reserved regression subset are not as declared, or when an
 * expected-evidence quote does not sit at its declared UTF-8 byte offsets.
 *
 * Standard output is exactly one JSON envelope. Exit status 0 means the library
 * is valid; status 2 means a refused library or invalid arguments, and nothing
 * is written either way. The command never calls a model and never hits the
 * network.
 */

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CliError, EXIT_PROCESSING, EXIT_USAGE, fail } from './lib/errors.mjs';
import { VALIDATION_SCHEMA_VERSION, checkLibrary, loadCaseLibrary } from './lib/case-library.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES = resolve(HERE, '..', 'fixtures', 'literary-cases');

const USAGE = 'Usage: node validate-cases.mjs [--fixtures <literary-cases-dir>]';

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function parseArgs(argv) {
  const options = { fixtures: DEFAULT_FIXTURES };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixtures') {
      const value = argv[index + 1];
      if (!value) fail(`--fixtures needs a directory argument\n${USAGE}`, 'INVALID_ARGUMENTS');
      options.fixtures = resolve(value);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      fail(USAGE, 'INVALID_ARGUMENTS');
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}\n${USAGE}`, 'INVALID_ARGUMENTS');
    }
  }
  return options;
}

function envelope(options, stats) {
  return {
    schema_version: VALIDATION_SCHEMA_VERSION,
    ok: true,
    library_id: stats.library_id,
    version: stats.version,
    fixtures_dir: options.fixtures,
    cases: stats.cases,
    by_language: stats.by_language,
    distinctions: stats.distinctions,
    counterexamples: stats.counterexamples,
    regression_cases: stats.regression_cases,
    regression_case_ids: stats.regression_case_ids,
    model_agreement_status: stats.model_agreement_status,
    human_benchmark: stats.human_benchmark,
    errors: [],
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const library = loadCaseLibrary(options.fixtures);
  const { ok, errors, stats } = checkLibrary(library);
  const identity = {
    library_id: library.index && library.index.library_id,
    version: library.index && library.index.version,
  };
  if (!ok) {
    emit({
      ...envelope(options, { ...identity, ...stats }),
      ok: false,
      error: `the case library is invalid: ${errors.length} problem(s)`,
      code: 'INVALID_CASE_LIBRARY',
      errors,
    });
    process.exitCode = EXIT_USAGE;
    return;
  }
  emit(envelope(options, { ...identity, ...stats }));
}

function runCli() {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const known = error instanceof CliError;
    emit({
      schema_version: VALIDATION_SCHEMA_VERSION,
      ok: false,
      error: known ? error.message : `Internal error: ${error && error.message ? error.message : String(error)}`,
      code: known ? error.code : 'INTERNAL',
      errors: [],
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
