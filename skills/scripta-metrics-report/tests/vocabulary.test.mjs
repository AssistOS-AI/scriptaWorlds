// The published vocabulary is a contract with the outside producers of `annotations.v1` documents: the
// review host builds the prompt it gives a model from `schema/annotations.v1.json`, so a value that is
// published but rejected, or accepted but unpublished, is a bug on one side or the other. This test drives
// the real validators with the published values and with values outside them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  DEPARTURE_STATUSES,
  createEvidenceCollector,
  normalizeDepartures,
  normalizeFindings,
  normalizeIndicators,
  normalizePreserved,
} from '../scripts/lib/annotations.mjs';
import { INDICATORS } from '../scripts/lib/registry.mjs';
import { EAP_ORDERINGS, buildComponentMetric, buildEap } from '../scripts/lib/rubric.mjs';
import { getEmotionalFit } from '../scripts/lib/assemble.mjs';
import { SEGMENT_KINDS, SEGMENT_PROVENANCE } from '../scripts/lib/segments.mjs';
import {
  STUDY_BINDING_FIELDS,
  STUDY_EVIDENCE_REQUIRED_FIELDS,
  STUDY_OPTIONAL_FIELDS,
  STUDY_REQUIRED_FIELDS,
  STUDY_SCHEMA_VERSION,
  TEST_ONLY_OPT_IN_FLAG,
  verifyCalibrationSupport,
} from '../scripts/lib/study.mjs';
import { cleanup, sha256, tempDir, writeFile, writeJson } from './helpers.mjs';

const vocabulary = JSON.parse(await readFile(join(import.meta.dirname, '..', 'schema', 'annotations.v1.json'), 'utf8'));
const studyVocabulary = JSON.parse(await readFile(join(import.meta.dirname, '..', 'schema', 'study.v1.json'), 'utf8'));

const CHAPTER = '# One\n\nThe keeper read the ledger aloud, and the district answered with the same word it always used.\n';
const PATH = 'chapters/0001-one.md';
const BYTES = Buffer.from(CHAPTER, 'utf8');
const SHA = createHash('sha256').update(BYTES).digest('hex');

/** A collector holding one registered quote, which is what a finding cites. */
function collector() {
  const made = createEvidenceCollector([{ path: PATH, buffer: BYTES }]);
  made.add({ id: 'e1', file: PATH, sha256: SHA, start: 0, end: 12, quote: BYTES.subarray(0, 12).toString('utf8') });
  return made;
}

function finding(overrides = {}) {
  return {
    id: 'f1',
    kind: 'editorial',
    severity: 'local',
    certainty: 'tentative',
    status: 'dismissed',
    description: 'the opening names the stake only later',
    evidence: ['e1'],
    ...overrides,
  };
}

test('the published finding vocabulary is exactly what the validator accepts', () => {
  const { kinds, severities, certainties, statuses } = vocabulary.findings;
  for (const kind of kinds) {
    for (const severity of severities) {
      for (const certainty of certainties) {
        // `dismissed` needs neither evidence nor temporal context, so this isolates the vocabulary.
        const normalized = normalizeFindings([finding({ kind, severity, certainty })], collector());
        assert.equal(normalized[0].kind, kind, `kind ${kind}`);
        assert.equal(normalized[0].severity, severity, `severity ${severity}`);
        assert.equal(normalized[0].certainty, certainty, `certainty ${certainty}`);
      }
    }
  }
  for (const status of statuses) {
    const normalized = normalizeFindings([finding({ status, certainty: 'tentative' })], collector());
    assert.equal(normalized[0].status, status, `status ${status}`);
  }
  // A value outside the published list is refused instead of being normalized into a judgement.
  for (const [field, value, list] of [
    ['kind', 'narrative', kinds],
    ['severity', 'minor', severities],
    ['certainty', 'probable', certainties],
    ['status', 'open', statuses],
  ]) {
    assert.ok(!list.includes(value), `${field} must not publish ${value}`);
    assert.throws(
      () => normalizeFindings([finding({ [field]: value })], collector()),
      /unknown|must be one of/u,
      `${field}=${value} must be refused`,
    );
  }
});

test('the published segment, ordering and departure vocabularies are exactly what the code accepts', () => {
  assert.deepEqual(vocabulary.segment_kinds, SEGMENT_KINDS);
  assert.deepEqual(vocabulary.segment_provenance, SEGMENT_PROVENANCE);
  assert.deepEqual(vocabulary.eap_orderings, EAP_ORDERINGS);
  assert.deepEqual(vocabulary.departures.statuses, DEPARTURE_STATUSES);
  const departure = { id: 'd1', status: 'deliberate', description: 'the ending stays open', rationale: 'the reader completes it', evidence: ['e1'] };
  assert.equal(normalizeDepartures([departure]).length, 1);
  assert.throws(() => normalizeDepartures([{ ...departure, status: 'intentional' }]), /must be one of/u);
  for (const status of vocabulary.departures.statuses) {
    assert.equal(normalizeDepartures([{ ...departure, status }])[0].status, status, `departure status ${status}`);
  }
  const preserved = normalizePreserved({ passages: [{ id: 'p1', rationale: 'the quiet scene earns the ending', evidence: ['e1'] }] });
  assert.equal(preserved.passages.length, 1);
  const passage = preserved.passages[0];
  for (const field of vocabulary.preserved_qualities.passage_fields) {
    assert.ok(Object.hasOwn(passage, field), `the published passage field ${field} must survive validation`);
  }
});

test('the published calibration-study format is exactly what the verifier accepts', () => {
  assert.equal(studyVocabulary.schema_version, STUDY_SCHEMA_VERSION);
  assert.deepEqual(studyVocabulary.required_fields, STUDY_REQUIRED_FIELDS);
  assert.deepEqual(studyVocabulary.optional_fields, STUDY_OPTIONAL_FIELDS);
  assert.deepEqual(studyVocabulary.binding_fields, STUDY_BINDING_FIELDS);
  assert.deepEqual(studyVocabulary.evidence_required_fields, STUDY_EVIDENCE_REQUIRED_FIELDS);
  assert.equal(studyVocabulary.test_only_field, 'test_only');
  assert.equal(studyVocabulary.opt_in_flag, TEST_ONLY_OPT_IN_FLAG);

  const root = tempDir('study-vocabulary-');
  try {
    const bytes = Buffer.from('{"synthetic":true}\n', 'utf8');
    const hash = sha256(bytes);
    /** A document using exactly the published format, nothing more. */
    const published = () => ({
      schema_version: STUDY_SCHEMA_VERSION,
      study_id: 'published-format',
      test_only: true,
      held_out: true,
      bindings: { rubric_version: 'rubric-anchors.v1', profile_version: 'nqs-profile.v1', language: 'ro', scope: 'chapter 1' },
      evidence: [{ id: 'labels', path: 'labels.json', sha256: hash }],
    });
    const verify = (document) => {
      writeFile(root, 'labels.json', bytes);
      writeJson(root, 'study.json', document);
      return verifyCalibrationSupport({
        calibration: { study: 'study.json', study_id: null },
        profileVersion: 'nqs-profile.v1',
        rubricVersion: 'rubric-anchors.v1',
        language: 'ro',
        scope: 'chapter 1',
        studyRoot: root,
        allowTestOnlyStudies: true,
      });
    };

    // The published format is accepted as published: nothing the verifier
    // demands is missing from it, and no published field is rejected.
    assert.equal(verify(published()).ok, true, 'the published format must verify as published');
    assert.equal(verify({ ...published(), provenance: 'published optional field' }).ok, true);

    // Every published required field is really demanded.
    for (const field of STUDY_REQUIRED_FIELDS) {
      const document = published();
      delete document[field];
      const result = verify(document);
      assert.equal(result.ok, false, `${field} must be required`);
      assert.ok(result.problem.includes(field.split('_')[0]), result.problem);
    }
    // A study version outside the published one is refused.
    assert.equal(verify({ ...published(), schema_version: 'calibration-study.v2' }).ok, false);
    // Every published binding is really checked.
    for (const field of STUDY_BINDING_FIELDS) {
      const document = published();
      document.bindings[field] = 'another-value';
      const result = verify(document);
      assert.equal(result.ok, false, `${field} must be bound`);
      assert.ok(result.problem.includes(field), result.problem);
    }
    // Every published evidence field is really demanded.
    for (const field of STUDY_EVIDENCE_REQUIRED_FIELDS) {
      const document = published();
      delete document.evidence[0][field];
      const result = verify(document);
      assert.equal(result.ok, false, `${field} must be required of every evidence item`);
      assert.ok(result.problem.includes(field), result.problem);
    }
  } finally {
    cleanup([root]);
  }
});

test('the published EAP trajectory contract is exactly what the consumer accepts', () => {
  const document = {
    status: 'judged',
    evaluator: 'model:fixture',
    ordering: 'disclosure',
    trajectory: [{
      segment_id: 'seg1',
      focalization: 'internal',
      valence: vocabulary.eap_scales.valence.max,
      tension: vocabulary.eap_scales.tension.min,
      evidence: ['e1'],
      uncertainty: 'one scene only',
    }],
    emotional_fit: {
      status: 'judged',
      evaluator: 'model:fixture',
      fit: vocabulary.eap_scales.emotional_fit.min,
      rationale: 'the register answers the intention',
      evidence: ['e1'],
      intention_binding: 'the stated intention',
    },
  };
  const built = buildEap(document, { scope: { kind: 'chapter' }, segmentIds: ['seg1'], fallbackReason: 'none' });
  assert.equal(built.status, 'judged');
  assert.equal(built.value_kind, 'trajectory');
  assert.equal(built.trajectory[0].segment_id, 'seg1');
  assert.equal(built.trajectory[0].valence, vocabulary.eap_scales.valence.max);
  for (const field of vocabulary.eap_trajectory_fields) {
    assert.ok(field in built.trajectory[0] || field === 'focalization' || field === 'story_order',
      `the published trajectory field ${field} must be representable in the built trajectory`);
  }
  // The published scales are the enforced scales: one step outside each is refused, not clamped.
  assert.throws(
    () => buildEap({ ...document, trajectory: [{ ...document.trajectory[0], valence: vocabulary.eap_scales.valence.max + 0.1 }] }, { scope: { kind: 'chapter' }, segmentIds: ['seg1'] }),
    (error) => error.code === 'OUT_OF_RANGE',
    'a valence outside the published scale must be refused with OUT_OF_RANGE',
  );
  assert.throws(
    () => buildEap({ ...document, trajectory: [{ ...document.trajectory[0], tension: vocabulary.eap_scales.tension.max + 0.1 }] }, { scope: { kind: 'chapter' }, segmentIds: ['seg1'] }),
    (error) => error.code === 'OUT_OF_RANGE',
    'a tension outside the published scale must be refused with OUT_OF_RANGE',
  );
  // The emotional fit is its own judgement: a bare number is refused, and an incomplete record demotes
  // with the reason rather than becoming a number.
  const fitDocument = {
    status: 'judged',
    evaluator: 'model:fixture',
    fit: vocabulary.eap_scales.emotional_fit.max,
    rationale: 'the register answers the intention',
    evidence: ['e1'],
    intention_binding: 'the stated intention',
  };
  assert.equal(getEmotionalFit({ EAP: { emotional_fit: fitDocument } }).value, vocabulary.eap_scales.emotional_fit.max);
  const incomplete = getEmotionalFit({ EAP: { emotional_fit: { ...fitDocument, evidence: [] } } });
  assert.equal(incomplete.value, null);
  assert.match(incomplete.reason, /cited passage/u);
  const absent = getEmotionalFit({ EAP: {} });
  assert.equal(absent.value, null);
  assert.throws(
    () => getEmotionalFit({ EAP: { emotional_fit: 55 } }),
    (error) => error.code === 'INVALID_ANNOTATIONS',
    'a bare emotional-fit number must be refused',
  );
  // The old producer shape is what the prompt must never request again: the consumer has no field for it.
  const legacyShape = { status: 'judged', evaluator: 'model:fixture', points: [{ segment: 'seg1', valence: 0 }], emotional_fit: 60 };
  const legacy = buildEap(legacyShape, { scope: { kind: 'chapter' }, segmentIds: ['seg1'], fallbackReason: 'none' });
  assert.equal(legacy.status, 'not_assessable');
  assert.match(legacy.missing_reason ?? '', /trajectory/u);
});

test('the published NCS components are the two dimensions the consumer builds', () => {
  assert.deepEqual(vocabulary.ncs_components, ['novelty', 'cliche_reliance']);
  const built = buildComponentMetric('NCS', {
    status: 'judged',
    evaluator: 'model:fixture',
    dimensions: {
      novelty: { rating: 3, rationale: 'the ledger scene is fresh', evidence: ['e1'] },
      cliche_reliance: { rating: 1, rationale: 'one recurring phrase', evidence: ['e1'] },
    },
  }, { scope: { kind: 'chapter' }, rubric: { version: 'rubric-anchors.v1', scale: 4 }, fallbackReason: 'none' });
  assert.equal(built.value_kind, 'components');
});

test('the published indicator table and status vocabulary match what the report accepts', () => {
  const published = Object.fromEntries(Object.entries(INDICATORS).map(([id, entry]) => [id, { categories: entry.categories }]));
  assert.deepEqual(vocabulary.indicators, published, 'every indicator and its source categories must be published');
  const indicator = {
    id: 'narrative_coherence',
    status: 'judged',
    category: INDICATORS.narrative_coherence.categories[1],
    evaluator: 'model:fixture',
    rationale: 'the scenes return to one image',
    evidence: ['e1'],
    counterevidence: null,
  };
  const normalized = normalizeIndicators([indicator]).narrative_coherence;
  assert.equal(normalized.category, INDICATORS.narrative_coherence.categories[1]);
  assert.equal(normalized.evaluator, 'model:fixture');
  // A category from another indicator's list is refused: the taxonomies are not interchangeable.
  assert.throws(() => normalizeIndicators([{ ...indicator, category: INDICATORS.thematic_depth.categories[0] }]), /not one of its source categories/u);
  for (const status of vocabulary.indicator_statuses) {
    const withStatus = normalizeIndicators([{ ...indicator, status }]).narrative_coherence;
    assert.equal(withStatus.status, status, `indicator status ${status}`);
  }
  assert.throws(() => normalizeIndicators([{ ...indicator, status: 'estimated' }]), /status/u);
  assert.ok(vocabulary.indicator_fields.includes('category'), 'the documented field list names the category');
  for (const field of ['id', 'status', 'category', 'evaluator', 'rationale', 'evidence', 'counterevidence']) {
    assert.ok(vocabulary.indicator_fields.includes(field), `the documented field list names ${field}`);
  }
  assert.ok(vocabulary.metric_statuses.includes('not_assessable'), 'an unobservable metric is expressible');
  assert.ok(!vocabulary.metric_statuses.includes('error'), 'a host-side failure is not a producer vocabulary value');
});
