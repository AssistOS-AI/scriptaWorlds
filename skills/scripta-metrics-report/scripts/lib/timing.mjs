/**
 * AEG — author efficiency gain from opt-in timing records (C19).
 *
 * A timing study is opt-in data about human work: two matched tasks with an
 * accepted identity, a scope, active human minutes (writing plus revision),
 * interruption counts, a common quality criterion and the model-wait time kept
 * apart from human time. Nothing is tracked by default: without such a record
 * AEG is `not_assessable`, and a bare annotated number is unsupported legacy
 * data.
 *
 * `100 * (baseline - assisted) / baseline` is computed only for positive,
 * comparable baselines. A negative result (the assisted task took longer) is a
 * real result, not an error, and server elapsed time never enters the formula.
 */

import { fail, isNonNegativeInteger, isPlainObject } from './errors.mjs';

export const TIMING_SCHEMA_VERSION = 'timing-study.v1';
export const TIMING_ACCESSS = ['opt_in'];
const AGGREGATIONS = ['paired_gains', 'total_time'];
export const TIMING_ROW_FIELDS = ['active_minutes', 'revision_minutes', 'interruptions', 'accepted', 'criterion'];

function readSide(raw, label) {
  if (!isPlainObject(raw)) fail(`${label} must be an object`, 'INVALID_TIMING');
  if (raw.active_minutes === undefined || raw.active_minutes === null) {
    return { missing: `${label}.active_minutes`, row: null };
  }
  if (typeof raw.active_minutes !== 'number' || !Number.isFinite(raw.active_minutes) || raw.active_minutes < 0) {
    fail(`${label}.active_minutes must be a non-negative number, got ${JSON.stringify(raw.active_minutes)}`, 'INVALID_TIMING');
  }
  const revision = raw.revision_minutes === undefined || raw.revision_minutes === null ? 0 : raw.revision_minutes;
  if (typeof revision !== 'number' || !Number.isFinite(revision) || revision < 0) {
    fail(`${label}.revision_minutes must be a non-negative number when present`, 'INVALID_TIMING');
  }
  const interruptions = raw.interruptions === undefined || raw.interruptions === null ? 0 : raw.interruptions;
  if (!isNonNegativeInteger(interruptions)) {
    fail(`${label}.interruptions must be a non-negative integer when present`, 'INVALID_TIMING');
  }
  if (raw.accepted !== true && raw.accepted !== false) {
    fail(`${label}.accepted must state whether the work was accepted`, 'INVALID_TIMING');
  }
  if (typeof raw.criterion !== 'string' || raw.criterion.length === 0) {
    fail(`${label}.criterion must name the quality criterion the work was judged against`, 'INVALID_TIMING');
  }
  let modelWait = 0;
  if (raw.model_wait_minutes !== undefined && raw.model_wait_minutes !== null) {
    if (typeof raw.model_wait_minutes !== 'number' || !Number.isFinite(raw.model_wait_minutes) || raw.model_wait_minutes < 0) {
      fail(`${label}.model_wait_minutes must be a non-negative number when present`, 'INVALID_TIMING');
    }
    modelWait = raw.model_wait_minutes;
  }
  return {
    missing: null,
    row: {
      active_minutes: raw.active_minutes,
      revision_minutes: revision,
      human_minutes: raw.active_minutes + revision,
      interruptions,
      accepted: raw.accepted,
      criterion: raw.criterion,
      model_wait_minutes: modelWait,
    },
  };
}

/**
 * Build AEG from `annotations.timing` (`timing-study.v1`). `fallbackReason` is
 * used when no timing block was supplied at all.
 */
export function buildAeg(timing, { baseMetricFor, scope, fallbackReason, legacyAnnotation }) {
  const m = baseMetricFor('AEG', scope);
  m.value_kind = 'scalar';
  if (timing === undefined || timing === null) {
    if (legacyAnnotation && typeof legacyAnnotation.value === 'number') {
      m.detail = { legacy_value: legacyAnnotation.value };
      m.missing_reason =
        `unsupported legacy data: an annotated AEG of ${legacyAnnotation.value} without opt-in timing records is ` +
        'not a measurement; supply a timing-study.v1 record';
      return m;
    }
    m.missing_reason = fallbackReason;
    return m;
  }
  if (!isPlainObject(timing)) fail('annotations.timing must be an object', 'INVALID_TIMING');
  if (timing.schema_version !== TIMING_SCHEMA_VERSION) {
    fail(
      `annotations.timing.schema_version must be "${TIMING_SCHEMA_VERSION}", got ${JSON.stringify(timing.schema_version)}`,
      'SCHEMA_VERSION',
    );
  }
  if (timing.consent !== undefined && timing.consent !== 'opt_in') {
    fail('annotations.timing.consent must be "opt_in" when declared; human work is never tracked by default', 'INVALID_TIMING');
  }
  if (!Array.isArray(timing.studies) || timing.studies.length === 0) {
    fail('annotations.timing.studies must be a non-empty array of matched task records', 'INVALID_TIMING');
  }

  const included = [];
  const excluded = [];
  const seen = new Set();
  for (const study of timing.studies) {
    if (!isPlainObject(study)) fail('a timing study must be an object', 'INVALID_TIMING');
    const id = study.id;
    if (typeof id !== 'string' || id.length === 0) fail('a timing study must have a non-empty id', 'INVALID_TIMING');
    if (seen.has(id)) fail(`duplicate timing study id ${JSON.stringify(id)}`, 'DUPLICATE_ID');
    seen.add(id);
    if (typeof study.task_id !== 'string' || study.task_id.length === 0) {
      fail(`timing study ${JSON.stringify(id)} must name the task identity it measured`, 'INVALID_TIMING');
    }
    if (typeof study.scope !== 'string' || study.scope.length === 0) {
      fail(`timing study ${JSON.stringify(id)} must declare its scope`, 'INVALID_TIMING');
    }
    if (!AGGREGATIONS.includes(study.aggregation)) {
      fail(
        `timing study ${JSON.stringify(id)}.aggregation must be one of ${AGGREGATIONS.join('|')}; whether the study ` +
          'aggregates paired gains or total time must be fixed before the result is seen',
        'INVALID_TIMING',
      );
    }
    const baseline = readSide(study.baseline, `timing study ${JSON.stringify(id)}.baseline`);
    const assisted = readSide(study.assisted, `timing study ${JSON.stringify(id)}.assisted`);
    let serverElapsed = null;
    if (study.server_elapsed_minutes !== undefined && study.server_elapsed_minutes !== null) {
      if (typeof study.server_elapsed_minutes !== 'number' || study.server_elapsed_minutes < 0) {
        fail(`timing study ${JSON.stringify(id)}.server_elapsed_minutes must be a non-negative number`, 'INVALID_TIMING');
      }
      serverElapsed = study.server_elapsed_minutes;
    }
    const shared = { id, task_id: study.task_id, scope: study.scope, aggregation: study.aggregation, server_elapsed_minutes: serverElapsed };
    if (baseline.missing || assisted.missing) {
      excluded.push({ ...shared, reason: `no timing recorded for ${baseline.missing ?? assisted.missing}` });
      continue;
    }
    if (baseline.row.criterion !== assisted.row.criterion) {
      excluded.push({
        ...shared,
        reason:
          `unequal acceptance criteria ("${baseline.row.criterion}" vs "${assisted.row.criterion}"); tasks with ` +
          'different quality bars are not comparable as an efficiency gain',
      });
      continue;
    }
    if (baseline.row.accepted !== true || assisted.row.accepted !== true) {
      excluded.push({ ...shared, reason: 'the work was not accepted under the common criterion, so it is not comparable' });
      continue;
    }
    if (!(baseline.row.human_minutes > 0)) {
      excluded.push({ ...shared, reason: 'the baseline has no positive human time, so no gain can be computed' });
      continue;
    }
    included.push({
      ...shared,
      baseline_human_minutes: baseline.row.human_minutes,
      assisted_human_minutes: assisted.row.human_minutes,
      baseline_interruptions: baseline.row.interruptions,
      assisted_interruptions: assisted.row.interruptions,
      model_wait_minutes: assisted.row.model_wait_minutes + baseline.row.model_wait_minutes,
      agreed_criterion: baseline.row.criterion,
    });
  }

  m.detail = {
    schema_version: TIMING_SCHEMA_VERSION,
    consent: 'opt_in',
    studies: included.map((study) => ({
      id: study.id,
      task_id: study.task_id,
      scope: study.scope,
      aggregation: study.aggregation,
      baseline_human_minutes: study.baseline_human_minutes,
      assisted_human_minutes: study.assisted_human_minutes,
      gain_percent:
        (100 * (study.baseline_human_minutes - study.assisted_human_minutes)) / study.baseline_human_minutes,
      agreed_criterion: study.agreed_criterion,
      model_wait_minutes: study.model_wait_minutes,
      server_elapsed_minutes: study.server_elapsed_minutes,
    })),
    excluded,
    sample_size: included.length,
  };

  if (included.length === 0) {
    m.missing_reason =
      'no comparable opt-in timing study: ' +
      (excluded.length === 0 ? 'none supplied' : excluded.map((entry) => `${entry.id}: ${entry.reason}`).join('; '));
    return m;
  }
  const aggregations = new Set(included.map((study) => study.aggregation));
  if (aggregations.size > 1) {
    m.missing_reason =
      'the studies mix paired-gain and total-time aggregation; they are not a single comparable measure';
    return m;
  }
  const baselineTotal = included.reduce((total, study) => total + study.baseline_human_minutes, 0);
  const assistedTotal = included.reduce((total, study) => total + study.assisted_human_minutes, 0);
  m.status = 'computed';
  m.value = (100 * (baselineTotal - assistedTotal)) / baselineTotal;
  m.aggregation = [...aggregations][0];
  m.coverage = 1;
  m.detail.arithmetic =
    `100 * (${baselineTotal} - ${assistedTotal}) / ${baselineTotal} = ${m.value} ` +
    'over active human minutes (writing plus revision)';
  m.detail.model_wait_minutes_total = included.reduce((total, study) => total + study.model_wait_minutes, 0);
  m.detail.note =
    'server elapsed time and model-wait time are recorded separately and never counted as human effort';
  return m;
}
