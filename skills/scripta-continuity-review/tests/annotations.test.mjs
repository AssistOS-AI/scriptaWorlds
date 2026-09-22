// C13 — semantic annotations are evidence-bearing records.
//
// A claim is admitted only when it names a stable id, the accepted version it was
// written against, the scope it reviewed, its evaluator and method, a status from
// the declared set, a rationale and the bytes it rests on. Schema validation
// cannot prove a judgement correct, but it must ensure that the declared support
// actually exists and can be reviewed.

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  annotationsDocument,
  errorCodes,
  evidenceFor,
  exists,
  makeClaim,
  makePacket,
  parseEnvelope,
  runReview,
  sha256,
  snapshotTree,
  writeAnnotations,
} from './helpers.mjs';

const root = await mkdtemp(join(tmpdir(), 'continuity-annotations-'));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const CHAPTER_ONE = '# Capitolul 1\n\nRobinetul a fost deschis complet, iar presiunea a scăzut.\n';
const CHAPTER_TWO = '# Capitolul 2\n\nRobinetul era pe jumătate închis, fără nicio reparație.\n';
const QUOTE_ONE = 'Robinetul a fost deschis complet';
const QUOTE_TWO = 'Robinetul era pe jumătate închis';

let counter = 0;

// A packet of two Romanian chapters, plus the two evidence items a claim about
// them cites and a valid claim over them.
async function fixture(name) {
  counter += 1;
  const packet = await makePacket(join(root, `${name}-${counter}`), {
    chapters: ['0001-scene.md', '0002-scene.md'],
    chapterTexts: { '0001-scene.md': CHAPTER_ONE, '0002-scene.md': CHAPTER_TWO },
  });
  const evidence = [
    evidenceFor('ev-1', 'chapters/0001-scene.md', CHAPTER_ONE, QUOTE_ONE),
    evidenceFor('ev-2', 'chapters/0002-scene.md', CHAPTER_TWO, QUOTE_TWO),
  ];
  const claim = makeClaim(packet.packetDir, packet.version, evidence, {
    scope: { kind: 'book', chapters: [1, 2] },
  });
  return { ...packet, evidence, claim };
}

async function reviewAnnotations(name, document, packet) {
  const file = await writeAnnotations(root, `${name}.json`, document);
  const out = join(root, `${name}-out`);
  const result = await runReview(['--input', packet.packetDir, '--out', out, '--annotations', file]);
  return { file, out, result, envelope: parseEnvelope(result) };
}

async function reviewRawText(name, text, packet) {
  const file = join(root, `${name}-raw.json`);
  await writeFile(file, text, 'utf8');
  const out = join(root, `${name}-raw-out`);
  const result = await runReview(['--input', packet.packetDir, '--out', out, '--annotations', file]);
  return { file, out, result, envelope: parseEnvelope(result) };
}

async function expectRefusal(name, run, codes) {
  assert.equal(run.result.code, 2, `${name}: exit code; errors ${JSON.stringify(run.envelope.errors)}`);
  assert.equal(run.envelope.ok, false);
  assert.deepEqual(run.envelope.findings, [], `${name}: nothing is emitted for a refused file`);
  assert.deepEqual([...new Set(errorCodes(run.envelope))].sort(), [...codes].sort(), `${name}: codes`);
  for (const message of run.envelope.errors) assert.match(message, /^[A-Z_]+: \S/);
  assert.equal(await exists(run.out), false, `${name}: nothing written to --out`);
}

describe('a valid claim is admitted with its provenance', () => {
  test('a confirmed contradiction with paired evidence is counted and reported', async () => {
    const packet = await fixture('valid');
    const run = await reviewAnnotations('valid', annotationsDocument([packet.claim]), packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    assert.deepEqual(run.envelope.counts, {
      eligible_comparisons: 1,
      consistent: 0,
      contradicted: 1,
      unresolved: 0,
    });
    const [finding] = run.envelope.findings;
    assert.equal(finding.id, 'claim-0001');
    assert.equal(finding.status, 'confirmed');
    assert.equal(finding.evaluator, 'human:reviewer');
    assert.equal(finding.method, 'close reading against the frozen packet');
    assert.equal(finding.source_version, packet.version);
    assert.equal(finding.comparison_id, 'comparison-0001');
    assert.equal(finding.rationale, packet.claim.rationale);
    assert.equal(finding.evidence.length, 2);
    assert.match(finding.alternative_explanation, /repair/);
  });

  test('an unresolved reading keeps its declared limitation and is not counted as contradicted', async () => {
    const packet = await fixture('unresolved');
    const claim = { ...packet.claim, id: 'claim-0002', status: 'unresolved' };
    claim.limitations = 'The narrator may be unreliable here, and the second scene is a recollected account.';
    const run = await reviewAnnotations('unresolved', annotationsDocument([claim]), packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    assert.deepEqual(run.envelope.counts, {
      eligible_comparisons: 1,
      consistent: 0,
      contradicted: 0,
      unresolved: 1,
    });
    assert.equal(run.envelope.findings[0].status, 'unresolved');
    assert.match(run.envelope.findings[0].limitations, /unreliable/);
  });

  test('an unresolved reading without its limitation is refused', async () => {
    const packet = await fixture('unresolved-no-limitation');
    const claim = { ...packet.claim, status: 'unresolved' };
    const run = await reviewAnnotations('unresolved-no-limitation', annotationsDocument([claim]), packet);
    await expectRefusal('unresolved-no-limitation', run, ['INVALID_ANNOTATIONS']);
  });

  test('a dismissed reading with paired evidence is a supported comparison, not a defect', async () => {
    const packet = await fixture('supported');
    const claim = {
      ...packet.claim,
      status: 'dismissed',
      alternative_explanation: 'The character repaired the valve between the two scenes.',
    };
    const run = await reviewAnnotations('supported', annotationsDocument([claim]), packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    assert.deepEqual(run.envelope.counts, {
      eligible_comparisons: 1,
      consistent: 1,
      contradicted: 0,
      unresolved: 0,
    });
    assert.equal(run.envelope.comparisons[0].outcome, 'supported');
    assert.equal(run.envelope.findings[0].declared_status, 'dismissed');
    assert.match(run.envelope.findings[0].alternative_explanation, /repaired/);
  });

  test('a resolved verdict without paired baseline and later evidence is preserved but not settled', async () => {
    const packet = await fixture('unpaired');
    const claim = { ...packet.claim };
    delete claim.baseline;
    delete claim.later;
    delete claim.temporal_scope;
    const run = await reviewAnnotations('unpaired', annotationsDocument([claim]), packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    assert.deepEqual(run.envelope.counts, {
      eligible_comparisons: 1,
      consistent: 0,
      contradicted: 0,
      unresolved: 1,
    });
    const [finding] = run.envelope.findings;
    assert.equal(finding.status, 'unresolved');
    assert.equal(finding.declared_status, 'confirmed');
    assert.equal(finding.downgraded_to_unresolved, true);
    assert.ok(run.envelope.warnings.some((warning) => /paired baseline\/later/.test(warning)));
  });

  test('a dismissed verdict without paired evidence is not a free consistent count', async () => {
    const packet = await fixture('unpaired-dismissed');
    const claim = { ...packet.claim, status: 'dismissed' };
    delete claim.baseline;
    delete claim.later;
    delete claim.temporal_scope;
    const run = await reviewAnnotations('unpaired-dismissed', annotationsDocument([claim]), packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    assert.deepEqual(run.envelope.counts, {
      eligible_comparisons: 1,
      consistent: 0,
      contradicted: 0,
      unresolved: 1,
    });
  });

  test('a character change names its attribute and catalyst', async () => {
    const packet = await fixture('character-change');
    const claim = {
      ...packet.claim,
      category: 'character_attribute',
      subject: 'Mara',
      attribute: 'literacy',
      catalyst: 'the ledger she is forced to read in chapter 2',
    };
    const run = await reviewAnnotations('character-change', annotationsDocument([claim]), packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    const [comparison] = run.envelope.comparisons;
    assert.equal(comparison.kind, 'character_change');
    assert.equal(comparison.attribute, 'literacy');
    assert.match(comparison.catalyst, /ledger/);
    assert.equal(run.envelope.findings[0].attribute, 'literacy');
  });
});

describe('a claim without real support is refused', () => {
  test('a confirmed contradiction with empty evidence is refused', async () => {
    const packet = await fixture('empty-evidence');
    const claim = { ...packet.claim, evidence: [], baseline: null, later: null };
    const run = await reviewAnnotations('empty-evidence', annotationsDocument([claim]), packet);
    await expectRefusal('empty-evidence', run, ['INVALID_ANNOTATIONS']);
  });

  test('a fabricated quote is refused', async () => {
    const packet = await fixture('fabricated');
    const claim = {
      ...packet.claim,
      evidence: [{ ...packet.evidence[0], quote: 'Robinetul nu a fost deschis niciodată' }],
    };
    const run = await reviewAnnotations('fabricated', annotationsDocument([claim]), packet);
    await expectRefusal('fabricated', run, ['INVALID_EVIDENCE']);
  });

  test('a quote whose declared hash is not the packet file is refused', async () => {
    const packet = await fixture('stale-hash');
    const claim = { ...packet.claim, evidence: [{ ...packet.evidence[0], sha256: sha256('another text') }] };
    const run = await reviewAnnotations('stale-hash', annotationsDocument([claim]), packet);
    await expectRefusal('stale-hash', run, ['INVALID_EVIDENCE']);
  });

  test('an offset that splits a character is refused', async () => {
    const packet = await fixture('bad-offset');
    const item = packet.evidence[0];
    const claim = { ...packet.claim, evidence: [{ ...item, start: item.start + 1 }] };
    const run = await reviewAnnotations('bad-offset', annotationsDocument([claim]), packet);
    await expectRefusal('bad-offset', run, ['INVALID_EVIDENCE']);
  });

  test('a claim written against another version is refused', async () => {
    const packet = await fixture('other-version');
    const claim = { ...packet.claim, source_version: `sha256:${'1'.repeat(64)}` };
    const run = await reviewAnnotations('other-version', annotationsDocument([claim]), packet);
    await expectRefusal('other-version', run, ['INVALID_ANNOTATIONS']);
    assert.match(run.envelope.errors[0], /source_version/);
  });

  test('duplicate claim ids are refused', async () => {
    const packet = await fixture('duplicate-ids');
    const run = await reviewAnnotations(
      'duplicate-ids',
      annotationsDocument([packet.claim, { ...packet.claim }]),
      packet,
    );
    await expectRefusal('duplicate-ids', run, ['DUPLICATE_ID']);
  });

  test('duplicate evidence ids inside one claim are refused', async () => {
    const packet = await fixture('duplicate-evidence');
    const claim = {
      ...packet.claim,
      evidence: [packet.evidence[0], { ...packet.evidence[1], id: packet.evidence[0].id }],
    };
    const run = await reviewAnnotations('duplicate-evidence', annotationsDocument([claim]), packet);
    await expectRefusal('duplicate-evidence', run, ['DUPLICATE_ID']);
  });

  test('an invalid category such as banana is refused', async () => {
    const packet = await fixture('category');
    const claim = { ...packet.claim, category: 'banana' };
    const run = await reviewAnnotations('category', annotationsDocument([claim]), packet);
    await expectRefusal('category', run, ['INVALID_ANNOTATIONS']);
  });

  test('an unsupported status is refused', async () => {
    const packet = await fixture('status');
    const claim = { ...packet.claim, status: 'certain' };
    const run = await reviewAnnotations('status', annotationsDocument([claim]), packet);
    await expectRefusal('status', run, ['INVALID_ANNOTATIONS']);
  });

  test('an unknown claim kind and an unknown scope kind are refused', async () => {
    const kind = await fixture('claim-kind');
    const badKind = { ...kind.claim, kind: 'vibe' };
    await expectRefusal(
      'claim-kind',
      await reviewAnnotations('claim-kind', annotationsDocument([badKind]), kind),
      ['INVALID_ANNOTATIONS'],
    );

    const scope = await fixture('scope-kind');
    const badScope = { ...scope.claim, scope: { kind: 'somewhere', chapters: [1] } };
    await expectRefusal(
      'scope-kind',
      await reviewAnnotations('scope-kind', annotationsDocument([badScope]), scope),
      ['INVALID_ANNOTATIONS'],
    );
  });

  test('a missing evaluator, method or rationale is refused', async () => {
    for (const field of ['evaluator', 'method', 'rationale']) {
      const packet = await fixture(`missing-${field}`);
      const claim = { ...packet.claim, id: `claim-${field}` };
      delete claim[field];
      const run = await reviewAnnotations(`missing-${field}`, annotationsDocument([claim]), packet);
      await expectRefusal(`missing-${field}`, run, ['INVALID_ANNOTATIONS']);
    }
  });

  test('a malformed container is refused rather than iterated', async () => {
    const cases = [
      ['findings-not-array', (packet) => ({ schema_version: 'annotations.v1', findings: {} })],
      [
        'evidence-not-array',
        (packet) => annotationsDocument([{ ...packet.claim, evidence: 'quoted text' }]),
      ],
      [
        'finding-not-object',
        (packet) => annotationsDocument([packet.claim, 'a sentence about the book']),
      ],
      [
        'baseline-not-evidence',
        (packet) => annotationsDocument([{ ...packet.claim, baseline: 42 }]),
      ],
    ];
    for (const [name, build] of cases) {
      const packet = await fixture(name);
      const run = await reviewAnnotations(name, build(packet), packet);
      await expectRefusal(name, run, ['INVALID_ANNOTATIONS']);
    }
  });

  test('a non-finite number and an out-of-range confidence are refused', async () => {
    const nonFinite = await fixture('non-finite');
    const literal = JSON.stringify(annotationsDocument([nonFinite.claim]), null, 2).replace(
      '"alternative_explanation"',
      '"confidence": 1e999,\n    "alternative_explanation"',
    );
    await expectRefusal(
      'non-finite',
      await reviewRawText('non-finite', literal, nonFinite),
      ['INVALID_ANNOTATIONS'],
    );

    const range = await fixture('confidence-range');
    const claim = { ...range.claim, confidence: 1.5 };
    await expectRefusal(
      'confidence-range',
      await reviewAnnotations('confidence-range', annotationsDocument([claim]), range),
      ['INVALID_ANNOTATIONS'],
    );
  });

  test('an unknown annotations schema_version and a file that is not JSON are refused', async () => {
    const packet = await fixture('annotations-schema');
    const file = await writeAnnotations(root, 'schema.json', { schema_version: 'annotations.v2', findings: [] });
    const out = join(root, 'annotations-schema-out');
    const result = await runReview(['--input', packet.packetDir, '--out', out, '--annotations', file]);
    await expectRefusal('schema', { result, out, envelope: parseEnvelope(result) }, ['SCHEMA_VERSION']);

    await expectRefusal('broken', await reviewRawText('broken', '{ not json\n', packet), ['BAD_JSON']);
  });

  test('a claim scope that names a chapter the packet does not contain is refused', async () => {
    const packet = await fixture('scope-chapter');
    const claim = { ...packet.claim, scope: { kind: 'chapter', chapters: [7] } };
    const run = await reviewAnnotations('scope-chapter', annotationsDocument([claim]), packet);
    await expectRefusal('scope-chapter', run, ['INVALID_ANNOTATIONS']);
  });

  test('a claim scoped to a declared omission is kept, and the warning says so', async () => {
    const packet = await makePacket(join(root, 'scope-omitted'), {
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
      scope: { kind: 'arc', chapters: [1, 2, 3] },
    });
    claim.baseline = { chapter: 1, evidence: [evidence[0]] };
    claim.later = { chapter: 3, evidence: [evidence[1]] };
    claim.temporal_scope = { baseline_chapter: 1, later_chapter: 3 };
    const run = await reviewAnnotations('scope-omitted', annotationsDocument([claim]), packet);
    assert.equal(run.result.code, 0, JSON.stringify(run.envelope.errors));
    assert.deepEqual(run.envelope.counts, {
      eligible_comparisons: 1,
      consistent: 0,
      contradicted: 1,
      unresolved: 0,
    });
    assert.ok(
      run.envelope.warnings.some((warning) => /chapter 2/.test(warning) && /omitted/.test(warning)),
      'a scope reaching into an omitted chapter is disclosed',
    );
  });

  test('a refused annotations file leaves the packet byte-identical', async () => {
    const packet = await fixture('packet-intact');
    const before = await snapshotTree(packet.packetDir);
    const claim = { ...packet.claim, evidence: [] };
    const run = await reviewAnnotations('packet-intact', annotationsDocument([claim]), packet);
    await expectRefusal('packet-intact', run, ['INVALID_ANNOTATIONS']);
    assert.deepEqual(await snapshotTree(packet.packetDir), before);
  });
});

describe('the annotations file is optional', () => {
  test('no annotations means no semantic comparisons and a note saying so', async () => {
    const packet = await fixture('no-annotations');
    const out = join(root, 'no-annotations-out');
    const result = await runReview(['--input', packet.packetDir, '--out', out]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 0);
    assert.deepEqual(envelope.counts, {
      eligible_comparisons: 0,
      consistent: 0,
      contradicted: 0,
      unresolved: 0,
    });
    assert.match(envelope.scope.coverage_note, /No annotations supplied/);
    assert.deepEqual(envelope.reviewed_claims, []);
  });

  test('a missing annotations file is a refusal, not an execution failure', async () => {
    const packet = await fixture('annotations-missing');
    const out = join(root, 'annotations-missing-out');
    const result = await runReview([
      '--input',
      packet.packetDir,
      '--out',
      out,
      '--annotations',
      join(root, 'does-not-exist.json'),
    ]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 2);
    assert.deepEqual(errorCodes(envelope), ['MISSING_ANNOTATIONS']);
    assert.equal(await exists(out), false);
  });
});

test('the annotations fixture itself is well formed', async () => {
  const packet = await fixture('fixture-check');
  const text = await readFile(join(packet.packetDir, 'chapters/0001-scene.md'), 'utf8');
  assert.equal(text, CHAPTER_ONE);
  assert.equal(packet.evidence[0].sha256, sha256(CHAPTER_ONE));
});
