/**
 * Judged rubric metrics with a discriminated output (C16, C17).
 *
 * Three metric families cannot be a single number:
 *
 *   CS   four anchored dimensions — referential clarity, discourse connection,
 *        causal support, temporal intelligibility. The experimental scalar
 *        `100 * sum(ratings) / (scale * 4)` exists only when all four
 *        dimensions are assessable under one declared rubric version.
 *   OI   three anchored dimensions — perspective, dramatic development,
 *        expression — against an explicitly declared comparison scope; the
 *        experimental scalar is `100 * sum(ratings) / (scale * 3)`.
 *   NCS  two anchored dimensions, novelty and cliché reliance, each with its
 *        own rationale and evidence. No combined score is enabled before
 *        calibration.
 *   EAP  an ordered trajectory of segments with focalization, valence,
 *        tension/intensity, evidence and uncertainty. The emotional-fit
 *        judgement NQS needs is kept separate from the trajectory, and a quiet
 *        aftermath is never penalized for its low intensity: no scalar is
 *        derived from the series.
 *
 * A bare numeric value for any of these metrics is unsupported legacy data: it
 * is recorded as such and never becomes a judged score. A missing dimension
 * keeps the scalar unavailable instead of producing a full score.
 */

import { fail, isPlainObject } from './errors.mjs';
import { ANCHOR_SCALE, COMPONENT_SPECS } from './registry.mjs';
import { applyJudgedFields, baseMetric } from './metrics.mjs';

export const RUBRIC_VERSION = 'rubric-anchors.v1';
export const SUPPORTED_RUBRIC_VERSIONS = [RUBRIC_VERSION];
export const EAP_ORDERINGS = ['disclosure', 'story'];
const JUDGED_STATUSES = ['judged', 'not_assessable', 'not_applicable', 'error'];

/** Read and validate the optional `rubric` block of the evaluation profile. */
export function parseRubricProfile(raw) {
  if (raw === undefined || raw === null) {
    return { version: RUBRIC_VERSION, scale: ANCHOR_SCALE, declared: false };
  }
  if (!isPlainObject(raw)) fail('profile.rubric must be an object', 'INVALID_PROFILE');
  const version = raw.version === undefined ? RUBRIC_VERSION : raw.version;
  if (!SUPPORTED_RUBRIC_VERSIONS.includes(version)) {
    fail(
      `unsupported profile.rubric.version ${JSON.stringify(version)}; ` +
        `supported: ${SUPPORTED_RUBRIC_VERSIONS.join(', ')}`,
      'SCHEMA_VERSION',
    );
  }
  const scale = raw.scale === undefined ? ANCHOR_SCALE : raw.scale;
  if (scale !== ANCHOR_SCALE) {
    fail(
      `profile.rubric.scale ${JSON.stringify(scale)} is not the anchored ${ANCHOR_SCALE}-point scale of ` +
        `${version}`,
      'INVALID_PROFILE',
    );
  }
  return { version, scale, declared: true };
}

function legacyScalar(annotation) {
  if (!isPlainObject(annotation)) return null;
  for (const key of ['value', 'rating', 'score']) {
    if (typeof annotation[key] === 'number') return { field: key, value: annotation[key] };
  }
  return null;
}

function readEvidenceRefs(raw, label, { required }) {
  if (raw === undefined || raw === null) {
    if (required) fail(`${label} must carry at least one evidence id`, 'INVALID_ANNOTATIONS');
    return [];
  }
  if (!Array.isArray(raw) || raw.some((ref) => typeof ref !== 'string' || ref.length === 0)) {
    fail(`${label} must be an array of non-empty evidence ids`, 'INVALID_ANNOTATIONS');
  }
  if (required && raw.length === 0) fail(`${label} must carry at least one evidence id`, 'INVALID_ANNOTATIONS');
  return [...raw];
}

function readOptionalString(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(`${label} must be a string or null`, 'INVALID_ANNOTATIONS');
  return value.length === 0 ? null : value;
}

function readDimension(id, name, raw, rubric) {
  const label = `annotations.metrics.${id}.dimensions.${name}`;
  if (!isPlainObject(raw)) fail(`${label} must be an object with a rating, rationale and evidence`, 'INVALID_ANNOTATIONS');
  if (!Number.isInteger(raw.rating) || raw.rating < 0 || raw.rating > rubric.scale) {
    fail(`${label}.rating must be an integer in 0..${rubric.scale}, got ${JSON.stringify(raw.rating)}`, 'INVALID_ANNOTATIONS');
  }
  if (typeof raw.rationale !== 'string' || raw.rationale.length === 0) {
    fail(`${label}.rationale must be a non-empty string`, 'INVALID_ANNOTATIONS');
  }
  const evidence = readEvidenceRefs(raw.evidence, `${label}.evidence`, { required: true });
  return {
    dimension: name,
    rating: raw.rating,
    rationale: raw.rationale,
    evidence,
    evaluator: readOptionalString(raw.evaluator, `${label}.evaluator`),
  };
}

function scalarFromDimensions(dimensions, scale) {
  const sum = dimensions.reduce((total, dimension) => total + dimension.rating, 0);
  return (100 * sum) / (scale * dimensions.length);
}

/**
 * Build CS, OI or NCS from its dimension annotations.
 *
 * `legacyReason` (when the annotation is absent) is the fallback explanation.
 */
export function buildComponentMetric(id, annotation, { scope, rubric, fallbackReason }) {
  const spec = COMPONENT_SPECS[id];
  const m = baseMetric(id, scope);
  m.value_kind = 'components';
  m.rubric_version = rubric.version;
  m.detail = { rubric: { version: rubric.version, scale: rubric.scale }, missing_dimensions: [] };
  m.components = {};
  if (annotation === undefined || annotation === null) {
    m.missing_reason = fallbackReason;
    return m;
  }
  if (!isPlainObject(annotation)) fail(`annotations.metrics.${id} must be an object`, 'INVALID_ANNOTATIONS');
  const status = annotation.status === undefined ? 'judged' : annotation.status;
  if (!JUDGED_STATUSES.includes(status)) {
    fail(`annotations.metrics.${id} has unknown status ${JSON.stringify(status)}`, 'INVALID_ANNOTATIONS');
  }
  applyJudgedFields(m, annotation, id);
  m.status = status;
  // A declared judgement that cannot rest on its components is unavailable.
  const demote = () => {
    if (status === 'judged') m.status = 'not_assessable';
  };

  const rawDimensions = annotation[spec.input_key];
  if (rawDimensions === undefined || rawDimensions === null) {
    const legacy = legacyScalar(annotation);
    demote();
    if (legacy) {
      m.detail.legacy_value = legacy.value;
      m.missing_reason =
        `unsupported legacy data: a bare ${legacy.field} of ${legacy.value} cannot be ${id}; the ` +
        `${spec.components.length} anchored dimensions (${spec.components.join(', ')}) are required`;
      return m;
    }
    m.missing_reason = `no ${spec.input_key} supplied; ${id} requires ${spec.components.join(', ')}`;
    return m;
  }
  if (!isPlainObject(rawDimensions)) {
    fail(`annotations.metrics.${id}.${spec.input_key} must be an object`, 'INVALID_ANNOTATIONS');
  }
  for (const key of Object.keys(rawDimensions)) {
    if (!spec.components.includes(key)) {
      fail(`annotations.metrics.${id}.${spec.input_key} has unknown dimension ${JSON.stringify(key)}`, 'INVALID_ANNOTATIONS');
    }
  }
  if (spec.requires_comparison_scope) {
    const comparisonScope = readOptionalString(annotation.comparison_scope, `annotations.metrics.${id}.comparison_scope`);
    if (comparisonScope === null) {
      fail(
        `annotations.metrics.${id}.comparison_scope must name the references the judgement was made against`,
        'INVALID_ANNOTATIONS',
      );
    }
    m.comparison_scope = comparisonScope;
  }

  const dimensions = [];
  for (const name of spec.components) {
    if (rawDimensions[name] === undefined || rawDimensions[name] === null) {
      m.detail.missing_dimensions.push(name);
      continue;
    }
    const dimension = readDimension(id, name, rawDimensions[name], rubric);
    dimensions.push(dimension);
    m.components[name] = dimension;
  }
  if (m.detail.missing_dimensions.length === dimensions.length) {
    demote();
    m.missing_reason = `no anchored dimension supplied; ${id} requires ${spec.components.join(', ')}`;
    return m;
  }
  m.evaluator = m.evaluator ?? dimensions.find((dimension) => dimension.evaluator)?.evaluator ?? null;
  m.evidence = [...new Set(dimensions.flatMap((dimension) => dimension.evidence))];
  m.coverage = dimensions.length / spec.components.length;
  if (m.detail.missing_dimensions.length > 0) {
    demote();
    m.missing_reason =
      `dimension${m.detail.missing_dimensions.length === 1 ? '' : 's'} ` +
      `${m.detail.missing_dimensions.join(', ')} not assessable; a partial profile never yields a full ${id} score`;
    return m;
  }
  if (spec.pair_only) {
    m.missing_reason =
      'no combined NCS is enabled: the two dimensions stay separate until their trade-offs are calibrated';
    return m;
  }
  // A value exists only for a judged metric. Unavailable, inapplicable and failed results keep their
  // components as diagnostic detail but never produce a number an aggregate could consume.
  if (m.status === 'judged') {
    m.value = scalarFromDimensions(dimensions, rubric.scale);
    m.detail.arithmetic =
      `100 * (${dimensions.map((dimension) => dimension.rating).join(' + ')}) / ` +
      `(${rubric.scale} * ${dimensions.length}) = ${m.value}`;
  }
  return m;
}

/**
 * Build EAP as an ordered trajectory over a declared population.
 *
 * `segmentIds` are every segment the annotations declared, so a trajectory point
 * can be tied to a real boundary; `selectedSegmentIds` are the scenes the
 * resolved selection covers, which is the population the trajectory is measured
 * against. The received array order is the disclosure order and is kept on every
 * point as `disclosure_index`; the published series is ordered by the declared
 * chronology, which has to name `story_order` for every point, without a tie,
 * before it can be claimed. Coverage is the fraction of the selected scenes the
 * trajectory actually assessed, the omissions and any point outside the selection
 * are reported, and one segment is one reading per focalization — a second
 * reading of the same scene by the same voice is a duplicate, while a different
 * focalization keeps its own trajectory. A quiet point is a description of the
 * arc: no defect and no scalar follow from its low tension.
 */
export function buildEap(annotation, { scope, segmentIds, selectedSegmentIds = null, fallbackReason }) {
  const m = baseMetric('EAP', scope);
  m.value_kind = 'trajectory';
  if (annotation === undefined || annotation === null) {
    m.missing_reason = fallbackReason;
    return m;
  }
  if (!isPlainObject(annotation)) fail('annotations.metrics.EAP must be an object', 'INVALID_ANNOTATIONS');
  const status = annotation.status === undefined ? 'judged' : annotation.status;
  if (!JUDGED_STATUSES.includes(status)) {
    fail(`annotations.metrics.EAP has unknown status ${JSON.stringify(status)}`, 'INVALID_ANNOTATIONS');
  }
  applyJudgedFields(m, annotation, 'EAP');
  const raw = annotation.trajectory;
  if (raw === undefined || raw === null) {
    const legacy = legacyScalar(annotation);
    m.status = status === 'judged' ? 'not_assessable' : status;
    if (legacy) {
      m.detail = { legacy_value: legacy.value };
      m.missing_reason =
        `unsupported legacy data: a bare EAP ${legacy.field} of ${legacy.value} is not an ordered trajectory; ` +
        'EAP needs valence, tension, focalization, evidence and uncertainty per segment';
      return m;
    }
    m.missing_reason =
      'an emotional-fit judgement alone is not an emotional arc; EAP needs its ordered segment trajectory';
    return m;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    fail('annotations.metrics.EAP.trajectory must be a non-empty array of segment records', 'INVALID_ANNOTATIONS');
  }
  const known = new Set(segmentIds);
  const declaredOrdering = annotation.ordering === undefined || annotation.ordering === null ? null : annotation.ordering;
  const usesStoryOrder = raw.some((point) => isPlainObject(point) && point.story_order !== undefined && point.story_order !== null);
  if (usesStoryOrder && !EAP_ORDERINGS.includes(declaredOrdering)) {
    fail(
      'annotations.metrics.EAP.ordering must be "disclosure" or "story" when a trajectory declares story_order: ' +
        'a mixed story-time/disclosure-time series has to state which order it uses',
      'INVALID_ANNOTATIONS',
    );
  }
  const trajectory = raw.map((point, index) => {
    const label = `annotations.metrics.EAP.trajectory[${index}]`;
    if (!isPlainObject(point)) fail(`${label} must be an object`, 'INVALID_ANNOTATIONS');
    const segmentId = point.segment_id;
    if (typeof segmentId !== 'string' || segmentId.length === 0) {
      fail(`${label}.segment_id must be a non-empty segment id`, 'INVALID_ANNOTATIONS');
    }
    if (!known.has(segmentId)) {
      fail(`${label}.segment_id ${JSON.stringify(segmentId)} is not a declared segment`, 'UNKNOWN_SEGMENT');
    }
    const valence = point.valence;
    if (typeof valence !== 'number' || Number.isNaN(valence) || valence < -2 || valence > 2) {
      fail(`${label}.valence must be a number in -2..2, got ${JSON.stringify(valence)}`, 'OUT_OF_RANGE');
    }
    const tension = point.tension;
    if (typeof tension !== 'number' || Number.isNaN(tension) || tension < 0 || tension > 4) {
      fail(`${label}.tension must be a number in 0..4, got ${JSON.stringify(tension)}`, 'OUT_OF_RANGE');
    }
    const evidence = readEvidenceRefs(point.evidence, `${label}.evidence`, { required: true });
    if (typeof point.uncertainty !== 'string' || point.uncertainty.length === 0) {
      fail(`${label}.uncertainty must state what is uncertain about the reading`, 'INVALID_ANNOTATIONS');
    }
    let storyOrder = null;
    if (point.story_order !== undefined && point.story_order !== null) {
      if (!Number.isInteger(point.story_order) || point.story_order < 0) {
        fail(`${label}.story_order must be a non-negative integer`, 'INVALID_ANNOTATIONS');
      }
      storyOrder = point.story_order;
    }
    return {
      segment_id: segmentId,
      disclosure_index: index,
      story_order: storyOrder,
      focalization: readOptionalString(point.focalization, `${label}.focalization`),
      valence,
      tension,
      evidence,
      uncertainty: point.uncertainty,
    };
  });

  // A declared chronology has to be complete and unambiguous before the series may claim it.
  if (declaredOrdering === 'story') {
    const missing = trajectory.filter((point) => point.story_order === null).map((point) => point.segment_id);
    if (missing.length > 0) {
      fail(
        `annotations.metrics.EAP.ordering is "story" but ${missing.join(', ')} declare no story_order; the series ` +
          'cannot claim a chronology it does not state for every point',
        'INVALID_ANNOTATIONS',
      );
    }
  }
  const declaredOrders = trajectory.filter((point) => point.story_order !== null).map((point) => point.story_order);
  if (new Set(declaredOrders).size !== declaredOrders.length) {
    fail(
      'annotations.metrics.EAP.trajectory declares the same story_order twice; a chronology with a tie cannot be ' +
        'published as an order',
      'INVALID_ANNOTATIONS',
    );
  }

  // One segment is one reading per focalization: a second reading by the same voice is a duplicate.
  const readings = new Set();
  for (const point of trajectory) {
    const key = `${point.segment_id}\u0000${point.focalization ?? ''}`;
    if (readings.has(key)) {
      fail(
        `annotations.metrics.EAP.trajectory assesses segment ${JSON.stringify(point.segment_id)} twice for the same ` +
          `focalization${point.focalization ? ` (${JSON.stringify(point.focalization)})` : ''}; one reading per ` +
          'segment and voice is a trajectory point, a second one is a duplicate',
        'INVALID_ANNOTATIONS',
      );
    }
    readings.add(key);
  }

  const receivedOrder = trajectory.map((point) => point.disclosure_index);
  const published = declaredOrdering === 'story' ? [...trajectory].sort((a, b) => a.story_order - b.story_order) : [...trajectory];
  m.ordering = declaredOrdering === 'story' ? 'story' : 'disclosure';
  m.status = status === 'judged' ? 'judged' : status;
  m.trajectory = published;
  m.evidence = [...new Set(trajectory.flatMap((point) => point.evidence))];

  const selected = selectedSegmentIds === null ? [...segmentIds] : [...selectedSegmentIds];
  const selectedSet = new Set(selected);
  const assessedIds = [];
  for (const point of published) if (!assessedIds.includes(point.segment_id)) assessedIds.push(point.segment_id);
  const assessedSelected = assessedIds.filter((id) => selectedSet.has(id));
  const omitted = selected.filter((id) => !assessedIds.includes(id));
  const outside = assessedIds.filter((id) => !selectedSet.has(id));

  const byFocalization = new Map();
  for (const point of published) {
    const key = point.focalization ?? null;
    if (!byFocalization.has(key)) byFocalization.set(key, []);
    if (!byFocalization.get(key).includes(point.segment_id)) byFocalization.get(key).push(point.segment_id);
  }
  const tensions = published.map((point) => point.tension);
  const lowTension = published.filter((point) => point.tension <= 1).map((point) => point.segment_id);
  const notes = [
    'a quiet aftermath keeps its low intensity; high tension is not automatically good and no scalar is ' +
      'derived from this series',
  ];
  if (lowTension.length > 0) {
    notes.push(`low tension at ${lowTension.join(', ')} describes the arc as it was read; it is not a defect`);
  }
  if (byFocalization.size > 1) {
    notes.push(
      `${byFocalization.size} focalizations appear in this series; each keeps its own trajectory instead of being ` +
        'read as one continuous arc',
    );
  }
  if (omitted.length > 0) {
    notes.push(
      `${omitted.length} of ${selected.length} selected segments were not assessed (${omitted.join(', ')}); this ` +
        'trajectory describes the assessed series only',
    );
  }
  if (outside.length > 0) {
    notes.push(`${outside.join(', ')} lie outside the selection and are reported without being counted as assessed`);
  }

  m.detail = {
    ordered_by: m.ordering,
    ordering_declared: declaredOrdering,
    ordering_normalized: declaredOrdering === 'story' && published.some((point, index) => point.disclosure_index !== receivedOrder[index]),
    segments: published.length,
    assessed_segments: assessedSelected,
    selected_segments: selected,
    omitted_segments: omitted,
    outside_selection: outside,
    focalization_series: [...byFocalization.entries()].map(([focalization, segments]) => ({ focalization, segments })),
    min_tension: Math.min(...tensions),
    max_tension: Math.max(...tensions),
    low_tension_segments: lowTension,
    note: notes.join(' '),
  };
  m.coverage = selected.length === 0 ? null : assessedSelected.length / selected.length;
  if (selected.length > 0 && assessedSelected.length === 0) {
    m.status = 'not_assessable';
    m.missing_reason =
      'no segment of the selection was assessed; the trajectory describes material outside the selected text';
  }
  return m;
}
