/**
 * CR — contamination rate with real dataset provenance (C20).
 *
 * CR needs a declared training-dataset record: model/data identity, an
 * available corpus or a documented subset, the evaluation population, the
 * overlap criterion, access and provenance, coverage, and the counts of the
 * items that were actually checked and that met the criterion. The rate is
 * computed from those counts; a declared `value` is only verified against them.
 *
 * An inaccessible training set returns `not_assessable`. A partial known subset
 * supports a qualified, bounded finding and never a claim of zero contamination
 * across training: a zero is allowed only when the declared measurable
 * population was actually checked. Every referenced file is read locally and
 * its hash recomputed; nothing is ever downloaded, and a convenient reference
 * library stays a separate `known_corpus_overlap` diagnostic.
 */

import { dirname } from 'node:path';

import { fail, isPlainObject, isPositiveInteger, isSha256Hex, readBytesChecked, resolveInside, sha256Hex } from './errors.mjs';

export const TRAINING_DATASET_FIELDS = [
  'model_identity',
  'corpus',
  'evaluation_population',
  'overlap_criterion',
  'access',
  'provenance',
  'coverage',
  'checked_items',
  'matched_items',
];
export const DATASET_ACCESS = ['available', 'partial_subset', 'inaccessible'];

function readRequiredString(raw, id) {
  if (typeof raw !== 'string' || raw.length === 0) {
    fail(`training_dataset.${id} must be a non-empty string`, 'INVALID_TRAINING_DATASET');
  }
  return raw;
}

function verifyCorpusFiles(corpus, id, annotationsDir) {
  if (!isPlainObject(corpus)) {
    fail(`training_dataset.corpus must be an object describing the available corpus or documented subset`, 'INVALID_TRAINING_DATASET');
  }
  readRequiredString(corpus.description, `${id}.corpus.description`);
  const files = corpus.files;
  if (!Array.isArray(files) || files.length === 0) {
    fail(
      `training_dataset.corpus.files must declare at least one locally available file with its sha256; ` +
        'a dataset is never downloaded and a claim needs a verifiable artefact',
      'INVALID_TRAINING_DATASET',
    );
  }
  const verified = [];
  for (const file of files) {
    if (!isPlainObject(file) || typeof file.path !== 'string' || file.path.length === 0) {
      fail('training_dataset.corpus.files entries must declare a relative path', 'INVALID_TRAINING_DATASET');
    }
    if (!isSha256Hex(file.sha256)) {
      fail(`training dataset file ${JSON.stringify(file.path)} must declare its sha256`, 'INVALID_TRAINING_DATASET');
    }
    const full = resolveInside(annotationsDir, file.path);
    const bytes = readBytesChecked(full, `training dataset file ${JSON.stringify(file.path)}`);
    const actual = sha256Hex(bytes);
    if (actual !== file.sha256) {
      fail(
        `training dataset file ${JSON.stringify(file.path)} sha256 mismatch: expected ${file.sha256}, computed ${actual}`,
        'HASH_MISMATCH',
      );
    }
    verified.push({ path: file.path, sha256: actual, bytes: bytes.length });
  }
  return { description: corpus.description, files: verified };
}

/**
 * Build CR from `annotations.metrics.CR`. `annotationsDir` is the directory the
 * annotations document lives in; dataset file paths resolve inside it.
 */
export function buildCr(annotation, { baseMetricFor, scope, annotationsDir }) {
  const m = baseMetricFor('CR', scope);
  m.value_kind = 'scalar';
  if (annotation === undefined || annotation === null) {
    m.missing_reason = 'no relevant training dataset declared; CR is never reported as zero without one';
    return m;
  }
  if (!isPlainObject(annotation)) fail('annotations.metrics.CR must be an object', 'INVALID_ANNOTATIONS');
  const dataset = annotation.training_dataset;
  if (dataset === undefined || dataset === null) {
    const legacy = typeof annotation.value === 'number' ? annotation.value : null;
    m.missing_reason =
      legacy === null
        ? 'no relevant training dataset declared; CR is never reported as zero without one'
        : `unsupported legacy data: a bare CR value of ${legacy} without a training-dataset record cannot measure ` +
          'contamination';
    if (legacy !== null) m.detail = { legacy_value: legacy };
    return m;
  }
  if (!isPlainObject(dataset)) fail('annotations.metrics.CR.training_dataset must be an object', 'INVALID_TRAINING_DATASET');
  const missing = TRAINING_DATASET_FIELDS.filter((field) => dataset[field] === undefined || dataset[field] === null);
  if (missing.length > 0) {
    fail(
      `annotations.metrics.CR.training_dataset is not a usable record; missing ${missing.join(', ')}. ` +
        'A dataset declaration needs model/data identity, an available corpus or documented subset, the evaluation ' +
        'population, the overlap criterion, access and provenance, coverage and the checked/matched counts.',
      'INVALID_TRAINING_DATASET',
    );
  }
  const id = 'annotations.metrics.CR.training_dataset';
  const modelIdentity = readRequiredString(dataset.model_identity, `${id}.model_identity`);
  const criterion = readRequiredString(dataset.overlap_criterion, `${id}.overlap_criterion`);
  const provenance = readRequiredString(dataset.provenance, `${id}.provenance`);
  if (!DATASET_ACCESS.includes(dataset.access)) {
    fail(
      `${id}.access must be one of ${DATASET_ACCESS.join('|')}, got ${JSON.stringify(dataset.access)}`,
      'INVALID_TRAINING_DATASET',
    );
  }
  const population = dataset.evaluation_population;
  if (!isPlainObject(population)) fail(`${id}.evaluation_population must be an object`, 'INVALID_TRAINING_DATASET');
  readRequiredString(population.description, `${id}.evaluation_population.description`);
  if (!isPositiveInteger(population.items)) {
    fail(`${id}.evaluation_population.items must be a positive integer`, 'INVALID_TRAINING_DATASET');
  }
  if (typeof dataset.coverage !== 'number' || dataset.coverage < 0 || dataset.coverage > 1) {
    fail(`${id}.coverage must be a number in 0..1`, 'INVALID_TRAINING_DATASET');
  }
  if (!Number.isInteger(dataset.checked_items) || dataset.checked_items < 0) {
    fail(`${id}.checked_items must be a non-negative integer`, 'INVALID_TRAINING_DATASET');
  }
  if (!Number.isInteger(dataset.matched_items) || dataset.matched_items < 0) {
    fail(`${id}.matched_items must be a non-negative integer`, 'INVALID_TRAINING_DATASET');
  }
  if (dataset.checked_items > population.items) {
    fail(`${id}.checked_items (${dataset.checked_items}) exceeds the declared population (${population.items})`, 'INVALID_TRAINING_DATASET');
  }
  if (dataset.matched_items > dataset.checked_items) {
    fail(`${id}.matched_items (${dataset.matched_items}) exceeds checked_items (${dataset.checked_items})`, 'INVALID_TRAINING_DATASET');
  }
  const actualCoverage = dataset.checked_items / population.items;
  if (Math.abs(actualCoverage - dataset.coverage) > 1e-9) {
    fail(
      `${id}.coverage ${dataset.coverage} does not match the checked population ` +
        `(${dataset.checked_items}/${population.items} = ${actualCoverage})`,
      'INVALID_TRAINING_DATASET',
    );
  }
  if (dataset.access === 'inaccessible') {
    m.status = 'not_assessable';
    m.detail = { training_dataset: { model_identity: modelIdentity, access: dataset.access, provenance } };
    m.missing_reason =
      `the relevant training set is inaccessible (${provenance}); CR cannot be assessed and is not reported as zero`;
    return m;
  }
  const verifiedCorpus = verifyCorpusFiles(dataset.corpus, id, annotationsDir);
  if (dataset.checked_items === 0) {
    m.detail = { training_dataset: { model_identity: modelIdentity, access: dataset.access, coverage: dataset.coverage } };
    m.missing_reason =
      'no evaluation item was actually checked; zero is not a measurement, so CR stays unavailable';
    return m;
  }
  const value = (100 * dataset.matched_items) / dataset.checked_items;
  if (annotation.value !== undefined && annotation.value !== null) {
    if (typeof annotation.value !== 'number' || Math.abs(annotation.value - value) > 1e-9) {
      fail(
        `annotations.metrics.CR.value ${JSON.stringify(annotation.value)} does not match the declared ` +
          `checked/matched counts (${dataset.matched_items}/${dataset.checked_items} = ${value})`,
        'INVALID_TRAINING_DATASET',
      );
    }
  }
  const qualified = dataset.access === 'partial_subset' || dataset.coverage < 1;
  m.status = 'computed';
  m.value = value;
  m.coverage = dataset.coverage;
  m.qualified = qualified;
  m.evaluator = typeof annotation.evaluator === 'string' ? annotation.evaluator : null;
  m.detail = {
    training_dataset: {
      model_identity: modelIdentity,
      corpus: verifiedCorpus,
      evaluation_population: population,
      overlap_criterion: criterion,
      access: dataset.access,
      provenance,
      coverage: dataset.coverage,
      checked_items: dataset.checked_items,
      matched_items: dataset.matched_items,
      qualified,
    },
    arithmetic: `100 * ${dataset.matched_items} / ${dataset.checked_items} = ${value}`,
    note: qualified
      ? `limited finding: only ${dataset.coverage * 100}% of the declared population was actually checked, so this ` +
        'rate is bounded to that subset and says nothing about the rest of training'
      : 'the declared measurable population was fully checked',
    known_corpus_overlap_separate: annotation.known_corpus_overlap ?? null,
  };
  if (typeof annotation.known_corpus_overlap !== 'undefined' && annotation.known_corpus_overlap !== null) {
    m.detail.note += '; a known-corpus overlap diagnostic is reported separately and is not training contamination';
  }
  return m;
}

/** Directory that the dataset file paths resolve inside. */
export function annotationsBaseDir(annotationsPath) {
  return dirname(annotationsPath);
}
