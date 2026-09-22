import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderViews, VIEW_FILES } from '../scripts/lib/render.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runCli, runReport, sha256, tempDir } from './helpers.mjs';

const OUTPUT_FILES = ['assessment.json', 'index.md', ...VIEW_FILES];

function hashFile(file) {
  return sha256(readFileSync(file));
}

function snapshot(fx) {
  return {
    manifest: hashFile(join(fx.packetDir, 'manifest.json')),
    chapter1: hashFile(join(fx.packetDir, 'chapters/0001.md')),
    profile: hashFile(fx.profilePath),
    annotations: hashFile(fx.annotationsPath),
    corpus: hashFile(fx.corpusPath),
    dataset: hashFile(join(fx.root, 'dataset/corpus.txt')),
  };
}

test('builds all views deterministically, records the packet version and scope, and never mutates its inputs', () => {
  const root = tempDir('metrics-report-');
  try {
    const fx = buildReportFixture(root);
    const before = snapshot(fx);
    const out1 = join(root, 'out1');
    const out2 = join(root, 'out2');

    const env = runReport(fx, out1);
    assert.equal(env.status, 0, env.stdout);
    assert.equal(env.envelope.ok, true);
    assert.equal(env.envelope.schema_version, 'assessment-result.v1');
    assert.equal(typeof env.envelope.assessment_id, 'string');
    assert.deepEqual(env.envelope.outputs, OUTPUT_FILES);
    assert.deepEqual(env.envelope.errors, []);
    for (const name of OUTPUT_FILES) {
      assert.ok(existsSync(join(out1, name)), `missing ${name}`);
    }

    const second = runReport(fx, out2);
    assert.equal(second.status, 0);
    for (const name of OUTPUT_FILES) {
      assert.deepEqual(readFileSync(join(out2, name)), readFileSync(join(out1, name)), `${name} differs between runs`);
    }
    assert.deepEqual(snapshot(fx), before, 'no input may be modified or written into');

    const bundle = readJson(join(out1, 'assessment.json'));
    assert.equal(bundle.schema_version, 'assessment.v1');
    assert.equal(bundle.version, fx.packet.version);
    assert.equal(bundle.provenance.packet.version, fx.packet.version);
    assert.deepEqual(bundle.scope.chapters, [1]);
    assert.deepEqual(bundle.scope.context_chapters, [2]);
    assert.deepEqual(bundle.scope.population, ['1']);
    assert.equal(bundle.coverage.packet_scope, 'complete');
    assert.equal(bundle.coverage.tokenizer.supported, true);
    assert.equal(bundle.coverage.tokenizer.eligible_tokens, 18, 'only the selected chapter is candidate text');

    // Metrics with their discriminated value kinds.
    assert.equal(bundle.metrics.CS.status, 'judged');
    assert.equal(bundle.metrics.CS.value_kind, 'components');
    assert.equal(bundle.metrics.CS.value, 75);
    assert.equal(bundle.metrics.CS.components.causal_support.rating, 3);
    assert.equal(bundle.metrics.OI.value, 50);
    assert.equal(bundle.metrics.NCS.value, null);
    assert.equal(bundle.metrics.NCS.value_kind, 'components');
    assert.equal(bundle.metrics.EAP.value_kind, 'trajectory');
    assert.equal(bundle.metrics.EAP.value, null);
    assert.equal(bundle.metrics.EAP.trajectory.length, 2);
    assert.equal(bundle.metrics.EAP.ordering, 'story');
    assert.equal(bundle.metrics.CCI.status, 'computed');
    assert.equal(bundle.metrics.CCI.value, 50);
    assert.equal(bundle.metrics.CAD.status, 'computed');
    assert.equal(bundle.metrics.CAD.value, 100);
    assert.equal(bundle.metrics.CAR.status, 'computed');
    assert.equal(bundle.metrics.CAR.value, 100);
    assert.equal(bundle.metrics.SI.status, 'computed');
    assert.equal(bundle.metrics.SI.value, 0);
    assert.equal(bundle.metrics.SI.maximum_reference, undefined);
    assert.equal(bundle.metrics.TOP.status, 'computed');
    assert.equal(bundle.metrics.TOP.value, 0);
    assert.equal(bundle.metrics.CR.status, 'computed');
    assert.equal(bundle.metrics.CR.value, 0);
    assert.equal(bundle.metrics.CR.coverage, 1);
    assert.equal(bundle.metrics.AEG.status, 'computed');
    assert.equal(bundle.metrics.AEG.value, -20);
    assert.equal(bundle.metrics.NQS.status, 'not_assessable');

    // Rules keyed by (rule, output), with CAR over the declared population.
    const requirements = bundle.requirements;
    assert.equal(requirements.registry_version, 'stg-rules.v1');
    assert.equal(requirements.rules.length, 4);
    assert.equal(requirements.car.expected_outcomes, 4);
    assert.equal(requirements.car.recorded_outcomes, 3);
    assert.equal(requirements.car.outcome_coverage, 0.75);
    assert.equal(requirements.car.value, 100);
    assert.deepEqual(requirements.pairs.find((pair) => pair.rule === 'req-ending').source, 'request');

    // Evidence keeps the verified quote, and the context chapter explains a fact.
    const ev1 = bundle.evidence.find((item) => item.id === 'ev1');
    assert.equal(ev1.quote, 'planetă');
    assert.equal(ev1.file, 'chapters/0001.md');
    assert.deepEqual(bundle.findings.map((finding) => finding.id), ['find-1', 'find-2']);
    assert.deepEqual(bundle.findings[1].temporal, { baseline: ['ev3'], later: ['ev4'] });
    assert.ok(bundle.findings[1].evidence.includes('ev3'), 'evidence from the context chapter is admitted');
    assert.equal(bundle.segments.length, 3);
    assert.equal(bundle.segment_order.differs, true);
    assert.equal(bundle.preserved_qualities.passages[0].rationale, 'The opening image is worth keeping.');

    // Re-rendering a stored bundle is byte-identical and makes no new judgement.
    const first = renderViews(bundle);
    assert.deepEqual(renderViews(bundle), first);
    assert.deepEqual(Object.keys(first).sort(), ['index.md', ...VIEW_FILES].sort());
  } finally {
    cleanup([root]);
  }
});

test('a tampered packet, a malformed complete packet and a superseded manifest exit 2 with nothing written', () => {
  const root = tempDir('metrics-report-');
  try {
    // Declared byte count and hash are wrong.
    const fx = buildReportFixture(root);
    const manifestPath = join(fx.packetDir, 'manifest.json');
    const manifest = readJson(manifestPath);
    manifest.files[0].bytes += 1;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const out = join(root, 'out-bytes');
    const env = runReport(fx, out);
    assert.equal(env.status, 2);
    assert.equal(env.envelope.ok, false);
    assert.equal(env.envelope.code, 'BYTE_MISMATCH');
    assert.ok(env.envelope.error.includes('bytes'), env.envelope.error);
    assert.ok(!existsSync(out), 'a refused run writes nothing');

    // A stale version identity after a corrected byte count and hash.
    const root2 = join(root, 'tamper');
    mkdirSync(root2);
    const fx2 = buildReportFixture(root2, {});
    const tampered = Buffer.from('A rewritten chapter body that the manifest still attributes to the old version.\n', 'utf8');
    writeFileSync(join(fx2.packetDir, 'chapters/0001.md'), tampered);
    const manifest2 = readJson(join(fx2.packetDir, 'manifest.json'));
    manifest2.files[0].sha256 = sha256(tampered);
    manifest2.files[0].bytes = tampered.length;
    writeFileSync(join(fx2.packetDir, 'manifest.json'), JSON.stringify(manifest2, null, 2));
    const staleOut = join(root2, 'out');
    const stale = runReport(fx2, staleOut);
    assert.equal(stale.status, 2);
    assert.equal(stale.envelope.code, 'VERSION_MISMATCH');
    assert.ok(!existsSync(staleOut));

    // A malformed complete packet: an interior chapter is missing.
    const root3 = join(root, 'gap');
    mkdirSync(root3);
    const fx3 = buildReportFixture(root3, {
      chapters: { 1: 'chapter one body here', 3: 'chapter three body here' },
      lastAccepted: 3,
      scopeKind: 'complete',
      omitted: [],
    });
    const gapOut = join(root3, 'out');
    const gap = runReport(fx3, gapOut);
    assert.equal(gap.status, 2);
    assert.equal(gap.envelope.code, 'SCOPE_INCOMPLETE');
    assert.ok(gap.envelope.error.includes('interior chapter 2'), gap.envelope.error);
    assert.ok(!existsSync(gapOut));

    // A superseded v1 manifest names the supported schema instead of guessing.
    const root4 = join(root, 'legacy');
    mkdirSync(root4);
    writeFileSync(join(root4, 'manifest.json'), JSON.stringify({ schema_version: 'assessment-input.v1' }));
    const legacy = runCli(['--input', root4, '--out', join(root4, 'out'), '--profile', fx.profilePath]);
    assert.equal(legacy.status, 2);
    assert.equal(legacy.envelope.code, 'SCHEMA_VERSION');
    assert.ok(legacy.envelope.error.includes('assessment-input.v2'), legacy.envelope.error);

    // A stale annotation set cannot be attributed to this version.
    const root5 = join(root, 'stale-annotations');
    mkdirSync(root5);
    const fx5 = buildReportFixture(root5, {
      annotations: (annotations) => {
        annotations.source_version = `sha256:${'0'.repeat(64)}`;
      },
    });
    const staleAnn = runReport(fx5, join(root5, 'out'));
    assert.equal(staleAnn.status, 2);
    assert.equal(staleAnn.envelope.code, 'STALE_ANNOTATION');
  } finally {
    cleanup([root]);
  }
});

test('a script the tokenizer cannot segment yields unavailable lexical metrics, never zero', () => {
  const root = tempDir('metrics-language-');
  try {
    const fx = buildReportFixture(root, {
      language: 'zh',
      chapters: { 1: '这是一个测试句子', 2: '这是另一个测试句子' },
      contextChapters: [],
      noContinuity: true,
    });
    const out = join(root, 'out');
    const env = runCli([
      '--input',
      fx.packetDir,
      '--out',
      out,
      '--profile',
      fx.profilePath,
      '--corpus',
      fx.corpusPath,
    ]);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.coverage.tokenizer.supported, false);
    assert.ok(bundle.coverage.tokenizer.reason.includes('unsupported'), bundle.coverage.tokenizer.reason);
    assert.equal(bundle.metrics.SI.status, 'not_assessable');
    assert.equal(bundle.metrics.SI.value, null);
    assert.ok(bundle.metrics.SI.missing_reason.includes('unsupported'), bundle.metrics.SI.missing_reason);
    assert.equal(bundle.metrics.TOP.status, 'not_assessable');
    assert.equal(bundle.metrics.TOP.value, null);
    assert.ok(
      bundle.coverage.tokenizer.reason.includes('unsupported'),
      'the report states the limitation instead of reporting a zero overlap',
    );
    assert.ok(!JSON.stringify(bundle.metrics.TOP).includes('"value":0'), 'no misleading zero');
  } finally {
    cleanup([root]);
  }
});

test('a declared partial packet is accepted and every view names what was omitted', () => {
  const root = tempDir('metrics-report-');
  try {
    const fx = buildReportFixture(root, {
      chapters: { 1: 'chapter one body here', 3: 'chapter three body here' },
      lastAccepted: 3,
      scopeKind: 'partial',
      omitted: [2],
      scopeChapters: [1],
      contextChapters: [],
      annotations: (annotations) => {
        // Only chapter 1 is present, so the chapter-2 scene, its evidence, the
        // arc and the continuity result are not part of this packet.
        annotations.evidence = annotations.evidence.filter((item) => item.file === 'chapters/0001.md');
        annotations.segments = annotations.segments.filter((segment) => segment.kind === 'scene' && segment.chapter === 1);
        annotations.metrics.EAP.trajectory = annotations.metrics.EAP.trajectory.filter((point) => point.segment_id === 'seg1');
        delete annotations.continuity;
      },
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.coverage.packet_scope, 'partial');
    assert.deepEqual(bundle.coverage.omitted_chapters, [2]);
    assert.equal(bundle.coverage.packet_chapters.join(','), '1,3');
    assert.ok(bundle.coverage.note.includes('partial'), bundle.coverage.note);
    assert.ok(bundle.coverage.note.includes('2'), bundle.coverage.note);
    const index = readFileSync(join(out, 'index.md'), 'utf8');
    assert.ok(index.includes('Omitted chapters: 2'), index);
    const metricsView = readFileSync(join(out, '03-metrics-and-indicators.md'), 'utf8');
    assert.ok(metricsView.includes('Omitted chapters: 2'), metricsView);
  } finally {
    cleanup([root]);
  }
});

test('a textual_only packet reports that no continuity context was available', () => {
  const root = tempDir('metrics-report-');
  try {
    const fx = buildReportFixture(root, {
      stateRoles: [],
      scopeKind: 'textual_only',
      noContinuity: true,
      profile: { scope: { kind: 'chapter', chapters: [1], context_chapters: [2] } },
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.coverage.packet_scope, 'textual_only');
    assert.equal(bundle.coverage.continuity.applicable, false);
    assert.ok(bundle.coverage.note.includes('textual_only'), bundle.coverage.note);
    assert.equal(bundle.metrics.CCI.status, 'not_assessable');
    assert.ok(bundle.metrics.CCI.missing_reason.includes('no continuity-result.v1'), bundle.metrics.CCI.missing_reason);
    assert.equal(bundle.metrics.CAD.status, 'not_assessable');
    const index = readFileSync(join(out, 'index.md'), 'utf8');
    assert.ok(index.includes('textual_only'), index);
    const metricsView = readFileSync(join(out, '03-metrics-and-indicators.md'), 'utf8');
    assert.ok(metricsView.includes('no continuity-result.v1 supplied'), metricsView);
  } finally {
    cleanup([root]);
  }
});

/* ------------------------------ C09 / C10 publication ------------------------------ */

test('an output equal to, nested under or aliased into an input is refused before any write', () => {
  const root = tempDir('metrics-report-');
  try {
    const fx = buildReportFixture(root);
    const before = snapshot(fx);

    const equal = runReport(fx, fx.packetDir);
    assert.equal(equal.status, 2);
    assert.equal(equal.envelope.code, 'OUTPUT_INSIDE_INPUT');

    const nested = runReport(fx, join(fx.packetDir, 'result'));
    assert.equal(nested.status, 2);
    assert.equal(nested.envelope.code, 'OUTPUT_INSIDE_INPUT');
    assert.ok(!existsSync(join(fx.packetDir, 'result')));

    // A symlink inside the packet pointing back at the packet: the resolved
    // destination is the packet itself even though the path string is not.
    const alias = join(root, 'alias');
    symlinkSync(fx.packetDir, alias);
    const aliased = runReport(fx, join(alias, 'result'));
    assert.equal(aliased.status, 2);
    assert.ok(['OUTPUT_INSIDE_INPUT', 'OUTPUT_CONTAINS_INPUT', 'PATH_ESCAPE'].includes(aliased.envelope.code), aliased.envelope.code);
    assert.ok(!existsSync(join(fx.packetDir, 'result')), 'no write may reach the packet through the alias');

    // A collision with a supplied input file rather than a directory.
    const collision = runReport(fx, fx.annotationsPath);
    assert.equal(collision.status, 2);
    assert.ok(['OUTPUT_INSIDE_INPUT', 'OUTPUT_CONTAINS_INPUT'].includes(collision.envelope.code), collision.envelope.code);

    assert.deepEqual(snapshot(fx), before, 'a refused run leaves every input byte-identical');
  } finally {
    cleanup([root]);
  }
});

test('a new or empty destination is published atomically and a non-empty one is refused unchanged', () => {
  const root = tempDir('metrics-report-');
  try {
    const fx = buildReportFixture(root);

    // Not-yet-existing destination.
    const fresh = join(root, 'fresh');
    const created = runReport(fx, fresh);
    assert.equal(created.status, 0, created.stdout);
    assert.deepEqual(readdirSync(fresh).sort(), [...OUTPUT_FILES].sort());
    assert.equal(created.envelope.output_dir, fresh);

    // Existing empty destination.
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const reused = runReport(fx, empty);
    assert.equal(reused.status, 0, reused.stdout);

    // An existing accepted assessment is never overwritten file by file.
    const nonEmpty = join(root, 'accepted');
    mkdirSync(nonEmpty);
    writeFileSync(join(nonEmpty, 'index.md'), '# previous accepted assessment\n');
    const previous = hashFile(join(nonEmpty, 'index.md'));
    const refused = runReport(fx, nonEmpty);
    assert.equal(refused.status, 2);
    assert.equal(refused.envelope.code, 'OUTPUT_NOT_EMPTY');
    assert.equal(hashFile(join(nonEmpty, 'index.md')), previous);
    assert.deepEqual(readdirSync(nonEmpty), ['index.md'], 'a refused publication adds nothing');

    // A destination that is a file, not a directory.
    const fileOut = join(root, 'file-out');
    writeFileSync(fileOut, 'not a directory\n');
    const notDirectory = runReport(fx, fileOut);
    assert.equal(notDirectory.status, 2);
    assert.equal(notDirectory.envelope.code, 'OUTPUT_NOT_DIRECTORY');

    // A failed execution leaves no apparently current assessment.json.
    const failing = buildReportFixture(join(root, 'bad'), {
      annotations: (annotations) => {
        annotations.requirements.outcomes = [{ rule: 'unknown-rule', output: 1, outcome: 'pass', evidence: ['ev1'] }];
      },
    });
    const badOut = join(root, 'bad-out');
    const failed = runReport(failing, badOut);
    assert.equal(failed.status, 2);
    assert.equal(failed.envelope.code, 'UNKNOWN_RULE');
    assert.ok(!existsSync(badOut), 'a failed run publishes nothing at all');
    assert.equal(runCli(['--input', fx.packetDir, '--profile', fx.profilePath]).envelope.code, 'USAGE');
    rmSync(fileOut, { force: true });
  } finally {
    cleanup([root]);
  }
});
