import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderViews, VIEW_FILES } from '../scripts/lib/render.mjs';
import { INDICATOR_IDS, METRIC_IDS } from '../scripts/lib/registry.mjs';
import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runCli, tempDir } from './helpers.mjs';

/** Build one bundle and return every rendered view. */
function rendered(options = {}) {
  const root = tempDir('metrics-views-');
  const fx = buildReportFixture(root, options);
  const out = join(root, 'out');
  const env = runCli([
    '--input',
    fx.packetDir,
    '--out',
    out,
    '--profile',
    fx.profilePath,
    '--annotations',
    fx.annotationsPath,
    '--corpus',
    fx.corpusPath,
  ]);
  assert.equal(env.status, 0, env.stdout);
  const bundle = readJson(join(out, 'assessment.json'));
  const views = renderViews(bundle);
  return { root, out, bundle, views, files: Object.fromEntries(Object.keys(views).map((name) => [name, readFileSync(join(out, name), 'utf8')])) };
}

test('verified evidence renders its real quote, never a missing marker', () => {
  const { root, bundle, views, files } = rendered();
  const ev1 = bundle.evidence.find((item) => item.id === 'ev1');
  try {
    for (const name of ['04-score-justification.md', '05-detected-issues.md']) {
      assert.ok(files[name].includes('"planetă"'), `${name} must show the real quote`);
      assert.ok(!files[name].includes('(missing)'), `${name} must not report a registered evidence id as missing`);
    }
    assert.ok(files['05-detected-issues.md'].includes('"marea"'), 'the affected passage quote is rendered');
    assert.ok(
      files['04-score-justification.md'].includes(`\`ev1\` \`${ev1.file}\` [${ev1.start},${ev1.end})`),
      'the byte range of the verified evidence is shown',
    );
    // Every published view is the rendered bundle, not a fresh judgement.
    assert.deepEqual(renderViews(JSON.parse(JSON.stringify(bundle))), views);
  } finally {
    cleanup([root]);
  }
});

test('STG compliance reports the general rule set while adherence maps this request and brief', () => {
  const { root, files } = rendered();
  try {
    const stg = files['01-stg-compliance.md'];
    const adherence = files['02-specification-adherence.md'];
    assert.ok(stg.includes('`stg-structure-1`'), 'the general rule set is listed');
    assert.ok(stg.includes('`stg-language-1`'));
    assert.ok(!stg.includes('`req-ending`'), 'this request\'s requirement is not an STG outcome');
    assert.ok(!stg.includes('`ed-tone`'), 'an editorial preference is not an STG outcome');
    assert.ok(stg.includes('Aggregation policy: `all_applicable_pass`'));
    assert.ok(stg.includes('Recorded outcomes: 3/4 expected applicable checks (coverage 0.75)'));
    assert.ok(stg.includes('CAR context'));

    assert.ok(adherence.includes('`req-ending`'), 'the request requirement is reported here');
    assert.ok(adherence.includes('`ed-tone`'), 'the editorial preference is reported here');
    assert.ok(adherence.includes('keep the'), 'the reader request text is shown');
    assert.ok(adherence.includes('Prefer restraint over escalation.'), 'the brief is shown');
    assert.ok(!adherence.includes('`stg-structure-1`'), 'the general rule set stays in its own view');
    assert.ok(adherence.includes('no departure is inferred from it'), 'no deliberate departure is invented');
  } finally {
    cleanup([root]);
  }
});

test('the metric view lists every metric and indicator with status, scope and unit', () => {
  const { root, files, bundle } = rendered();
  try {
    const view = files['03-metrics-and-indicators.md'];
    for (const id of METRIC_IDS) {
      assert.ok(view.includes(`\`${id}\``), `${id} must appear`);
    }
    for (const id of INDICATOR_IDS) {
      assert.ok(view.includes(id), `${id} must appear among the indicators`);
    }
    assert.ok(view.includes('| id | status | value | scope | unit | coverage | missing reason |'));
    assert.ok(view.includes('| `SI` | computed | 0 0-1'), 'a zero renders as a number with its unit');
    assert.ok(
      view.includes('| `AEG` | computed | -20 %'),
      'a negative efficiency gain renders as a real value',
    );
    assert.ok(
      view.includes('| `NQS` | not_assessable | not assessable — NQS is disabled by default'),
      'an unavailable metric renders differently from zero, with its reason',
    );
    assert.ok(view.includes('| `EAP` | judged | trajectory of 2 ordered segments'), 'a trajectory is not shown as a number');
    assert.ok(view.includes('| `CS` | judged | 4 components'), 'a component metric is not shown as a bare number');
    assert.ok(view.includes('kind chapter · chapters 1'), 'the scope of every metric is shown');
    assert.ok(view.includes('## Segments and boundaries'));
    assert.ok(view.includes('disclosure order `seg1` → `seg2` → `arc1`'), 'disclosure order is reported');
    assert.ok(view.includes('story order `seg2` → `seg1` → `arc1`'), 'story chronology is kept apart');
    assert.ok(view.includes('differs: yes'));
    assert.ok(view.includes('## Coverage'));
    assert.ok(view.includes('Context chapters (available to explain a fact, never counted as candidate text): 2'));
    assert.ok(view.includes(`Eligible candidate tokens in the selection: ${bundle.coverage.tokenizer.eligible_tokens}`));
  } finally {
    cleanup([root]);
  }
});

test('the justification view shows components, arithmetic, bounds, coverage and limits', () => {
  const { root, files } = rendered();
  try {
    const view = files['04-score-justification.md'];
    assert.ok(view.includes('`referential_clarity`: rating 3/4'), 'each CS component is shown with its rating');
    assert.ok(view.includes('100 * (3 + 3 + 3 + 3) / (4 * 4) = 75'), 'the component arithmetic is shown');
    assert.ok(view.includes('| segment | disclosure | story | focalization | valence | tension | uncertainty | evidence |'));
    assert.ok(view.includes('| `seg2` | 0 | 0 | marinarul | -1 | 0 |'), 'the trajectory keeps order, focalization and axes');
    assert.ok(view.includes('a quiet aftermath keeps its low intensity'), 'the interpretation limit is stated');
    assert.ok(view.includes('100 * (10 - 12) / 10 = -20'), 'the AEG arithmetic is shown');
    assert.ok(view.includes('server elapsed time and model-wait time are recorded separately'));
    assert.ok(view.includes('the declared measurable population was fully checked'), 'the CR coverage statement is shown');
    assert.ok(view.includes('Value kind: `components`'));
    assert.ok(view.includes('Value kind: `trajectory`'));
    assert.ok(view.includes('- Bounds: —'), 'a metric without bounds says so');
    assert.ok(view.includes('Aggregation weights: —'), 'a disabled aggregate declares no weights');
    assert.ok(view.includes('calibration: none recorded'), 'the missing calibration is visible');
    assert.ok(view.includes('Rubric profile: `rubric-anchors.v1`'), 'the rubric version is recorded');
    assert.ok(view.includes('Registry version `metrics.v1`'));
  } finally {
    cleanup([root]);
  }
});

test('an enabled research profile records its weights, intention and calibration state', () => {
  const { root, files, bundle } = rendered({
    profile: {
      aggregation: {
        enabled: true,
        policy: 'research',
        weights: { cs: 0.4, oi: 0.35, emotional_fit: 0.25 },
        emotional_fit: { procedure: 'separate-judgement', intent: 'a quiet elegiac aftermath' },
        scope: 'chapter 1',
        rubric_version: 'rubric-anchors.v1',
      },
    },
  });
  try {
    // 0.4 * 75 + 0.35 * 50 + 0.25 * 55 = 61.25
    assert.equal(bundle.metrics.NQS.status, 'computed');
    assert.ok(Math.abs(bundle.metrics.NQS.value - 61.25) < 1e-9, String(bundle.metrics.NQS.value));
    assert.equal(bundle.metrics.NQS.qualified, true);
    const view = files['04-score-justification.md'];
    assert.ok(view.includes('Aggregation weights: {"cs":0.4,"oi":0.35,"emotional_fit":0.25}'), view);
    assert.ok(view.includes('emotional-fit procedure: separate-judgement'));
    assert.ok(view.includes('research profile: a weighted experiment'), view);
  } finally {
    cleanup([root]);
  }
});

test('the justification view shows a CR limit as a bounded subset', () => {
  const { root, files, bundle } = rendered({
    annotations: (annotations) => {
      annotations.metrics.CR.training_dataset.access = 'partial_subset';
      annotations.metrics.CR.training_dataset.coverage = 0.5;
      annotations.metrics.CR.training_dataset.checked_items = 10;
      annotations.metrics.CR.training_dataset.matched_items = 0;
      annotations.metrics.CR.training_dataset.evaluation_population = { description: 'twenty held-out probes', items: 20 };
    },
  });
  try {
    const view = files['04-score-justification.md'];
    assert.equal(bundle.metrics.CR.value, 0);
    assert.equal(bundle.metrics.CR.qualified, true);
    assert.ok(view.includes('says nothing about the rest of training'), view);
    assert.ok(view.includes('Qualification: limited or experimental finding'));
  } finally {
    cleanup([root]);
  }
});

test('the issue view prioritizes findings, preserves alternatives and keeps the passages worth retaining', () => {
  const { root, files } = rendered();
  try {
    const view = files['05-detected-issues.md'];
    assert.ok(view.indexOf('find-2') < view.indexOf('find-1'), 'the major finding comes first');
    assert.ok(view.includes('Alternative explanation (preserved): The cause may be in the omitted material.'));
    assert.ok(view.includes('Repair suggestion: Name the cause before the change.'));
    assert.ok(view.includes('## Passages worth retaining'));
    assert.ok(view.includes('`p1`: The opening image is worth keeping.'));
  } finally {
    cleanup([root]);
  }
});

test('supplied text cannot break a table, a code span, a link, HTML or a heading', () => {
  const hostile = 'Add a quiet ending | keep the <script> out; use `code` and [links](x)';
  const { root, files } = rendered({
    annotations: (annotations) => {
      annotations.request = `${hostile}\n# Injected heading`;
      annotations.metrics.CS.dimensions.causal_support.rationale = 'cause <b>bold</b> | pipe `tick`\n# Injected heading';
      annotations.metrics.CS.dimensions.causal_support.evidence = ['ev1'];
      annotations.preserved_qualities.passages[0].rationale = '# Heading at line start | with pipes';
    },
  });
  try {
    const adherence = files['02-specification-adherence.md'];
    const justification = files['04-score-justification.md'];
    const issues = files['05-detected-issues.md'];
    assert.ok(adherence.includes('\\|'), 'a pipe is escaped');
    assert.ok(adherence.includes('\\`code\\`'), 'a backtick is escaped');
    assert.ok(adherence.includes('&lt;script&gt;'), 'raw HTML is escaped');
    assert.ok(adherence.includes('\\[links\\](x)'), 'a link is escaped');
    for (const [name, view] of Object.entries(files)) {
      assert.ok(!view.includes('<script>'), `${name} must not carry raw HTML`);
      assert.ok(!/^# Injected heading$/m.test(view), `${name} must not gain a heading from supplied text`);
    }
    assert.ok(justification.includes('\\# Injected heading'), 'a heading inside supplied text is escaped');
    assert.ok(issues.includes('\\# Heading at line start \\| with pipes'), 'the preserved rationale is escaped');
  } finally {
    cleanup([root]);
  }
});

test('the same saved bundle renders byte-identically and publishes exactly the documented files', () => {
  const root = tempDir('metrics-views-');
  try {
    const fx = buildReportFixture(root);
    const out = join(root, 'out');
    const env = runCli(['--input', fx.packetDir, '--out', out, '--profile', fx.profilePath, '--annotations', fx.annotationsPath, '--corpus', fx.corpusPath]);
    assert.equal(env.status, 0, env.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    const first = renderViews(bundle);
    const second = renderViews(JSON.parse(JSON.stringify(bundle)));
    assert.deepEqual(second, first, 'a re-render adds no judgement and changes no score');
    assert.deepEqual(env.envelope.outputs, ['assessment.json', 'index.md', ...VIEW_FILES]);
    const index = readFileSync(join(out, 'index.md'), 'utf8');
    assert.ok(index.includes('All literary scores are advisory.'));
    assert.ok(index.includes('5. [Detected Issues](05-detected-issues.md)'));
    assert.ok(!index.includes('SI'));
    for (const name of VIEW_FILES) {
      const text = readFileSync(join(out, name), 'utf8');
      assert.ok(text.startsWith(`# ${bundle.book.title} — ${bundle.book.universe_id}`), `${name} carries the book heading`);
      assert.ok(text.includes(bundle.assessment_id), `${name} names the assessment`);
      assert.ok(text.includes(bundle.version), `${name} names the packet version`);
      assert.ok(!text.includes('created_at'), `${name} carries no runtime timestamp`);
    }
  } finally {
    cleanup([root]);
  }
});
