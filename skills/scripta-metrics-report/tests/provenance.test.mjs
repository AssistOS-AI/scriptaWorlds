// C75: the portable bundle carries what the evaluator saw and which judgement produced each result.
//
// A later session has to be able to check the bundle against its own copies: the hashes of every
// resource the run read, the evaluation configuration it obeyed, the scope it measured and the
// declared provenance of the evaluator's own run — carried verbatim, hashed, and without a single
// invented number. Model variability is stated rather than hidden, and provider usage appears only
// when the evaluator observed it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { renderViews } from '../scripts/lib/render.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { HERE, cleanup, readJson, runReport, sha256, tempDir } from './helpers.mjs';

const DECLARED = {
  prompt: { sha256: `${'1'.repeat(64)}`, bytes: 4096, path: 'generated/annotation-prompt.txt' },
  rubric: { id: 'rubric-anchors.v1', sha256: `${'2'.repeat(64)}` },
  cases: { id: 'literary-cases', sha256: `${'3'.repeat(64)}` },
  model: 'deepseek/deepseek-v4-flash',
  settings: { temperature: 0, max_output_items: 20 },
  attempts: [{ attempt: 1, identity: 'attempt-1', accepted: true, artifact_sha256: `${'4'.repeat(64)}` }],
  resource_selection: { chapters: [1], context_chapters: [2] },
  provider_usage: { input_tokens: 8123, output_tokens: 991 },
};

function runFixture(root, options = {}) {
  const { outName = 'out', ...fixtureOptions } = options;
  const fx = buildReportFixture(join(root, `fx-${outName}`), fixtureOptions);
  const out = join(root, outName);
  const env = runReport(fx, out);
  assert.equal(env.status, 0, env.stdout);
  return { fx, out, bundle: readJson(join(out, 'assessment.json')) };
}

test('every resource the run read carries the hash of the bytes it actually consumed', () => {
  const root = tempDir('metrics-c75-');
  try {
    const { fx, bundle } = runFixture(root);
    const byRole = new Map(bundle.provenance.resources.map((entry) => [entry.role, entry]));
    assert.deepEqual([...byRole.keys()].sort(), ['annotations', 'corpus', 'profile']);
    for (const [role, path] of [
      ['profile', fx.profilePath],
      ['annotations', fx.annotationsPath],
      ['corpus', fx.corpusPath],
    ]) {
      const bytes = readFileSync(path);
      assert.equal(byRole.get(role).sha256, sha256(bytes), `${role} hash`);
      assert.equal(byRole.get(role).bytes, statSync(path).size, `${role} byte count`);
      assert.equal(byRole.get(role).path, resolve(path));
    }
    // The generated judgement document is identified by the hash of its own bytes, not by its path.
    assert.equal(bundle.provenance.annotations.sha256, sha256(readFileSync(fx.annotationsPath)));
    assert.equal(bundle.provenance.profile_sha256, sha256(readFileSync(fx.profilePath)));

    // The evaluation configuration the bundle obeys is hashed from the skill's own published files.
    const skillRoot = resolve(HERE, '..');
    assert.equal(bundle.provenance.evaluation.rubric.sha256, sha256(readFileSync(join(skillRoot, 'schema', 'rubric-anchors.v1.json'))));
    assert.equal(bundle.provenance.evaluation.vocabulary.sha256, sha256(readFileSync(join(skillRoot, 'schema', 'annotations.v1.json'))));
    assert.equal(bundle.provenance.evaluation.case_library.sha256, sha256(readFileSync(join(skillRoot, 'fixtures', 'literary-cases', 'index.json'))));
    assert.equal(bundle.provenance.evaluation.rubric_version, 'rubric-anchors.v1');
    assert.equal(bundle.provenance.evaluation.anchor_scale, 4);
  } finally {
    cleanup([root]);
  }
});

test('the declared evaluator provenance is carried verbatim under a digest of its own', () => {
  const root = tempDir('metrics-c75-declared-');
  try {
    const { bundle } = runFixture(root, {
      annotations: (annotations) => {
        annotations.evaluator_provenance = DECLARED;
      },
    });
    assert.deepEqual(bundle.provenance.evaluator_provenance, DECLARED, 'the declaration is neither completed nor corrected');
    assert.match(bundle.provenance.evaluator_provenance_sha256, /^[0-9a-f]{64}$/);
    assert.equal(bundle.provenance.evaluation.model_variability.declared_model, 'deepseek/deepseek-v4-flash');
    assert.deepEqual(bundle.provenance.evaluation.model_variability.declared_settings, { temperature: 0, max_output_items: 20 });

    // The digest describes the record, not the formatting it arrived in, and changes when it changes.
    const again = runFixture(root, {
      annotations: (annotations) => {
        annotations.evaluator_provenance = JSON.parse(JSON.stringify(DECLARED));
      },
      outName: 'out2',
    });
    assert.equal(again.bundle.provenance.evaluator_provenance_sha256, bundle.provenance.evaluator_provenance_sha256);
    const changed = runFixture(root, {
      annotations: (annotations) => {
        annotations.evaluator_provenance = { ...DECLARED, model: 'another/model' };
      },
      outName: 'out3',
    });
    assert.notEqual(changed.bundle.provenance.evaluator_provenance_sha256, bundle.provenance.evaluator_provenance_sha256);
  } finally {
    cleanup([root]);
  }
});

test('no provider usage and no model identity are invented when the evaluator declared none', () => {
  const root = tempDir('metrics-c75-none-');
  try {
    const { bundle } = runFixture(root);
    assert.equal(bundle.provenance.evaluator_provenance, null);
    assert.equal(bundle.provenance.evaluator_provenance_sha256, null);
    const variability = bundle.provenance.evaluation.model_variability;
    assert.equal(variability.declared_model, null, 'an unrecorded model stays unrecorded');
    assert.equal(variability.declared_settings, null);
    assert.ok(variability.note.includes('may produce different judgements'), variability.note);
    assert.deepEqual(bundle.provenance.evaluation.evaluators, ['author', 'human-1'], 'the labels actually used are listed');
    const published = JSON.stringify(bundle);
    assert.ok(!published.includes('provider_usage'), 'no usage appears that nobody observed');
    assert.ok(!/"cost/.test(published), 'no price is invented');
  } finally {
    cleanup([root]);
  }
});

test('a declared provenance that is not a record is refused instead of being reinterpreted', () => {
  const root = tempDir('metrics-c75-bad-');
  try {
    const fx = buildReportFixture(join(root, 'fx'), {
      annotations: (annotations) => {
        annotations.evaluator_provenance = 'the model wrote this';
      },
    });
    const out = join(root, 'out');
    const env = runReport(fx, out);
    assert.equal(env.status, 2, env.stdout);
    assert.equal(env.envelope.code, 'INVALID_ANNOTATIONS');
  } finally {
    cleanup([root]);
  }
});

test('re-rendering the saved bundle needs no evaluator and reproduces every published view', () => {
  const root = tempDir('metrics-c75-render-');
  try {
    const { fx, out, bundle } = runFixture(root);
    const views = renderViews(JSON.parse(JSON.stringify(bundle)));
    assert.equal(views['index.md'], readFileSync(join(out, 'index.md'), 'utf8'));
    assert.equal(views['04-score-justification.md'], readFileSync(join(out, '04-score-justification.md'), 'utf8'));
    // The published bundle and the saved annotations are the same facts: the hash is over the file the run read.
    assert.equal(bundle.provenance.annotations.sha256, sha256(readFileSync(fx.annotationsPath)));
  } finally {
    cleanup([root]);
  }
});
