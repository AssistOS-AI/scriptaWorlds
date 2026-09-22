// C15 — CCI and CAD are derived from a versioned comparison ledger.
//
// The reviewed comparisons are stored separately from the defect list: a defect
// list is a list of symptoms, a ledger is a list of decisions with an outcome
// each. Counts are derived from those records, never trusted from outside, so a
// supplied total that disagrees is wrong input and repeated symptoms of one
// defect add one penalty rather than several.

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  annotationsDocument,
  errorCodes,
  evidenceFor,
  makeClaim,
  makePacket,
  parseEnvelope,
  runReview,
  writeAnnotations,
} from './helpers.mjs';

const root = await mkdtemp(join(tmpdir(), 'continuity-ledger-'));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const CHAPTER_ONE = '# Capitolul 1\n\nRobinetul a fost deschis complet, iar presiunea a scăzut.\n';
const CHAPTER_TWO = '# Capitolul 2\n\nRobinetul era pe jumătate închis, fără nicio reparație.\n';
const QUOTE_ONE = 'Robinetul a fost deschis complet';
const QUOTE_TWO = 'Robinetul era pe jumătate închis';

let counter = 0;

async function fixture(name, opts = {}) {
  counter += 1;
  const packet = await makePacket(join(root, `${name}-${counter}`), {
    chapters: ['0001-scene.md', '0002-scene.md'],
    chapterTexts: { '0001-scene.md': CHAPTER_ONE, '0002-scene.md': CHAPTER_TWO },
    ...opts,
  });
  const evidence = [
    evidenceFor('ev-1', 'chapters/0001-scene.md', CHAPTER_ONE, QUOTE_ONE),
    evidenceFor('ev-2', 'chapters/0002-scene.md', CHAPTER_TWO, QUOTE_TWO),
  ];
  const claim = (over = {}) =>
    makeClaim(packet.packetDir, packet.version, evidence, {
      scope: { kind: 'book', chapters: packet.manifest.scope.chapters },
      ...over,
    });
  return { ...packet, evidence, claim };
}

async function review(name, findings, packet, extra = {}) {
  const file = await writeAnnotations(root, `${name}.json`, annotationsDocument(findings, extra));
  const out = join(root, `${name}-out`);
  const result = await runReview(['--input', packet.packetDir, '--out', out, '--annotations', file]);
  return { out, result, envelope: parseEnvelope(result) };
}

function assertWellFormedNumbers(envelope) {
  const { coverage, coverage_bounds: bounds } = envelope.scope;
  if (coverage !== null) assert.ok(coverage >= 0 && coverage <= 1, `coverage ${coverage} must be in [0, 1]`);
  if (bounds !== null) {
    for (const [key, value] of Object.entries(bounds)) {
      assert.ok(value >= 0 && value <= 1, `coverage_bounds.${key} = ${value} must be in [0, 1]`);
    }
    assert.ok(bounds.lower <= bounds.upper, 'the coverage bounds must be ordered');
  }
  for (const metric of ['cci', 'cad']) {
    const index = envelope.derived[metric];
    if (index.value !== null) {
      assert.ok(index.value >= 0 && index.value <= 100, `${metric}.value must stay in the metric range`);
    }
    for (const key of ['lower_bound', 'upper_bound']) {
      if (index[key] === null) continue;
      assert.ok(index[key] >= 0 && index[key] <= 100, `${metric}.${key} must stay in the metric range`);
      assert.ok(index.lower_bound <= index.upper_bound, `${metric} bounds must be ordered`);
    }
  }
}

describe('counts come from the ledger, not from the input (C15)', () => {
  test('three comparisons derive their counts and their index', async () => {
    const packet = await fixture('three');
    const findings = [
      packet.claim({ id: 'claim-0001', comparison: 'valve' }),
      packet.claim({ id: 'claim-0002', comparison: 'ledger', status: 'dismissed' }),
      packet.claim({ id: 'claim-0003', comparison: 'map', status: 'unresolved', limitations: 'The map is described twice.' }),
    ];
    const run = await review('three', findings, packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    const { counts, derived, scope, comparisons } = run.envelope;
    assert.deepEqual(counts, { eligible_comparisons: 3, consistent: 1, contradicted: 1, unresolved: 1 });
    assert.equal(comparisons.length, 3);
    assert.deepEqual(
      comparisons.map((comparison) => comparison.outcome),
      ['contradicted', 'supported', 'unresolved'],
    );
    assert.equal(scope.coverage, 2 / 3);
    assert.deepEqual(scope.coverage_bounds, { lower: 2 / 3, upper: 1 });
    assert.equal(derived.cci.status, 'unresolved');
    assert.equal(derived.cci.value, null, 'an unsettled comparison withholds a single index');
    assert.equal(derived.cci.lower_bound, (100 * 1) / 3);
    assert.equal(derived.cci.upper_bound, (100 * 2) / 3);
    assert.equal(derived.cad.status, 'not_applicable', 'no eligible character change was reviewed');
    assertWellFormedNumbers(run.envelope);
  });

  test('repeated symptoms of one defect are one comparison and one penalty', async () => {
    const packet = await fixture('repeated');
    const findings = [
      packet.claim({
        id: 'claim-0001',
        comparison: 'defect-valve',
        subject: 'the valve in the cellar',
        rationale: 'The valve cannot be fully open and half closed without a repair.',
      }),
      packet.claim({
        id: 'claim-0002',
        comparison: 'defect-valve',
        subject: 'the valve in the cellar',
        rationale: 'The later scene contradicts the earlier statement about the pressure.',
      }),
      packet.claim({
        id: 'claim-0003',
        comparison: 'defect-valve',
        subject: 'the valve in the cellar',
        status: 'dismissed',
        alternative_explanation: 'A repair happened between the two scenes.',
      }),
    ];
    const run = await review('repeated', findings, packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    assert.deepEqual(run.envelope.counts, {
      eligible_comparisons: 1,
      consistent: 0,
      contradicted: 1,
      unresolved: 0,
    });
    assert.equal(run.envelope.comparisons.length, 1);
    const [comparison] = run.envelope.comparisons;
    assert.deepEqual(comparison.claim_ids, ['claim-0001', 'claim-0002', 'claim-0003']);
    assert.equal(comparison.outcome, 'contradicted', 'one confirmed symptom decides the one comparison');
    assert.deepEqual(comparison.evidence_ids.sort(), ['ev-1', 'ev-2']);
    // The symptoms themselves stay visible as separate findings.
    assert.equal(run.envelope.findings.length, 3);
    assert.deepEqual(run.envelope.reviewed_claims, ['claim-0001', 'claim-0002', 'claim-0003']);
    assertWellFormedNumbers(run.envelope);
  });

  test('two distinct defects on one subject stay two comparisons', async () => {
    const packet = await fixture('distinct');
    const findings = [
      packet.claim({ id: 'claim-0001', subject: 'Mara', category: 'character_knowledge' }),
      packet.claim({ id: 'claim-0002', subject: 'Mara', category: 'chronology' }),
    ];
    const run = await review('distinct', findings, packet);
    assert.deepEqual(run.envelope.counts, {
      eligible_comparisons: 2,
      consistent: 0,
      contradicted: 2,
      unresolved: 0,
    });
  });

  test('the reproduced eligible=1, consistent=8 payload is rejected', async () => {
    const packet = await fixture('bad-totals');
    const run = await review('bad-totals', [packet.claim()], packet, {
      counts: { eligible_comparisons: 1, consistent: 8, contradicted: 0, unresolved: 0 },
    });
    assert.equal(run.result.code, 2);
    assert.deepEqual([...new Set(errorCodes(run.envelope))], ['INVALID_ANNOTATIONS']);
    assert.match(run.envelope.errors.join(' '), /exceeds|more outcomes/);
  });

  test('a total that is internally consistent but disagrees with the ledger is rejected', async () => {
    const packet = await fixture('wrong-totals');
    const run = await review('wrong-totals', [packet.claim()], packet, {
      counts: { eligible_comparisons: 2, consistent: 2, contradicted: 0, unresolved: 0 },
    });
    assert.equal(run.result.code, 2);
    const envelope = run.envelope;
    assert.deepEqual([...new Set(errorCodes(envelope))], ['INVALID_ANNOTATIONS']);
    assert.match(envelope.errors.join(' '), /reviewed ledger derives/);
  });

  test('a supplied total may not hide an unresolved comparison', async () => {
    const packet = await fixture('hidden-unresolved');
    const findings = [
      packet.claim({ id: 'claim-0001', status: 'unresolved', limitations: 'Nothing can be settled here.' }),
    ];
    const run = await review('hidden-unresolved', findings, packet, {
      counts: { eligible_comparisons: 1, consistent: 1, contradicted: 0, unresolved: 0 },
    });
    assert.equal(run.result.code, 2);
    assert.match(run.envelope.errors.join(' '), /unresolved declares 0 but the reviewed ledger derives 1/);
  });
});

describe('a compatible embedded result is reconciled, an incompatible one is refused (C15)', () => {
  const embedded = (packet, counts) => ({
    schema_version: 'continuity-result.v1',
    ok: true,
    version: packet.version,
    scope: { universe_id: 'test-universe', chapters: [1, 2] },
    counts,
  });

  test('a compatible embedded result is accepted and reconciled', async () => {
    const packet = await fixture('embedded-ok');
    const run = await review('embedded-ok', [packet.claim()], packet, {
      continuity: embedded(packet, { eligible_comparisons: 1, consistent: 0, contradicted: 1, unresolved: 0 }),
    });
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    assert.equal(run.envelope.counts.contradicted, 1);
  });

  test('an embedded result that disagrees with the ledger is refused', async () => {
    const packet = await fixture('embedded-disagree');
    const run = await review('embedded-disagree', [packet.claim()], packet, {
      continuity: embedded(packet, { eligible_comparisons: 1, consistent: 1, contradicted: 0, unresolved: 0 }),
    });
    assert.equal(run.result.code, 2);
    assert.deepEqual([...new Set(errorCodes(run.envelope))], ['INVALID_ANNOTATIONS']);
    assert.match(run.envelope.errors.join(' '), /continuity\.counts/);
  });

  test('a failed embedded result is refused', async () => {
    const packet = await fixture('embedded-failed');
    const failed = { ...embedded(packet, { eligible_comparisons: 0, consistent: 0, contradicted: 0, unresolved: 0 }), ok: false };
    const run = await review('embedded-failed', [], packet, { continuity: failed });
    assert.equal(run.result.code, 2);
    assert.match(run.envelope.errors.join(' '), /ok:false/);
  });

  test('an embedded result bound to another version or another scope is refused', async () => {
    const packet = await fixture('embedded-foreign');
    const foreign = {
      ...embedded(packet, { eligible_comparisons: 0, consistent: 0, contradicted: 0, unresolved: 0 }),
      version: `sha256:${'2'.repeat(64)}`,
    };
    const versionRun = await review('embedded-foreign', [], packet, { continuity: foreign });
    assert.equal(versionRun.result.code, 2);
    assert.match(versionRun.envelope.errors.join(' '), /historical, not current/);

    const otherScope = {
      ...embedded(packet, { eligible_comparisons: 0, consistent: 0, contradicted: 0, unresolved: 0 }),
      scope: { universe_id: 'another-universe', chapters: [1, 2] },
    };
    const scopeRun = await review('embedded-scope', [], packet, { continuity: otherScope });
    assert.equal(scopeRun.result.code, 2);
    assert.match(scopeRun.envelope.errors.join(' '), /universe_id/);
  });

  test('an embedded result covering chapters the packet does not contain is refused', async () => {
    const packet = await fixture('embedded-chapters');
    const wide = {
      ...embedded(packet, { eligible_comparisons: 0, consistent: 0, contradicted: 0, unresolved: 0 }),
      scope: { universe_id: 'test-universe', chapters: [1, 2, 9] },
    };
    const run = await review('embedded-chapters', [], packet, { continuity: wide });
    assert.equal(run.result.code, 2);
    assert.match(run.envelope.errors.join(' '), /chapters the packet does not contain/);
  });
});

describe('the indices say what they cannot know (C15)', () => {
  test('no eligible character change yields not-applicable CAD', async () => {
    const packet = await fixture('cad-not-applicable');
    const run = await review('cad-not-applicable', [packet.claim()], packet);
    const cad = run.envelope.derived.cad;
    assert.equal(cad.status, 'not_applicable');
    assert.equal(cad.value, null);
    assert.equal(cad.coverage, null);
    assert.match(cad.reason, /no eligible character change/);
  });

  test('character changes yield an unsupported-change rate with its bounds', async () => {
    const packet = await fixture('cad-rate');
    const change = (over) => ({
      category: 'character_attribute',
      subject: 'Mara',
      attribute: 'literacy',
      catalyst: 'the ledger she is forced to read',
      ...over,
    });
    const findings = [
      packet.claim({ id: 'claim-0001', comparison: 'a', ...change({}) }),
      packet.claim({
        id: 'claim-0002',
        comparison: 'b',
        ...change({ status: 'dismissed', alternative_explanation: 'She learned to read in chapter 1.' }),
      }),
      packet.claim({
        id: 'claim-0003',
        comparison: 'c',
        ...change({ status: 'unresolved', limitations: 'The second scene may be a recollection.' }),
      }),
    ];
    const run = await review('cad-rate', findings, packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    const cad = run.envelope.derived.cad;
    assert.equal(cad.status, 'unresolved');
    assert.equal(cad.value, null);
    assert.equal(cad.eligible, 3);
    assert.equal(cad.lower_bound, (100 * 1) / 3);
    assert.equal(cad.upper_bound, (100 * 2) / 3);
    assertWellFormedNumbers(run.envelope);
  });

  test('unavailable evidence leaves an unresolved result rather than a clean one', async () => {
    const packet = await fixture('unavailable');
    const claim = packet.claim();
    delete claim.baseline;
    delete claim.later;
    delete claim.temporal_scope;
    const run = await review('unavailable', [claim], packet);
    assert.equal(run.result.code, 0);
    assert.equal(run.envelope.derived.cci.status, 'unresolved');
    assert.equal(run.envelope.derived.cci.value, null);
    assert.equal(run.envelope.counts.contradicted, 0);
    assert.equal(run.envelope.scope.coverage, 0);
  });

  test('a packet with nothing to compare reports unavailable indices, not perfect ones', async () => {
    const packet = await fixture('nothing', {
      canon: null,
      threads: null,
      atlas: null,
      universe: null,
      kind: 'textual_only',
    });
    const out = join(root, 'nothing-out');
    const result = await runReview(['--input', packet.packetDir, '--out', out]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 0);
    assert.equal(envelope.derived.cci.status, 'not_applicable');
    assert.equal(envelope.derived.cad.status, 'not_applicable');
    assert.equal(envelope.derived.cci.value, null);
    assert.equal(envelope.scope.coverage, null);
    assert.match(envelope.scope.coverage_note, /nothing here implies a clean book/);
    assertWellFormedNumbers(envelope);
  });
});

describe('the result is bound to the packet version and the scope it covered (C15)', () => {
  test('a partial packet reports its version, its omission and the chapters it reviewed', async () => {
    const packet = await makePacket(join(root, 'bound-partial'), {
      chapters: ['0001-scene.md', '0003-scene.md'],
      lastAccepted: 3,
      kind: 'partial',
      omitted: [2],
      chapterTexts: { '0001-scene.md': CHAPTER_ONE, '0003-scene.md': CHAPTER_TWO },
    });
    const evidence = [
      evidenceFor('ev-1', 'chapters/0001-scene.md', CHAPTER_ONE, QUOTE_ONE),
      evidenceFor('ev-3', 'chapters/0003-scene.md', CHAPTER_TWO, QUOTE_TWO),
    ];
    const claim = makeClaim(packet.packetDir, packet.version, evidence, {
      scope: { kind: 'book', chapters: [1, 3] },
    });
    claim.baseline = { chapter: 1, evidence: [evidence[0]] };
    claim.later = { chapter: 3, evidence: [evidence[1]] };
    claim.temporal_scope = { baseline_chapter: 1, later_chapter: 3 };

    const run = await review('bound-partial', [claim], packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    const envelope = run.envelope;
    assert.equal(envelope.version, packet.version);
    assert.equal(envelope.scope.universe_id, 'test-universe');
    assert.deepEqual(envelope.scope.chapters, [1, 3]);
    assert.deepEqual(envelope.scope.omitted, [2]);
    assert.deepEqual(envelope.scope.chapters_reviewed, [1, 3]);
    assert.match(envelope.scope.coverage_note, /omitted/);
    for (const comparison of envelope.comparisons) {
      assert.equal(comparison.temporal_scope.baseline_chapter, 1);
      assert.equal(comparison.temporal_scope.later_chapter, 3);
      assert.ok(comparison.baseline.evidence.length > 0);
      assert.ok(comparison.later.evidence.length > 0);
    }
  });

  test('the judged provenance survives the arithmetic', async () => {
    const packet = await fixture('provenance');
    const claim = {
      ...packet.claim(),
      subject: 'the valve in the cellar',
      evaluator: 'human:ana',
      method: 'two-pass close reading',
      confidence: 0.8,
      repair_suggestion: 'Have the valve adjusted on screen between the two scenes.',
    };
    const run = await review('provenance', [claim], packet);
    const [finding] = run.envelope.findings;
    assert.equal(finding.evaluator, 'human:ana');
    assert.equal(finding.method, 'two-pass close reading');
    assert.equal(finding.confidence, 0.8);
    assert.match(finding.repair_suggestion, /valve/);
    // The comparisons are stored separately from the findings and name their
    // subjects, so a reader can recompute the arithmetic from the records.
    const [comparison] = run.envelope.comparisons;
    assert.equal(comparison.id, 'comparison-0001');
    assert.deepEqual(comparison.claim_ids, ['claim-0001']);
    assert.equal(comparison.subject, finding.subject);
    assert.ok(run.envelope.reviewed_claims.includes('claim-0001'));
    assert.equal(
      run.envelope.counts.contradicted,
      run.envelope.comparisons.filter((item) => item.outcome === 'contradicted').length,
    );
    assert.equal(
      run.envelope.counts.eligible_comparisons,
      run.envelope.comparisons.length,
    );
  });
});
