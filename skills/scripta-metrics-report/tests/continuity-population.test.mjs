// C72: a continuity population is a partition that was checked, not a pair of totals to be trusted.
//
// The counts describe the comparisons the ledger actually reached: an incomplete pair of totals can
// no longer imply that one observed success means complete consistency, the authoritative version is
// the packet's own accepted version, and the CAD candidates come from the same counted population.

import test from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { normalizeContinuity } from '../scripts/lib/annotations.mjs';
import { computeCad, computeCci } from '../scripts/lib/metrics.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runReport, tempDir } from './helpers.mjs';

const PACKET_VERSION = `sha256:${'a'.repeat(64)}`;
const OTHER_VERSION = `sha256:${'b'.repeat(64)}`;
const COMPLETE = { eligible_comparisons: 2, consistent: 1, contradicted: 1, unresolved: 0 };

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `${error.code}: ${error.message}`);
    return true;
  });
}

function continuity(overrides = {}) {
  return {
    schema_version: 'continuity-result.v1',
    counts: { ...COMPLETE },
    scope: { chapters: [1], omitted: [] },
    findings: [],
    ...overrides,
  };
}

test('one observed success among a hundred eligible comparisons cannot mean complete consistency', () => {
  const record = normalizeContinuity(
    continuity({ counts: { eligible_comparisons: 100, consistent: 1, contradicted: 0, unresolved: 0 } }),
    { packetVersion: PACKET_VERSION },
  );
  assert.equal(record.partition.complete, false);
  assert.equal(record.partition.unexamined, 99);
  assert.equal(record.counts.unresolved, 99, 'the unexamined comparisons are carried as unresolved');
  assert.deepEqual(record.declared_counts, { eligible_comparisons: 100, consistent: 1, contradicted: 0, unresolved: 0 });
  const cci = computeCci(record.counts, { partition: record.partition, countsSource: record.counts_source });
  assert.equal(cci.value, null, 'no single index is published for a partial population');
  assert.equal(cci.coverage, 0.01);
  assert.deepEqual([cci.lower_bound, cci.upper_bound], [1, 100]);
  assert.equal(cci.detail.partition.unexamined, 99);
  assert.equal(cci.detail.counts_source, 'declared_with_unexamined');
});

test('a complete partition publishes the index, and a declared total above the population is refused', () => {
  const complete = normalizeContinuity(continuity(), { packetVersion: PACKET_VERSION });
  assert.equal(complete.partition.complete, true);
  assert.equal(complete.partition.unexamined, 0);
  assert.equal(complete.counts_source, 'declared');
  assert.equal(computeCci(complete.counts).value, 50);
  assertCode(
    () => normalizeContinuity(continuity({ counts: { eligible_comparisons: 1, consistent: 2, contradicted: 0, unresolved: 0 } })),
    'INVALID_ANNOTATIONS',
  );
});

test('the result names one authoritative version, and the packet version is the one it is bound to', () => {
  // Two different versions in one document cannot both be the truth.
  assertCode(
    () => normalizeContinuity(continuity({ version: OTHER_VERSION, source_version: PACKET_VERSION }), { packetVersion: PACKET_VERSION }),
    'INVALID_ANNOTATIONS',
  );
  // The legacy field is a fallback, and a stale value in either field is refused.
  assertCode(() => normalizeContinuity(continuity({ source_version: OTHER_VERSION }), { packetVersion: PACKET_VERSION }), 'STALE_ANNOTATION');
  assertCode(() => normalizeContinuity(continuity({ version: OTHER_VERSION }), { packetVersion: PACKET_VERSION }), 'STALE_ANNOTATION');
  const legacy = normalizeContinuity(continuity({ version: PACKET_VERSION }), { packetVersion: PACKET_VERSION });
  assert.equal(legacy.source_version, PACKET_VERSION);
  assert.equal(legacy.declared_version, PACKET_VERSION);
  const both = normalizeContinuity(continuity({ version: PACKET_VERSION, source_version: PACKET_VERSION }), { packetVersion: PACKET_VERSION });
  assert.equal(both.source_version, PACKET_VERSION);
});

test('declared totals are cross-checked against the comparison ledger when the result carries one', () => {
  const comparisons = [
    { id: 'comparison-0001', outcome: 'contradicted' },
    { id: 'comparison-0002', outcome: 'supported' },
    { id: 'comparison-0003', outcome: 'unresolved' },
  ];
  const derived = normalizeContinuity(
    continuity({ counts: { eligible_comparisons: 3, consistent: 1, contradicted: 1, unresolved: 1 }, comparisons }),
    { packetVersion: PACKET_VERSION },
  );
  assert.equal(derived.counts_source, 'ledger');
  assert.deepEqual(derived.counts, { eligible_comparisons: 3, consistent: 1, contradicted: 1, unresolved: 1 });
  assert.equal(derived.partition.complete, true);
  // A total the ledger does not support is refused rather than silently published.
  assertCode(
    () =>
      normalizeContinuity(
        continuity({ counts: { eligible_comparisons: 3, consistent: 2, contradicted: 1, unresolved: 0 }, comparisons }),
        { packetVersion: PACKET_VERSION },
      ),
    'INVALID_ANNOTATIONS',
  );
  // An outcome outside the ledger vocabulary is not a comparison result.
  assertCode(
    () => normalizeContinuity(continuity({ counts: { eligible_comparisons: 1, consistent: 1, contradicted: 0, unresolved: 0 }, comparisons: [{ id: 'c1', outcome: 'probably-fine' }] }), { packetVersion: PACKET_VERSION }),
    'INVALID_ANNOTATIONS',
  );
});

test('the population is the one the ledger reviewed, not every chapter the packet holds', () => {
  const record = normalizeContinuity(
    continuity({ scope: { chapters: [1, 2], chapters_reviewed: [1], omitted: [] } }),
    { packetVersion: PACKET_VERSION },
  );
  assert.deepEqual(record.population, [1], 'the counts describe the reviewed chapters');
  assert.deepEqual(record.chapters, [1, 2]);
});

/* --------------------------- end to end --------------------------- */

test('a result whose reviewed population is not the selection cannot be attributed to it', () => {
  const root = tempDir('metrics-c72-population-');
  try {
    const fx = buildReportFixture(join(root, 'fx'), {
      continuityScope: { chapters: [1, 2], chapters_reviewed: [1, 2], omitted: [] },
    });
    const out = join(root, 'fx', 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.coverage.continuity.applicable, false);
    assert.ok(bundle.coverage.continuity.reason.includes('does not match the selection'), bundle.coverage.continuity.reason);
    assert.equal(bundle.metrics.CCI.status, 'not_assessable');
    assert.equal(bundle.metrics.CAD.status, 'not_assessable');
  } finally {
    cleanup([root]);
  }
});

test('a result naming a chapter the packet does not contain is refused, not attributed', () => {
  const root = tempDir('metrics-c72-unknown-');
  try {
    const fx = buildReportFixture(join(root, 'fx'), { continuityScope: { chapters: [1, 9], chapters_reviewed: [1, 9], omitted: [] } });
    const out = join(root, 'fx', 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 2, env.stdout);
    assert.equal(env.envelope.code, 'UNKNOWN_CHAPTER');
  } finally {
    cleanup([root]);
  }
});

test('a continuity result is measured through the ledger it carries, and the population is published', () => {
  const root = tempDir('metrics-c72-ledger-');
  try {
    const fx = buildReportFixture(join(root, 'fx'), {
      annotations: (annotations) => {
        annotations.continuity.comparisons = [
          { id: 'comparison-0001', outcome: 'contradicted' },
          { id: 'comparison-0002', outcome: 'supported' },
        ];
        delete annotations.continuity.version;
      },
    });
    const out = join(root, 'fx', 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.metrics.CCI.value, 50);
    assert.equal(bundle.provenance.continuity.source_version, bundle.version);
    assert.equal(bundle.provenance.continuity.counts_source, 'ledger');
    assert.deepEqual(bundle.provenance.continuity.population, [1]);
    assert.equal(bundle.provenance.continuity.declared_version, bundle.version, 'the surviving declaration is the packet version');
  } finally {
    cleanup([root]);
  }
});

test('a finding whose every passage lies outside the counted population is not a CAD candidate', () => {
  const root = tempDir('metrics-c72-cad-');
  try {
    const fx = buildReportFixture(join(root, 'fx'), {
      annotations: (annotations) => {
        // ev3 lives in the declared context chapter 2; the continuity result counted chapter 1 only.
        annotations.continuity.findings.push({
          id: 'find-3',
          kind: 'unsupported_change',
          severity: 'local',
          certainty: 'tentative',
          status: 'dismissed',
          description: 'The journal scene changes the mariner without a cause in the context chapter.',
          evidence: ['ev3'],
        });
      },
    });
    const out = join(root, 'fx', 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.metrics.CAD.detail.population_chapters.join(','), '1');
    assert.deepEqual(bundle.metrics.CAD.detail.excluded_findings.map((entry) => entry.id), ['find-3']);
    // The finding is still reported; only its membership of the counted population changed.
    assert.ok(bundle.findings.some((finding) => finding.id === 'find-3'));
  } finally {
    cleanup([root]);
  }
});

test('two symptoms of one defect are one candidate, and conflicting statuses are reported as unresolved', () => {
  const one = computeCad([{ id: 'a', kind: 'unsupported_change', status: 'confirmed', defect_id: 'drift-1' }]);
  assert.equal(one.detail.change_candidates, 1);
  const conflicting = computeCad([
    { id: 'a', kind: 'unsupported_change', status: 'confirmed', defect_id: 'drift-1' },
    { id: 'b', kind: 'unsupported_change', status: 'dismissed', defect_id: 'drift-1' },
  ]);
  assert.equal(conflicting.detail.change_candidates, 1, 'one defect is one candidate');
  assert.equal(conflicting.value, null, 'a contested defect has no single rate');
  assert.equal(conflicting.coverage, 0);
  assert.deepEqual(conflicting.detail.conflicting_defects, [{ defect: 'drift-1', findings: ['a', 'b'], statuses: ['confirmed', 'dismissed'] }]);
});
