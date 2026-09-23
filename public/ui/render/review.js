/**
 * scriptaWorlds — The review panel: what to review, one button, the last report, and the history.
 *
 * The panel asks the two things a reader can decide — this chapter or the whole book — and keeps
 * everything else out of the way: the phase, the profile and who produces the observations are the
 * host's own settings. Below the button it answers the only other question a reader has: what came out
 * of the last review, and which reports exist. A run that is still going is read in the sessions
 * dialog, which the start opens on its own.
 */
import { cancelRun, chapterTitle, deleteRun, refreshRuns, retryRun, reviewScopeLabel, reviewTarget, startReview } from '../review.js';
import { openReport } from '../report.js';
import { openSessions } from '../sessions.js';
import { RUN_FAILED_STATUSES, RUN_LIVE_STATUSES, dom, elem, el, plural, state } from '../state.js';

export function renderReview() {
  const model = reviewTarget();
  if (!model) return;
  dom['review-title'].textContent = `Review — ${reviewScopeLabel()}`;
  const body = dom['review-body'];
  if (!model.built) {
    body.replaceChildren(reviewForm(model));
    model.built = true;
  }
  syncReviewForm(model);
  const latest = el('review-latest');
  if (latest) latest.replaceChildren(...latestNodes(model));
  const history = el('review-history');
  if (history) history.replaceChildren(...historyNodes());
}

function radioGroup({ name, legend, options, value, onChange }) {
  const fieldset = elem('fieldset', { className: 'analysis__set' }, elem('legend', { text: legend }));
  for (const option of options) {
    const id = `review-${name}-${option.value}`;
    fieldset.append(elem('label', { className: 'analysis__choice', attrs: { for: id } },
      elem('input', {
        attrs: { type: 'radio', name: `review-${name}`, id, value: option.value, ...(option.value === value ? { checked: true } : {}) },
        on: { change: () => onChange(option) }
      }),
      elem('span', { className: 'analysis__choice-body' },
        elem('span', { className: 'analysis__choice-label', text: option.label }),
        option.hint ? elem('span', { className: 'analysis__choice-hint', text: option.hint }) : null
      )
    ));
  }
  return fieldset;
}

function reviewForm(model) {
  const chapter = model.chapter;
  const scopes = [
    {
      value: 'chapter',
      label: chapter != null
        ? `This chapter — ${chapter}${chapterTitle(chapter) ? ` · ${chapterTitle(chapter)}` : ''}`
        : 'This chapter',
      hint: 'The chapter this dialog was opened from.'
    },
    { value: 'book', label: 'The whole book', hint: 'Every accepted chapter, reviewed as one version.' }
  ];
  return elem('form', {
    className: 'analysis__form',
    attrs: { id: 'review-form' },
    on: { submit: (event) => { event.preventDefault(); startReview(); } }
  },
  elem('p', { className: 'analysis__hint', text: 'A review freezes the accepted text into a packet outside the book and reads that copy. It never changes a chapter; the report it publishes is written outside the book too.' }),
  radioGroup({
    name: 'scope',
    legend: 'What to review',
    options: scopes,
    value: model.scope,
    onChange: (option) => { model.scope = option.value; renderReview(); }
  }),
  elem('p', { className: 'analysis__error', attrs: { id: 'review-error', role: 'alert' } }),
  elem('div', { className: 'popup__actions' },
    elem('button', { className: 'btn btn--accent', text: 'Start review', attrs: { type: 'submit', id: 'review-start' } }),
    elem('span', { className: 'analysis__hint', attrs: { id: 'review-scope-note' } })
  ),
  elem('section', { className: 'analysis__runs' },
    elem('h3', { className: 'analysis__subtitle' }, elem('span', { text: 'Latest report' })),
    elem('div', { attrs: { id: 'review-latest' } })
  ),
  elem('section', { className: 'analysis__runs' },
    elem('h3', { className: 'analysis__subtitle' },
      elem('span', { text: 'Earlier reports' }),
      elem('span', { className: 'analysis__count', attrs: { id: 'review-count' } }),
      elem('button', {
        className: 'btn btn--quiet',
        text: 'Refresh',
        attrs: { type: 'button' },
        on: { click: () => reloadRuns() }
      })
    ),
    elem('div', { attrs: { id: 'review-history' } })
  ));
}

function secondsText(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : null;
}

function whenText(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function isReadable(run) {
  return run.status === 'done' && Array.isArray(run.outputs) && run.outputs.length > 0;
}

/** One line of the history: a bold label, the facts, then the state of the run. */
function line(facts, { run = null } = {}) {
  const [label, ...rest] = facts;
  return elem('p', { className: 'analysis__line' },
    elem('strong', { text: label }),
    ...rest.filter(Boolean).map((fact) => elem('span', { text: fact })),
    run ? elem('span', { className: `badge badge--${run.status}`, text: String(run.status).replace(/_/g, ' ') }) : null
  );
}

/** What a reader can do with one run of the history, by the state it is in. */
function actionsFor(run, { primary = false } = {}) {
  const watch = { label: primary ? 'Watch the run' : 'Console', quiet: !primary, onClick: () => openSessions({ run: run.run_id }) };
  if (RUN_LIVE_STATUSES.has(run.status)) {
    return [watch, { label: 'Cancel', quiet: true, onClick: () => { cancelRun(run.run_id); } }];
  }
  if (isReadable(run)) {
    return [{ label: primary ? 'Open the report' : 'Report', onClick: () => openReport({ runId: run.run_id }) }, watch];
  }
  if (RUN_FAILED_STATUSES.has(run.status) || run.status === 'interrupted') {
    return [{ label: 'Retry', onClick: () => { retryRun(run.run_id); } }, watch];
  }
  return [watch];
}

/** What came out of the last review: the report it published, the run still going, or nothing yet. */
function latestNodes(model) {
  if (state.runs.length === 0) {
    return [elem('p', { className: 'analysis__hint', text: 'No review of this book yet. Pick a scope and press Start review.' })];
  }
  const run = state.runs[0];
  const nodes = [line([`${run.phase === 'continuity' ? 'Continuity' : 'Metrics'} review`, scopeOf(run), whenText(run.created_at)], { run })];
  if (RUN_LIVE_STATUSES.has(run.status)) {
    nodes.push(elem('p', { className: 'analysis__hint', text: `Running now${run.started_at ? ` since ${whenText(run.started_at)}` : ''}. The run is read in ALA sessions.` }));
  } else if (isReadable(run)) {
    nodes.push(elem('p', { className: 'analysis__hint', text: `Published ${plural(run.outputs.length, 'file', 'files')}${secondsText(run.duration_ms) ? ` in ${secondsText(run.duration_ms)}` : ''}.` }));
  } else {
    nodes.push(elem('p', { className: 'analysis__hint', text: `This run published nothing${run.error ? `: ${run.error}` : '.'}` }));
  }
  nodes.push(actionsRow(actionsFor(run, { primary: true })));
  return nodes;
}

/**
 * The reports this book has published before the newest one, newest first, each a link that opens it: the
 * date it ran, its phase and the scope it covered, and one control that removes it for good. Runs that
 * published nothing — cancelled, failed, interrupted — are not reports and are not listed here; the newest
 * run of any state stays in the panel above, with the actions its state allows.
 */
function historyNodes() {
  const latest = state.runs[0] ?? null;
  const runs = state.runs.filter((run) => isReadable(run) && run.run_id !== latest?.run_id);
  if (runs.length === 0) {
    return [elem('p', { className: 'analysis__hint', text: 'No earlier report of this book.' })];
  }
  return runs.map((run) => {
    const label = `${whenText(run.created_at)} · ${run.phase === 'continuity' ? 'continuity' : 'metrics'} review · ${scopeOf(run)}`;
    const confirming = state.review?.confirms === run.run_id;
    return elem('div', { className: 'analysis__runline' },
      elem('a', {
        className: 'analysis__report-link',
        text: label,
        attrs: { href: '#', title: 'Open this report', 'aria-label': `Open the report of ${label}` },
        on: { click: (event) => { event.preventDefault(); openReport({ runId: run.run_id }); } }
      }),
      confirming
        ? actionsRow([
          {
            label: 'Delete it',
            onClick: () => { state.review.confirms = null; deleteRun(run.run_id); }
          },
          { label: 'Keep it', quiet: true, onClick: () => { state.review.confirms = null; renderReview(); } }
        ])
        : actionsRow([
          {
            label: 'Delete',
            quiet: true,
            onClick: () => { state.review.confirms = run.run_id; renderReview(); }
          }
        ])
    );
  });
}

function actionsRow(actions) {
  return elem('div', { className: 'popup__actions' }, ...actions.map((action) => elem('button', {
    className: action.quiet ? 'btn btn--quiet' : 'btn',
    text: action.label,
    attrs: { type: 'button' },
    on: { click: action.onClick }
  })));
}

function scopeOf(run) {
  const scope = run.requested_scope ?? run.scope;
  if (!scope) return '—';
  if (scope.kind === 'book') return 'the whole book';
  const chapters = Array.isArray(scope.chapters) ? scope.chapters : [];
  if (chapters.length === 0) return String(scope.kind);
  if (chapters.length > 3) return `chapters ${chapters[0]}–${chapters[chapters.length - 1]}`;
  return `chapter ${chapters.join(', ')}`;
}

function syncReviewForm(model) {
  const error = el('review-error');
  if (error) {
    error.textContent = model.error ?? '';
    error.hidden = !model.error;
  }
  const start = el('review-start');
  if (start) {
    start.disabled = model.busy || !state.universeId;
    start.textContent = model.busy ? 'Starting…' : 'Start review';
  }
  const note = el('review-scope-note');
  if (note) note.textContent = model.busy ? 'the host is freezing the packet' : `covering ${reviewScopeLabel()}`;
  const count = el('review-count');
  if (count) {
    const latest = state.runs[0] ?? null;
    const reports = state.runs.filter((run) => isReadable(run) && run.run_id !== latest?.run_id).length;
    count.textContent = reports > 0 ? plural(reports, 'earlier report', 'earlier reports') : '';
  }
}

/** Re-read the list without touching the form. */
export function reloadRuns() {
  refreshRuns({ force: true }).catch(() => {});
}
