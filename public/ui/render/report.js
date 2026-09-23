/**
 * scriptaWorlds — The report panel: the runs of one book and everything one run published.
 *
 * The head of a run (its frozen version, scope, trigger, profile source and annotation mode), its view
 * strip and the view itself are three separate containers: switching a view repaints only the view, so
 * the control the reader activated stays where it was, and a run list that refreshes itself never
 * disturbs what someone is reading.
 */
import { renderMarkdown } from '../../markdown.js';
import { reportFileHref, reportTarget, reportViews, selectView, viewLabel } from '../report.js';
import { bundleReport, jsonView, statusWords } from './bundle.js';
import { historicalBadge, scopeText, stamp, statusBadge, triggerLabel } from './runs.js';
import { dom, elem } from '../state.js';

export function renderReport() {
  const model = reportTarget();
  const body = dom['report-body'];
  dom['report-title'].textContent = 'Reports';
  if (!model) {
    body.replaceChildren(elem('p', { className: 'analysis__hint', text: 'No review was opened yet. Start one from the review control in a chapter toolbar.' }));
    return;
  }
  if (!model.built) {
    body.replaceChildren(
      elem('section', { className: 'report__run', attrs: { id: 'report-run' } },
        elem('div', { attrs: { id: 'report-head' } }),
        elem('div', { attrs: { id: 'report-views' } }),
        elem('div', { className: 'report__view', attrs: { id: 'report-view', tabindex: '-1' } })
      )
    );
    model.built = true;
  }
  const head = document.getElementById('report-head');
  const views = document.getElementById('report-views');
  if (head && views && model.renderedRun !== model.runId) {
    head.replaceChildren(...runHead(model));
    views.replaceChildren(...viewStrip(model));
    model.renderedRun = model.runId;
    model.renderedRev = null;
  }
  for (const button of views?.querySelectorAll('[data-view]') ?? []) {
    button.setAttribute('aria-current', button.dataset.view === model.view ? 'true' : 'false');
  }
  const raw = document.getElementById('report-raw');
  if (raw && model.view) raw.setAttribute('href', reportFileHref(model.view) ?? '#');
  const view = document.getElementById('report-view');
  if (view && model.renderedRev !== model.rev) {
    view.replaceChildren(...viewBody(model));
    model.renderedRev = model.rev;
  }
}

/* ------------------------------------------------------------------ head */

function runHead(model) {
  const run = model.run;
  if (!run) {
    return [elem('p', { className: 'analysis__hint', text: model.loading ? 'Reading the run…' : 'This run is no longer listed.' })];
  }
  const nodes = [
    elem('h3', { className: 'report__run-title' },
      elem('span', { text: `${statusWords(run.phase)} review` }),
      elem('span', { className: 'report__run-book', text: scopeText(run.requested_scope ?? run.scope) })
    ),
    elem('p', { className: 'report__run-when' },
      elem('strong', { text: 'Finished ' }),
      document.createTextNode(stamp(run.finished_at ?? run.created_at) || '—'),
      document.createTextNode(' · '),
      statusBadge(run.status),
      run.historical ? historicalBadge() : null
    )
  ];
  if (run.historical) {
    // A historical report was written against a version the book has since left. Its quotations are the
    // frozen passages of that version, so nothing here is applied to the current prose.
    nodes.push(elem('p', { className: 'report__historical', attrs: { role: 'status' } },
      elem('strong', { text: 'Historical. ' }),
      document.createTextNode('A later accepted version exists, so this report describes an earlier book. Every quotation below is the frozen text of the reviewed version, opened from the bundle rather than read from the current chapters.')
    ));
  }
  const rows = [
    ['Frozen version', run.version ?? '—'],
    ['Scope', scopeText(run.requested_scope ?? run.scope)],
    ['Trigger', triggerLabel(run)],
    ['Profile source', run.profile_source ?? '—'],
    ['Annotation mode', run.annotation_mode ?? '—'],
    ['Observations', run.annotation_model ? `asked of ${run.annotation_model}` : 'none requested'],
    ['Packet', run.packet_intact === false ? 'not intact' : 'intact'],
    ['Created', stamp(run.created_at) || '—'],
    ['Finished', stamp(run.finished_at) || 'not finished']
  ];
  const list = elem('dl', { className: 'meta__list meta__list--run' });
  for (const [label, value] of rows) list.append(elem('dt', { text: label }), elem('dd', { text: String(value) }));
  // Everything a reader does not need to read the report stays one click away.
  nodes.push(elem('details', { className: 'report__details' },
    elem('summary', { text: 'Technical details of this run' }),
    list
  ));
  if (run.status !== 'done') {
    nodes.push(elem('p', { className: 'analysis__error', attrs: { role: 'status' }, text: run.error ?? `This run is ${statusWords(run.status)}.` }));
  }
  const output = String(run.log?.stdout ?? '').trim();
  const failure = String(run.log?.stderr ?? '').trim();
  if (output || failure) {
    nodes.push(elem('details', { className: 'report__log' },
      elem('summary', { text: 'What the phase printed' }),
      failure ? elem('pre', { className: 'runrow__pre', text: failure.slice(-6000) }) : null,
      output ? elem('pre', { className: 'runrow__pre', text: output.slice(-6000) }) : null
    ));
  }
  return nodes;
}

function viewStrip(model) {
  const strip = elem('nav', { className: 'views', attrs: { id: 'report-viewstrip', 'aria-label': 'Published views of this run' } });
  const views = reportViews(model.run);
  if (!views.length) {
    strip.append(elem('p', { className: 'analysis__hint', text: 'This run published no file.' }));
    return [strip];
  }
  for (const name of views) {
    strip.append(elem('button', {
      className: 'viewbtn',
      text: viewLabel(name),
      attrs: { type: 'button', 'data-view': name, title: name, 'aria-current': name === model.view ? 'true' : 'false' },
      on: { click: () => { selectView(name); } }
    }));
  }
  const raw = reportFileHref(model.view ?? views[0]);
  if (raw) {
    strip.append(elem('a', {
      className: 'viewlink',
      text: 'The published file itself',
      attrs: { id: 'report-raw', href: raw, target: '_blank', rel: 'noopener noreferrer' }
    }));
  }
  return [strip];
}

/* ------------------------------------------------------------------ view */

function viewBody(model) {
  if (model.error) return [elem('p', { className: 'analysis__error', attrs: { role: 'alert' }, text: model.error })];
  if (!reportViews(model.run).length) {
    return [elem('p', { className: 'analysis__hint', text: 'This run published no file: it did not reach the phase that writes the report.' })];
  }
  if (model.loading) return [elem('p', { className: 'analysis__hint', text: 'Reading the published file…' })];
  if (!model.view) return [elem('p', { className: 'analysis__hint', text: 'Choose a view above.' })];
  if (model.view === 'assessment.json' && model.bundle) {
    return [elem('h4', { className: 'bundle__title', text: 'Assessment bundle' }), bundleReport(model.bundle)];
  }
  const content = model.content;
  if (!content) return [elem('p', { className: 'analysis__hint', text: 'Choose a view above.' })];
  if (content.kind === 'json') {
    return [elem('section', { className: 'report__json' }, elem('h4', { className: 'bundle__title', text: viewLabel(model.view) }), jsonView(content.value))];
  }
  const doc = renderMarkdown(String(content.text ?? ''), { className: 'analysis__doc' });
  linkViews(doc, model);
  return [doc];
}

/**
 * A view is Markdown that links its siblings by file name (`01-stg-compliance.md`). Those links open the
 * sibling in this panel and keep the address of the published file for a new tab or a download; a link
 * to anything else is left alone.
 */
function linkViews(node, model) {
  const known = reportViews(model.run);
  for (const link of node.querySelectorAll('a[href]')) {
    const name = String(link.getAttribute('href') ?? '').replace(/^\.\//, '');
    if (known.includes(name)) {
      link.setAttribute('href', reportFileHref(name) ?? '#');
      link.addEventListener('click', (event) => {
        event.preventDefault();
        selectView(name);
      });
      continue;
    }
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
}
