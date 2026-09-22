// C65: the published rubric anchors give every requested dimension a per-rating description, and the case
// selection returns real, bounded teaching passages with a language preference and no regression holdout.
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ANCHOR_SCALE, COMPONENT_SPECS, INDICATORS, INDICATOR_IDS } from '../scripts/lib/registry.mjs';
import { loadCaseLibrary } from '../scripts/lib/case-library.mjs';
import {
  DEFAULT_CASE_LIBRARY,
  SELECTION_RULE,
  SELECTION_SCHEMA_VERSION,
  selectTeachingCases,
} from '../scripts/lib/case-selection.mjs';

const anchors = JSON.parse(
  await readFile(join(import.meta.dirname, '..', 'schema', 'rubric-anchors.v1.json'), 'utf8'),
);

const RATING_LEVELS = [0, 1, 2, 3, 4];

test('the published anchors carry the enforced scale and the five rating levels', () => {
  assert.equal(anchors.schema_version, 'rubric-anchors.v1');
  assert.equal(anchors.scale, ANCHOR_SCALE);
  assert.equal(anchors.ratings.length, 5);
  for (const level of RATING_LEVELS) {
    const rating = anchors.ratings.find((entry) => entry.level === level);
    assert.ok(rating, `rating level ${level} must be published`);
    assert.ok(rating.description.length > 0, `rating ${level} needs a concrete description`);
  }
});

test('every requested metric dimension has a definition, evidence question and per-rating distinctions', () => {
  for (const [metricId, spec] of Object.entries(COMPONENT_SPECS)) {
    const metric = anchors.metrics[metricId];
    assert.ok(metric, `${metricId} must be published`);
    assert.deepEqual(
      Object.keys(metric.dimensions).sort(),
      [...spec.components].sort(),
      `${metricId} dimensions must match the component registry`,
    );
    for (const name of spec.components) {
      const dimension = metric.dimensions[name];
      assert.ok(dimension.definition.length > 0, `${metricId}.${name} needs a definition`);
      assert.ok(dimension.evidence_question.length > 0, `${metricId}.${name} needs an evidence question`);
      assert.ok(Array.isArray(dimension.exceptions), `${metricId}.${name} needs its justified exceptions`);
      for (const level of RATING_LEVELS) {
        assert.ok(
          typeof dimension.ratings[String(level)] === 'string' && dimension.ratings[String(level)].length > 0,
          `${metricId}.${name} needs a distinction for rating ${level}`,
        );
      }
    }
  }
});

test('the published indicator material covers all eight ids with definitions and qualifications', () => {
  assert.deepEqual(Object.keys(anchors.indicators).sort(), [...INDICATOR_IDS].sort());
  for (const id of INDICATOR_IDS) {
    const indicator = anchors.indicators[id];
    assert.deepEqual(indicator.categories, INDICATORS[id].categories, `${id} categories must match the registry`);
    assert.ok(indicator.definition.length > 0, `${id} needs a contextual definition`);
    assert.ok(Array.isArray(indicator.evidence_questions) && indicator.evidence_questions.length > 0, `${id} needs evidence questions`);
    assert.ok(
      Array.isArray(indicator.intended_effect_qualifications) && indicator.intended_effect_qualifications.length > 0,
      `${id} needs intended-effect qualifications`,
    );
  }
});

test('the anchors state that quiet scenes, static characters, closed endings and local settings are not defects by default', () => {
  const list = anchors.defaults.no_defect_by_default;
  for (const kind of ['quiet_scene', 'static_character', 'closed_ending', 'local_cultural_setting']) {
    assert.ok(list.includes(kind), `${kind} must be in the no-defect-by-default list`);
  }
  assert.ok(anchors.defaults.statement.length > 0);
  assert.ok(SELECTION_RULE.toLowerCase().includes('not a defect by default'));
});

test('the selection honours language preference, the size bound and the regression holdout', () => {
  // The regression holdout is the index's declared subset, never mixed in.
  const romanian = selectTeachingCases({ language: 'ro', maxSize: 8 });
  assert.equal(romanian.schema_version, SELECTION_SCHEMA_VERSION);
  assert.equal(romanian.count, 8);
  assert.ok(romanian.cases.length <= romanian.max_size);
  assert.ok(romanian.cases.every((c) => c.language === 'ro'), 'a Romanian book gets Romanian cases');
  assert.ok(romanian.cases.every((c) => !romanian.excluded_regression.includes(c.id)), 'no holdout case is returned');

  const english = selectTeachingCases({ language: 'en', maxSize: 5 });
  assert.equal(english.count, 5);
  assert.ok(english.cases.every((c) => c.language === 'en'), 'an English book gets English cases');
  assert.ok(english.cases.every((c) => !english.excluded_regression.includes(c.id)));

  // A book in a language the library does not cover falls back to English.
  const fallback = selectTeachingCases({ language: 'fr', maxSize: 4 });
  assert.equal(fallback.count, 4);
  assert.ok(fallback.cases.every((c) => c.language === 'en'), 'an uncovered language falls back to English');

  // The size bound is respected even when more cases are available.
  const bounded = selectTeachingCases({ language: 'ro', maxSize: 20 });
  assert.ok(bounded.cases.length <= 20);
  assert.equal(bounded.cases.length, 16, 'twelve non-holdout cases plus four English before the cap at 20');
});

test('the selection returns real paired passages, the changed feature, evidence and alternative readings', () => {
  const library = loadCaseLibrary(DEFAULT_CASE_LIBRARY);
  const selection = selectTeachingCases({ language: 'ro', maxSize: 3 });
  assert.ok(selection.cases.length > 0);
  for (const c of selection.cases) {
    const document = library.cases.get(c.id);
    assert.ok(document, `case ${c.id} must exist in the library`);
    assert.equal(c.before.text, document.before.text, `${c.id} must return the real before text`);
    assert.equal(c.after.text, document.after.text, `${c.id} must return the real after text`);
    assert.ok(c.before.text.length > 20 && c.after.text.length > 20, `${c.id} must carry real prose, not a placeholder`);
    assert.notEqual(c.before.text, c.after.text, `${c.id} must change something between its halves`);
    assert.notEqual(c.before.text, 'the feature that changed', 'the placeholder must never appear as a passage');
    assert.ok(c.change.feature.length > 0, `${c.id} must name the changed feature`);
    assert.ok(c.expected_evidence.length > 0, `${c.id} must carry its expected evidence`);
    assert.ok(c.acceptable_alternative_readings.length > 0, `${c.id} must carry its alternative readings`);
  }
});
