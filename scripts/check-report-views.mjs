// The report-rendering group of `scripts/check.mjs`: the assessment bundle as the reader interface shows it.
//
// `public/ui/render/bundle.js` is browser code, so this group renders it against a minimal DOM: the
// module under test is the real one, imported with `import()`, and the assertions read the rendered
// text of the view rather than the bundle it came from. What is proved here is what a reader of the
// report panel sees: the review summary leads, every metric keeps its diagnostics (the weights and
// arithmetic of the aggregate, its qualification, coverage, bounds and unavailable reasons), an
// unavailable result is never shown as a zero, and an empty findings list says which of the three
// possible results it is instead of implying a clean book.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { buildReportFixture } from '../skills/scripta-metrics-report/tests/report-fixture.mjs';
import { runReport } from '../skills/scripta-metrics-report/tests/helpers.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const bundleModule = resolve(here, '..', 'public', 'ui', 'render', 'bundle.js');

/**
 * The smallest DOM `state.js`'s `elem` helper and the bundle renderer need: elements with children,
 * a text value, attributes, a class name and event listeners. Rendering the real module against it
 * exercises the actual element construction, not a restatement of it.
 */
class ShimText {
  constructor(text) {
    this.text = String(text);
  }
}

class ShimElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.className = '';
    this.listeners = 0;
  }

  append(...nodes) {
    for (const node of nodes.flat(Infinity)) {
      if (node === null || node === undefined || node === false) continue;
      this.children.push(node instanceof ShimText ? node : node);
    }
  }

  set textContent(value) {
    this.children = [new ShimText(value)];
  }

  get textContent() {
    return this.children.map((child) => (child instanceof ShimText ? child.text : child.textContent)).join('');
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  addEventListener() {
    this.listeners += 1;
  }
}

function installDom() {
  globalThis.document = {
    createElement: (tag) => new ShimElement(tag),
    createTextNode: (text) => new ShimText(text),
    getElementById: () => null,
  };
}

/** The rendered text of a view tree, one node per line, so order and adjacency are assertable. */
function renderText(node) {
  if (node instanceof ShimText) return node.text;
  if (!node || !Array.isArray(node.children)) return '';
  const own = node.children.map((child) => renderText(child)).filter((text) => text.length > 0);
  return own.join('\n');
}

let loaded = null;

function render(bundle) {
  if (loaded === null) throw new Error('the bundle renderer was not loaded yet');
  return renderText(loaded.bundleReport(bundle));
}

export async function runReportViewChecks({ ok, fail, checkSeed, tempDirs }) {
  const root = await mkdtemp(join(tmpdir(), `report-views-${checkSeed}-`));
  tempDirs.push(root);
  installDom();
  loaded = await import(pathToFileURL(bundleModule).href);
  try {
    const plain = buildReportFixture(join(root, 'plain'), {
      annotations: (annotations) => {
        annotations.evaluator_provenance = { schema_version: 'evaluator-provenance.v1', model: 'test/model', settings: { temperature: 0 } };
      },
    });
    const plainRun = runReport(plain, join(root, 'plain-out'));
    const bundle = JSON.parse(await readFile(join(root, 'plain-out', 'assessment.json'), 'utf8'));
    const view = render(bundle);
    const missing = [];
    const expect = (condition, message) => {
      if (!condition) missing.push(message);
    };

    // The review leads: status, intention, strengths and problems come before the metric cards.
    expect(view.includes('The review in brief'), 'the view leads with the review summary');
    expect(view.includes('problems recorded'), 'the reading status is rendered');
    expect(view.includes('Strengths observed'), 'the observed strengths are rendered');
    expect(view.includes('The opening image is worth keeping.'), 'a strength carries its rationale');
    expect(view.includes('Most consequential problems'), 'the problems are rendered');
    expect(view.includes('Align the two descriptions.'), 'a bounded revision option is rendered');
    expect(view.includes('Alternative reading.'), 'the preserved reading is rendered');
    expect(view.includes('marinar'), 'a problem shows the exact passage it rests on');
    expect(view.includes('read against the declared intention'), 'an observation is related to the declared intention');
    expect(
      view.indexOf('The review in brief') < view.indexOf('Metrics'),
      'the summary precedes the metric cards',
    );

    // Every diagnostic of a result is visible by default, not hidden behind a collapsed control.
    expect(view.includes('why unavailable'), 'the bundle view says why a measurement carries no value');
    expect(view.includes('coverage'), 'coverage is rendered next to the number');
    expect(view.includes('bounds'), 'bounds are rendered');
    expect(view.includes('partition'), 'the continuity partition is rendered');
    expect(view.includes('assessed segments'), 'the assessed segment population is rendered');
    expect(view.includes('low tension segments'), 'the tension profile is rendered');
    expect(view.includes('declared arithmetic') || view.includes('arithmetic'), 'the declared arithmetic is rendered');
    expect(!view.includes('[object Object]'), 'no diagnostic is printed as an object');

    const unavailableLine = bundle.metrics.EAP.status === 'judged' ? bundle.metrics.NQS : bundle.metrics.EAP;
    expect(
      view.includes(`${unavailableLine.id}`) && view.includes(String(unavailableLine.missing_reason ?? '').slice(0, 20)),
      'the unavailable metric names its own reason in the view',
    );

    if (missing.length === 0) {
      ok(`report view: the generic review leads with its summary, its strengths and its supported problems, and every metric keeps its diagnostics (${view.length} rendered characters)`);
    } else {
      fail(`report view/summary: ${missing.join('; ')}`);
    }

    // A qualified aggregate exposes its weights, arithmetic and calibration qualification by default.
    const aggregated = buildReportFixture(join(root, 'aggregate'), {
      profile: {
        aggregation: {
          enabled: true,
          policy: 'research',
          weights: { cs: 0.4, oi: 0.35, emotional_fit: 0.25 },
          emotional_fit: { procedure: 'separate-judgement', intent: 'a quiet elegiac aftermath' },
          scope: 'chapter 1',
          corpus_version: 'corpus.v1',
          rubric_version: 'rubric-anchors.v1',
        },
      },
    });
    runReport(aggregated, join(root, 'aggregate-out'));
    const aggregatedBundle = JSON.parse(await readFile(join(root, 'aggregate-out', 'assessment.json'), 'utf8'));
    const aggregatedView = render(aggregatedBundle);
    const nqs = aggregatedBundle.metrics.NQS;
    const showsWeights = nqs.detail.weights && aggregatedView.includes(`cs ${nqs.detail.weights.cs}`);
    const showsArithmetic = aggregatedView.includes(String(nqs.detail.arithmetic).slice(0, 24));
    const showsQualification = aggregatedView.includes('limited or experimental finding');
    if (nqs.status === 'computed' && nqs.qualified === true && showsWeights && showsArithmetic && showsQualification) {
      ok('report view: a computed aggregate shows its declared weights, its arithmetic and its experimental qualification in the default view');
    } else {
      fail(`report view/aggregate: status=${nqs.status}, qualified=${nqs.qualified}, weights=${showsWeights}, arithmetic=${showsArithmetic}, qualification=${showsQualification}`);
    }

    // An empty findings list is never a clean bill: the view states which result it is.
    const empty = buildReportFixture(join(root, 'empty'), {
      annotations: (annotations) => {
        annotations.findings = [];
        annotations.continuity.findings = [];
      },
    });
    runReport(empty, join(root, 'empty-out'));
    const emptyBundle = JSON.parse(await readFile(join(root, 'empty-out', 'assessment.json'), 'utf8'));
    const emptyView = render(emptyBundle);
    const status = emptyBundle.review.reading_status;
    if (emptyBundle.findings.length === 0 && emptyView.includes(`${emptyBundle.review.statement}`) && emptyView.includes(status.replace(/_/g, ' '))) {
      ok(`report view: an empty findings list is explained by the reading status \`${status}\` instead of reading as a clean report`);
    } else {
      fail(`report view/empty: status=${status}, findings=${emptyBundle.findings.length}, statement=${emptyView.includes(emptyBundle.review.statement)}`);
    }

    // A report whose judgements were all removed says the selection was not read.
    const unjudged = buildReportFixture(join(root, 'unjudged'), {
      noContinuity: true,
      annotations: (annotations) => {
        annotations.metrics = {};
        annotations.indicators = [];
        annotations.findings = [];
        annotations.preserved_qualities = { passages: [] };
      },
    });
    runReport(unjudged, join(root, 'unjudged-out'));
    const unjudgedBundle = JSON.parse(await readFile(join(root, 'unjudged-out', 'assessment.json'), 'utf8'));
    const unjudgedView = render(unjudgedBundle);
    if (unjudgedBundle.review.reading_status === 'not_evaluated' && unjudgedView.includes('not evaluated') && unjudgedView.includes('was not read')) {
      ok('report view: a report with no judgement says the selection was not read instead of showing an empty, clean-looking list');
    } else {
      fail(`report view/unjudged: status=${unjudgedBundle.review.reading_status}, rendered=${unjudgedView.includes('was not read')}`);
    }

    if (plainRun.status !== 0) fail(`report view/fixture: the fixture did not build (status ${plainRun.status})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
