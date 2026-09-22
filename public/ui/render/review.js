/**
 * scriptaWorlds — The review panel: what to run, what to cover, and the runs of this book as they move.
 *
 * The form is built once per opening and its controls write straight into `state.review`, so a refresh
 * of the run list never discards a half-made choice. The run list below it follows the run this client
 * started, and every run of the book the host still lists.
 */
import { acceptedChapterNumbers, cancelRun, chapterTitle, refreshRuns, retryRun, reviewScopeLabel, reviewTarget, startReview } from '../review.js';
import { iconButton } from '../icons.js';
import { openReport } from '../report.js';
import { runRow } from './runs.js';
import { REVIEW_MODES, REVIEW_PHASES, RUN_FAILED_STATUSES, RUN_LIVE_STATUSES, dom, el, elem, state } from '../state.js';

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
  const list = el('review-runs');
  if (list) list.replaceChildren(...runRows(model));
  const count = el('review-count');
  if (count) count.textContent = state.runs.length ? `${state.runs.length} in this book` : '';
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

function chapterSelect(id, numbers, value, onChange) {
  return elem('select', {
    className: 'analysis__select',
    attrs: { id },
    on: { change: (event) => onChange(Number(event.currentTarget.value)) }
  }, ...numbers.map((number) => elem('option', {
    attrs: { value: String(number), ...(number === value ? { selected: true } : {}) },
    text: chapterTitle(number) ? `${number} · ${chapterTitle(number)}` : String(number)
  })));
}

function reviewForm(model) {
  const numbers = acceptedChapterNumbers();
  const phases = REVIEW_PHASES.map((phase) => ({ ...phase }));
  const scopes = [
    {
      value: 'chapter',
      label: model.chapter != null ? `This chapter — ${model.chapter}${chapterTitle(model.chapter) ? ` · ${chapterTitle(model.chapter)}` : ''}` : 'This chapter',
      hint: 'The chapter whose toolbar opened this panel.'
    },
    { value: 'arc', label: 'An arc — a run of chapters', hint: 'A contiguous stretch of the accepted chapters.' },
    { value: 'book', label: 'The whole book', hint: 'Every accepted chapter, reviewed as one version.' }
  ];
  const form = elem('form', {
    className: 'analysis__form',
    attrs: { id: 'review-form' },
    on: { submit: (event) => { event.preventDefault(); startReview(); } }
  },
  elem('p', { className: 'analysis__hint', text: 'A review freezes the accepted version into a packet outside the book and reads that copy. It never changes a chapter, and it spends the evaluator only when the observations below ask for it.' }),
  radioGroup({
    name: 'phase',
    legend: 'What to run',
    options: phases,
    value: model.phase,
    onChange: (option) => { model.phase = option.value; renderReview(); }
  }),
  radioGroup({
    name: 'scope',
    legend: 'What to cover',
    options: scopes,
    value: model.scope,
    onChange: (option) => { model.scope = option.value; renderReview(); }
  }),
  elem('div', { className: 'analysis__arc', attrs: { id: 'review-arc' } },
    elem('label', { className: 'analysis__inline', attrs: { for: 'review-from' } },
      elem('span', { text: 'from' }),
      numbers.length ? chapterSelect('review-from', numbers, model.from, (value) => { model.from = value; renderReview(); }) : elem('span', { text: '—' })
    ),
    elem('label', { className: 'analysis__inline', attrs: { for: 'review-to' } },
      elem('span', { text: 'to' }),
      numbers.length ? chapterSelect('review-to', numbers, model.to, (value) => { model.to = value; renderReview(); }) : elem('span', { text: '—' })
    )
  ),
  elem('fieldset', { className: 'analysis__set' },
    elem('legend', { text: 'Who produces the observations' }),
    elem('select', {
      className: 'analysis__select',
      attrs: { id: 'review-mode', 'aria-label': 'Who produces the observations' },
      on: { change: (event) => { model.mode = event.currentTarget.value; renderReview(); } }
    }, ...REVIEW_MODES.map((mode) => elem('option', {
      attrs: { value: mode.value, ...(mode.value === model.mode ? { selected: true } : {}) },
      text: mode.label
    }))),
    elem('p', { className: 'analysis__hint', attrs: { id: 'review-mode-hint' } })
  ),
  elem('fieldset', { className: 'analysis__set' },
    elem('legend', { text: 'Aggregate (optional)' }),
    elem('label', { className: 'analysis__choice', attrs: { for: 'review-aggregate' } },
      elem('input', {
        attrs: { type: 'checkbox', id: 'review-aggregate', ...(model.aggregate ? { checked: true } : {}) },
        on: { change: (event) => { model.aggregate = event.currentTarget.checked; renderReview(); } }
      }),
      elem('span', { className: 'analysis__choice-body' },
        elem('span', { className: 'analysis__choice-label', text: 'Combine the components into one score' }),
        elem('span', { className: 'analysis__choice-hint', text: 'Off by default: a single number hides its components. When it is on it is published as an advisory research result, not as a calibrated one.' })
      )
    ),
    elem('label', { className: 'field', attrs: { for: 'review-intention' } },
      elem('span', { className: 'field__label', text: 'Intention the emotional component is compared against' }),
      elem('input', {
        className: 'analysis__input',
        attrs: { id: 'review-intention', type: 'text', placeholder: 'What should this book make the reader feel?', ...(model.intention ? { value: model.intention } : {}) },
        on: { input: (event) => { model.intention = event.currentTarget.value; } }
      })
    )
  ),
  elem('p', { className: 'analysis__error', attrs: { id: 'review-error', role: 'alert' } }),
  elem('div', { className: 'popup__actions' },
    elem('button', { className: 'btn btn--accent', text: 'Start the review', attrs: { type: 'submit', id: 'review-start' } }),
    elem('span', { className: 'analysis__hint', attrs: { id: 'review-scope-note' } })
  ),
  elem('section', { className: 'analysis__runs' },
    elem('h3', { className: 'analysis__subtitle' },
      elem('span', { text: 'Runs of this book' }),
      elem('span', { className: 'analysis__count', attrs: { id: 'review-count' } }),
      iconButton({ name: 'report', label: 'Refresh the run list', className: 'iconbtn iconbtn--small', on: { click: () => reloadRuns() } })
    ),
    elem('p', { className: 'analysis__hint', text: 'Queued and running reviews are read from the host while they work; the list also follows the turn stream, so a finished chapter shows up without asking again.' }),
    elem('ul', { className: 'runlist', attrs: { id: 'review-runs' } })
  ));
  return form;
}

function syncReviewForm(model) {
  const arc = el('review-arc');
  if (arc) arc.hidden = model.scope !== 'arc';
  const intention = el('review-intention');
  if (intention) {
    intention.disabled = !model.aggregate;
    if (intention.value !== (model.intention ?? '')) intention.value = model.intention ?? '';
  }
  const hint = el('review-mode-hint');
  if (hint) hint.textContent = REVIEW_MODES.find((mode) => mode.value === model.mode)?.hint ?? '';
  const error = el('review-error');
  if (error) {
    error.textContent = model.error ?? '';
    error.hidden = !model.error;
  }
  const start = el('review-start');
  if (start) {
    start.disabled = model.busy || !state.universeId;
    start.textContent = model.busy ? 'Starting…' : 'Start the review';
  }
  const note = el('review-scope-note');
  if (note) note.textContent = model.busy ? 'the host is freezing the packet' : `covering ${reviewScopeLabel()}`;
}

function runRows(model) {
  if (!state.runs.length) {
    return [elem('li', { className: 'runlist__empty', text: 'No review of this book yet.' })];
  }
  return state.runs.map((run) => runRow(run, {
    current: run.run_id === model.active,
    onOpen: (entry) => openReport({ runId: entry.run_id }),
    actions: RUN_LIVE_STATUSES.has(run.status)
      ? [{ label: 'Cancel', onClick: () => { cancelRun(run.run_id); } }]
      : (RUN_FAILED_STATUSES.has(run.status) ? [{ label: 'Retry', onClick: () => { retryRun(run.run_id); } }] : [])
  }));
}

/** Re-read the list without touching the form: the "Runs" heading offers it for a manual refresh. */
export function reloadRuns() {
  refreshRuns({ force: true }).catch(() => {});
}
