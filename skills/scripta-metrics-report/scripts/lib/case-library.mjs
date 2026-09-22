/**
 * The `literary-cases` library as a whole: the versioned index, the reserved
 * regression subset, the model-agreement record and the loading of every case
 * document. One case is validated by `scripts/lib/cases.mjs`; this module
 * checks the inventory against those documents and reports the counts the
 * validator command prints.
 *
 * The agreement record is deliberately strict: a record that claims a run must
 * carry that run's model identity, prompt and rubric versions, input hashes and
 * visible disagreements, so an invented agreement figure cannot be published as
 * if it had been measured.
 */

import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';

import { fail, isPlainObject, resolveInside } from './errors.mjs';
import {
  AGREEMENT_SCHEMA_VERSION,
  AGREEMENT_STATUSES,
  CASES_PER_LANGUAGE,
  DISTINCTIONS,
  INDEX_SCHEMA_VERSION,
  ISO_DATE_PATTERN,
  LIBRARY_LANGUAGES,
  MIN_REGRESSION_CASES,
  checkCase,
  distinctionById,
  isNonEmptyString,
  isStringArray,
} from './cases.mjs';

export const VALIDATION_SCHEMA_VERSION = 'literary-case-validation.v1';

const decoder = new TextDecoder('utf-8', { fatal: true });

function checkIndexCases(index, cases, caseFiles, errors) {
  const push = (message) => errors.push({ file: 'index.json', message });
  const entries = index.cases;
  if (!Array.isArray(entries) || entries.length === 0) {
    push('cases must be a non-empty array');
    return;
  }
  const seenIds = new Set();
  const flagged = [];
  entries.forEach((entry, position) => {
    const label = `cases[${position}]`;
    if (!isPlainObject(entry)) {
      push(`${label} must be a JSON object`);
      return;
    }
    if (!isNonEmptyString(entry.id)) {
      push(`${label}.id must be a non-empty string`);
      return;
    }
    if (seenIds.has(entry.id)) push(`duplicate case id ${JSON.stringify(entry.id)}`);
    seenIds.add(entry.id);
    if (entry.file !== `cases/${entry.id}.json`) {
      push(`${label}.file must be "cases/${entry.id}.json"`);
    }
    const known = cases.get(entry.id);
    if (!known) {
      if (caseFiles.has(entry.file)) push(`${label} names ${entry.file}, which declares a different id`);
      else push(`${label} names ${entry.file}, which is not present in the library`);
      return;
    }
    if (!isPlainObject(known)) {
      push(`${label} references an unreadable case document`);
      return;
    }
    ['language', 'target_distinction', 'kind'].forEach((key) => {
      if (entry[key] !== known[key]) {
        push(`${label}.${key} ${JSON.stringify(entry[key])} does not match the case document (${JSON.stringify(known[key])})`);
      }
    });
    if (entry.regression !== known.regression) {
      push(`${label}.regression ${JSON.stringify(entry.regression)} does not match the case document`);
    }
    if (entry.regression === true) flagged.push(entry.id);
  });

  const byLanguage = { ro: 0, en: 0 };
  cases.forEach((document) => {
    if (isPlainObject(document) && byLanguage[document.language] !== undefined) byLanguage[document.language] += 1;
  });
  LIBRARY_LANGUAGES.forEach((language) => {
    if (byLanguage[language] !== CASES_PER_LANGUAGE) {
      push(`language ${language} carries ${byLanguage[language]} cases; the library requires ${CASES_PER_LANGUAGE}`);
    }
  });
  if (cases.size !== entries.length) {
    push(`index declares ${entries.length} cases but ${cases.size} case documents are used`);
  }
  if (index.case_count !== entries.length) {
    push(`case_count ${JSON.stringify(index.case_count)} does not match the ${entries.length} indexed cases`);
  }

  const coverage = index.coverage;
  if (!isPlainObject(coverage)) {
    push('coverage must be a JSON object');
  } else {
    const required = coverage.required_distinctions;
    if (!isStringArray(required, { min: DISTINCTIONS.length })) {
      push('coverage.required_distinctions must list every target distinction');
    } else {
      DISTINCTIONS.forEach((entry) => {
        if (!required.includes(entry.id)) push(`coverage.required_distinctions omits ${entry.id}`);
      });
      required.forEach((id) => {
        if (!distinctionById(id)) push(`coverage.required_distinctions contains the unknown distinction ${id}`);
      });
      LIBRARY_LANGUAGES.forEach((language) => {
        const covered = new Set();
        cases.forEach((document) => {
          if (isPlainObject(document) && document.language === language) covered.add(document.target_distinction);
        });
        const missing = required.filter((id) => !covered.has(id));
        if (missing.length > 0) push(`language ${language} does not cover ${missing.join(', ')}`);
      });
    }
  }

  const subset = index.regression_subset;
  if (!isPlainObject(subset) || subset.declared !== true) {
    push('regression_subset must declare the reserved prompt-regression subset');
  } else {
    const ids = subset.case_ids;
    if (!isStringArray(ids, { min: MIN_REGRESSION_CASES })) {
      push(`regression_subset.case_ids must name at least ${MIN_REGRESSION_CASES} cases`);
    } else {
      if (new Set(ids).size !== ids.length) push('regression_subset.case_ids contains a duplicate');
      const missing = ids.filter((id) => !seenIds.has(id));
      if (missing.length > 0) push(`regression_subset.case_ids names unknown cases: ${missing.join(', ')}`);
      const sortedIds = [...ids].sort();
      const sortedFlagged = [...flagged].sort();
      if (sortedIds.join(',') !== sortedFlagged.join(',')) {
        push('regression_subset.case_ids must equal exactly the cases flagged regression: true');
      }
      const languages = new Set(ids.map((id) => (cases.get(id) || {}).language));
      LIBRARY_LANGUAGES.forEach((language) => {
        if (!languages.has(language)) push(`regression_subset must include at least one ${language} case`);
      });
    }
    if (!isNonEmptyString(subset.use)) push('regression_subset.use must explain how the subset is used');
  }

  if (index.human_benchmark !== false) {
    push('human_benchmark must be false: this library is never an independent human benchmark');
  }
  if (index.label !== 'synthetic') push('label must be "synthetic"');
  ['library_id', 'version', 'purpose', 'label_statement'].forEach((key) => {
    if (!isNonEmptyString(index[key])) push(`${key} must be a non-empty string`);
  });
  if (!Array.isArray(index.languages) || index.languages.join(',') !== LIBRARY_LANGUAGES.join(',')) {
    push(`languages must be exactly ${JSON.stringify(LIBRARY_LANGUAGES)}`);
  }
}

const AGREEMENT_RUN_KEYS = Object.freeze(['model', 'prompt_version', 'rubric_version', 'date', 'recorded_by']);

/** Validate the model-agreement record. An unperformed record must stay empty. */
export function checkAgreement(raw, file = 'model-agreement.json') {
  const errors = [];
  const push = (message) => errors.push({ file, message });
  if (!isPlainObject(raw)) {
    push('model-agreement record must be a JSON object');
    return errors;
  }
  if (raw.schema_version !== AGREEMENT_SCHEMA_VERSION) {
    push(`unsupported schema_version ${JSON.stringify(raw.schema_version)}; expected ${JSON.stringify(AGREEMENT_SCHEMA_VERSION)}`);
    return errors;
  }
  if (!AGREEMENT_STATUSES.includes(raw.status)) {
    push(`status must be one of ${AGREEMENT_STATUSES.join('|')}`);
  }
  ['summary', 'honesty_note'].forEach((key) => {
    if (!isNonEmptyString(raw[key])) push(`${key} must be a non-empty string`);
  });
  const runs = Array.isArray(raw.runs) ? raw.runs : null;
  const failures = Array.isArray(raw.failures) ? raw.failures : null;
  if (!runs) push('runs must be an array');
  if (!failures) push('failures must be an array');
  if (raw.status === 'unperformed') {
    if (raw.performed_at !== null) push('performed_at must be null while no run has been performed');
    if (runs && runs.length > 0) push('an unperformed record must not carry runs');
    if (failures && failures.length > 0) push('an unperformed record must not carry failures');
  } else if (runs && runs.length === 0) {
    push(`status ${JSON.stringify(raw.status)} requires at least one recorded run`);
  }
  (runs || []).forEach((run, index) => {
    const label = `runs[${index}]`;
    if (!isPlainObject(run)) {
      push(`${label} must be a JSON object`);
      return;
    }
    AGREEMENT_RUN_KEYS.forEach((key) => {
      if (!isNonEmptyString(run[key])) push(`${label}.${key} must be a non-empty string`);
    });
    if (!ISO_DATE_PATTERN.test(String(run.date))) push(`${label}.date must be an ISO date`);
    if (!Number.isInteger(run.cases_attempted) || run.cases_attempted < 1) push(`${label}.cases_attempted must be a positive integer`);
    if (!Number.isInteger(run.cases_agreed) || run.cases_agreed < 0) push(`${label}.cases_agreed must be a non-negative integer`);
    if (Number.isInteger(run.cases_attempted) && Number.isInteger(run.cases_agreed) && run.cases_agreed > run.cases_attempted) {
      push(`${label}.cases_agreed cannot exceed cases_attempted`);
    }
    if (!Array.isArray(run.disagreements)) push(`${label}.disagreements must be an array, empty when the judge agreed everywhere`);
    if (!isNonEmptyString(run.prompt_hash) && !isNonEmptyString(run.input_hashes)) {
      push(`${label} must record prompt_hash or input_hashes so the judging inputs can be identified`);
    }
  });
  (failures || []).forEach((failure, index) => {
    const label = `failures[${index}]`;
    if (!isPlainObject(failure)) {
      push(`${label} must be a JSON object`);
      return;
    }
    if (!isNonEmptyString(failure.case_id)) push(`${label}.case_id must be a non-empty string`);
    if (!isNonEmptyString(failure.reason)) push(`${label}.reason must be a non-empty string`);
  });
  const human = raw.human_study;
  if (!isPlainObject(human) || !['not_performed', 'performed'].includes(human.status)) {
    push('human_study.status must be "not_performed" or "performed"');
  } else if (!isNonEmptyString(human.note)) {
    push('human_study.note must be a non-empty string');
  }
  return errors;
}

/** Read and validate every document of the library. Pure reads, no writes. */
export function loadCaseLibrary(root) {
  const indexPath = resolveInside(root, 'index.json');
  const agreementPath = resolveInside(root, 'model-agreement.json');
  const index = readJson(indexPath, 'library index');
  const agreement = readJson(agreementPath, 'model-agreement record');
  const cases = new Map();
  const caseFiles = new Set();
  if (isPlainObject(index) && Array.isArray(index.cases)) {
    index.cases.forEach((entry) => {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.file)) return;
      const file = resolveInside(root, entry.file);
      caseFiles.add(entry.file);
      cases.set(isNonEmptyString(entry.id) ? entry.id : entry.file, readJson(file, entry.file));
    });
  }
  return { root, indexPath, agreementPath, index, agreement, cases, caseFiles };
}

function readJson(file, label) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`, 'MISSING_FILE');
  }
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`, 'BAD_JSON');
  }
}

/**
 * Validate a loaded library. Returns `{ ok, errors, stats }`; every problem is
 * a `{ file, message }` pair so a caller can report the offending document.
 */
export function checkLibrary(library) {
  const errors = [];
  if (!isPlainObject(library.index)) {
    errors.push({ file: 'index.json', message: 'library index must be a JSON object' });
  } else {
    if (library.index.schema_version !== INDEX_SCHEMA_VERSION) {
      errors.push({
        file: 'index.json',
        message: `unsupported schema_version ${JSON.stringify(library.index.schema_version)}; expected ${JSON.stringify(INDEX_SCHEMA_VERSION)}`,
      });
    } else {
      library.cases.forEach((document, id) => {
        errors.push(...checkCase(document, `cases/${id}.json`));
      });
      checkIndexCases(library.index, library.cases, library.caseFiles, errors);
    }
  }
  errors.push(...checkAgreement(library.agreement, 'model-agreement.json'));

  const byLanguage = { ro: 0, en: 0 };
  const distinctions = new Map();
  let counterexamples = 0;
  library.cases.forEach((document) => {
    if (!isPlainObject(document)) return;
    if (byLanguage[document.language] !== undefined) byLanguage[document.language] += 1;
    distinctions.set(document.target_distinction, (distinctions.get(document.target_distinction) || 0) + 1);
    if (document.kind === 'counterexample') counterexamples += 1;
  });
  const regressionIds = Array.isArray(library.index && library.index.regression_subset && library.index.regression_subset.case_ids)
    ? [...library.index.regression_subset.case_ids]
    : [];
  return {
    ok: errors.length === 0,
    errors,
    stats: {
      cases: library.cases.size,
      by_language: byLanguage,
      distinctions: distinctions.size,
      counterexamples,
      regression_cases: regressionIds.length,
      regression_case_ids: regressionIds.sort(),
      model_agreement_status: library.agreement && library.agreement.status,
      human_benchmark: false,
    },
  };
}
