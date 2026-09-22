/**
 * scriptaWorlds — The report surface: one review run and everything it published.
 *
 * A run is a frozen packet plus the files a phase wrote about it. The interface reads the run record
 * for the version, the scope, the trigger, the profile source and the annotation mode, reads
 * `assessment.json` for the measurements and the findings, and renders every other published file from
 * its own bytes, so a view is never re-derived here.
 */
import { loadAssessmentRun, loadReportFile, reportFileUrl } from './api.js';
import { newestReadableRun, refreshRuns, upsertRun } from './review.js';
import { openPanel, renderPanels } from './overlays.js';
import { dom, state } from './state.js';

const VIEW_LABELS = {
  'assessment.json': 'Bundle',
  'index.md': 'Index',
  '01-stg-compliance.md': '1 · STG compliance',
  '02-specification-adherence.md': '2 · Specification adherence',
  '03-metrics-and-indicators.md': '3 · Metrics and indicators',
  '04-score-justification.md': '4 · Score justification',
  '05-detected-issues.md': '5 · Detected issues',
  'continuity-result.json': 'Continuity result'
};

export function reportTarget() {
  return state.report;
}

export function viewLabel(name) {
  return VIEW_LABELS[name] ?? name;
}

/**
 * The published files of one run in reading order: the bundle first, then the index, then the views the
 * index links. Everything the run published is listed, so nothing it wrote is unreachable.
 */
export function reportViews(run) {
  const outputs = Array.isArray(run?.outputs) ? run.outputs : [];
  const bundles = outputs.filter((name) => name.endsWith('.json'));
  const index = outputs.filter((name) => name === 'index.md');
  const rest = outputs.filter((name) => name.endsWith('.md') && name !== 'index.md').sort();
  const other = outputs.filter((name) => !name.endsWith('.json') && !name.endsWith('.md'));
  return [...bundles, ...index, ...rest, ...other];
}

export function defaultView(run) {
  const views = reportViews(run);
  if (views.includes('assessment.json')) return 'assessment.json';
  if (views.includes('index.md')) return 'index.md';
  return views[0] ?? null;
}

/** Open the report panel on one run, or on the newest run that published something to read. */
export async function openReport({ runId = null } = {}) {
  const wanted = runId ?? state.report?.runId ?? null;
  openPanel('report');
  dom['report-close'].focus();
  if (!state.runsLoaded) await refreshRuns({ force: true }).catch(() => {});
  const chosen = (wanted && state.runs.some((run) => run.run_id === wanted) ? wanted : null)
    ?? newestReadableRun()?.run_id
    ?? null;
  if (!chosen) {
    state.report = { runId: null, run: null, bundle: null, view: null, content: null, loading: false, error: null, rev: 1, renderedRev: null, renderedRun: null };
    renderPanels();
    return;
  }
  await selectRun(chosen);
}

/** Read one run and its default view. */
export async function selectRun(runId) {
  if (!runId) return;
  const previous = state.report;
  state.report = {
    runId,
    run: state.runs.find((run) => run.run_id === runId) ?? previous?.run ?? null,
    bundle: null,
    view: null,
    content: null,
    loading: true,
    error: null,
    rev: 1,
    renderedRev: null,
    renderedRun: null
  };
  renderPanels();
  try {
    const run = await loadAssessmentRun(runId);
    if (state.report?.runId !== runId) return;
    if (!run) throw new Error(`The run ${runId} is no longer listed.`);
    upsertRun(run);
    state.report.run = run;
    const views = reportViews(run);
    if (views.includes('assessment.json')) {
      state.report.bundle = (await readView(runId, 'assessment.json')).value;
    }
    const view = defaultView(run);
    state.report.view = view;
    if (view && view !== 'assessment.json') state.report.content = await readView(runId, view);
    state.report.loading = false;
  } catch (error) {
    if (state.report?.runId !== runId) return;
    state.report.error = error.message;
    state.report.loading = false;
  }
  bump(state.report);
  renderPanels();
}

/** Switch to one published file of the open run. */
export async function selectView(name) {
  const model = state.report;
  if (!model?.runId || !name || model.view === name) return;
  model.view = name;
  model.content = null;
  model.error = null;
  model.loading = name !== 'assessment.json' || !model.bundle;
  bump(model);
  if (!model.loading) {
    renderPanels();
    return;
  }
  renderPanels();
  try {
    const content = await readView(model.runId, name);
    if (state.report !== model || model.view !== name) return;
    model.content = content;
    if (name === 'assessment.json') model.bundle = content.value;
    model.loading = false;
  } catch (error) {
    if (state.report !== model || model.view !== name) return;
    model.error = error.message;
    model.loading = false;
  }
  bump(model);
  renderPanels();
}

/** The view pane is repainted only when what it shows has actually changed. */
function bump(model) {
  if (model) model.rev = (model.rev ?? 0) + 1;
}

async function readView(runId, name) {
  if (name.endsWith('.json')) {
    return { kind: 'json', value: await loadReportFile(runId, name, { text: false }) };
  }
  return { kind: 'markdown', text: await loadReportFile(runId, name, { text: true }) };
}

/** The address of one published file: what a link inside a rendered view resolves to. */
export function reportFileHref(name) {
  if (!state.report?.runId) return null;
  return reportFileUrl(state.report.runId, name);
}
