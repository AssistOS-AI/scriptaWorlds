/**
 * scriptaWorlds — The team's pane: every response a book holds, as its own reader gave it.
 *
 * This is the reading half of the feedback panel. A response is one card: who gave it and of what kind,
 * when, against which frozen copy, what that reader answered (a skipped question says so), what they
 * wrote and which passage of the frozen copy they quoted, and in which state the response stands —
 * withdrawn, historical, or as given. Nothing is added up: no total, no average, no score. The
 * questionnaire a reader answers is the other half, in `./feedback.js`.
 */
import { iconButton } from '../icons.js';
import { showFeedback } from '../feedback.js';
import {
  cancelConfirm,
  confirmWithdraw,
  correctResponse,
  refreshFeedback,
  withdrawResponse
} from '../responses.js';
import { elem, plural, state } from '../state.js';
import { historicalBadge, scopeText, stamp, versionText } from './runs.js';

export function teamPane(model) {
  const pane = elem('div', { className: 'feedback__team' },
    viewStrip(model),
    elem('p', { className: 'analysis__hint', text: 'Every response of this book is listed as its own reader gave it, newest first. Nothing here is added up: the answers of different readers are never combined into a score, and a response a model or a fixture gave is marked as not a reader\'s.' }),
    elem('p', { className: 'feedback__counts', attrs: { id: 'feedback-counts' }, text: countsWords() })
  );
  if (!model.reader) {
    pane.append(elem('p', { className: 'analysis__hint', text: 'Type your name in the questionnaire and your own responses appear here with a withdrawal and a correction.' }));
  }
  pane.append(elem('section', { className: 'analysis__runs' },
    elem('h3', { className: 'analysis__subtitle' },
      elem('span', { text: 'Responses' }),
      elem('span', { className: 'analysis__count', text: state.responses.length ? `${state.responses.length} in this book` : '' }),
      iconButton({
        name: 'feedback',
        label: 'Read the list again',
        className: 'iconbtn iconbtn--small',
        on: { click: () => { refreshFeedback({ force: true }).catch(() => {}); } }
      })
    ),
    elem('p', { className: 'analysis__hint', text: 'A reader can correct a response with a revision or withdraw it; the response a correction replaces stays in this list, and a withdrawn one keeps its reader, its moment and its state.' }),
    elem('ul', { className: 'runlist', attrs: { id: 'feedback-list' } }, ...responseRows(model))
  ));
  return pane;
}

/* --------------------------------------------------------------- the strip */

/** The two halves of the panel, switched by the strip both of them carry. */
export function viewStrip(model) {
  return elem('div', { className: 'views', attrs: { id: 'feedback-views' } }, ...viewStripItems(model));
}

export function viewStripItems(model) {
  const responses = state.feedbackCounts?.responses ?? state.responses.length;
  const items = [
    { view: 'answer', label: model.revisionOf ? 'Correct a response' : 'Answer the questionnaire' },
    { view: 'team', label: responses ? `What readers said (${responses})` : 'What readers said' }
  ];
  return items.map((item) => elem('button', {
    className: 'viewbtn',
    attrs: { type: 'button', 'aria-current': model.view === item.view ? 'true' : 'false' },
    text: item.label,
    on: { click: () => showFeedback(item.view) }
  }));
}

/** How many readers have answered this book, kept separate from what is not a reader at all. */
export function countsWords() {
  const counts = state.feedbackCounts;
  if (!counts) return '';
  const words = [`${plural(counts.readers ?? 0, 'team reader has', 'team readers have')} answered ${plural(counts.team_human ?? 0, 'time', 'times')}`];
  if (counts.withdrawn) words.push(`${counts.withdrawn} withdrawn`);
  const others = [];
  if (counts.model) others.push(plural(counts.model, 'model annotation', 'model annotations'));
  if (counts.synthetic) others.push(plural(counts.synthetic, 'fixture', 'fixtures'));
  if (others.length) words.push(`${others.join(' and ')}, which ${others.length === 1 ? 'is' : 'are'} not a reader`);
  return `${words.join(' · ')}.`;
}

/* -------------------------------------------------------------- the rows */

export function responseRows(model) {
  if (!state.responses.length) {
    return [elem('li', { className: 'runlist__empty', text: 'No reader has answered this book yet.' })];
  }
  return state.responses.map((response) => responseRow(model, response));
}

function responseRow(model, response) {
  const target = state.feedbackTargets.find((entry) => entry.target_id === response.target_id) ?? null;
  const mine = Boolean(model.reader && response.reader_id === model.reader.reader_id);
  const correction = state.responses.find((entry) => entry.revision_of === response.feedback_id) ?? null;
  const row = elem('li', {
    className: `feedback__response${response.withdrawn ? ' feedback__response--withdrawn' : ''}`,
    attrs: { 'data-feedback': response.feedback_id }
  });
  row.append(elem('div', { className: 'feedback__head' },
    elem('span', { className: 'feedback__who-name', text: readerName(response) }),
    kindBadge(response),
    ...stateBadges(response)
  ));
  if (!isReader(response)) {
    row.append(elem('p', { className: 'feedback__provenance', text: response.reader_kind === 'model'
      ? 'Written by a model, not by a reader: it is listed here, and it is never counted as something a reader said.'
      : 'Written by a fixture, not by a reader: it is listed here, and it is never counted as something a reader said.' }));
  }
  row.append(elem('p', { className: 'feedback__meta' }, ...metaParts(response, target, correction)));
  if (response.historical) {
    row.append(elem('p', { className: 'feedback__historical', text: 'This reader answered a version of the book that is no longer the accepted one; the passages below are read from the frozen copy that response quotes.' }));
  }
  if (response.withdrawn) {
    row.append(elem('p', { className: 'feedback__taken-back', text: 'The reader withdrew this response: who gave it, when and in which state stay readable, and the answers were taken back with it.' }));
  } else {
    const answers = Array.isArray(response.answers) ? response.answers : [];
    if (!answers.length) {
      row.append(elem('p', { className: 'feedback__taken-back', text: 'This response answers no question: its reader wrote about the text without rating it.' }));
    } else {
      row.append(elem('dl', { className: 'feedback__answers' }, ...answers.map((answer) => answerRow(target, answer))));
    }
    for (const comment of response.comments ?? []) row.append(commentRow(comment));
  }
  if (response.conditions?.where) {
    row.append(elem('p', { className: 'feedback__meta', text: `read at ${response.conditions.where}` }));
  }
  const actions = responseActions(model, response, mine);
  if (actions) row.append(actions);
  return row;
}

function isReader(response) {
  return response.reader_kind == null || response.reader_kind === 'team_human';
}

function readerName(response) {
  const reader = state.readers.find((entry) => entry.reader_id === response.reader_id);
  if (!reader) return response.reader_id;
  return reader.deleted_at ? `${reader.display_name} (this identity asked to be deleted)` : reader.display_name;
}

function kindBadge(response) {
  const reader = isReader(response);
  const words = reader
    ? 'reader'
    : (response.reader_kind === 'model' ? 'a model\'s annotation — not a reader' : 'a fixture — not a reader');
  return elem('span', { className: `badge ${reader ? 'badge--reader' : 'badge--notreader'}`, text: words });
}

function stateBadges(response) {
  const badges = [];
  if (response.withdrawn) badges.push(elem('span', { className: 'badge badge--withdrawn', text: 'withdrawn' }));
  if (response.historical) badges.push(historicalBadge());
  if (!badges.length) badges.push(elem('span', { className: 'badge badge--done', text: 'as given' }));
  return badges;
}

function metaParts(response, target, correction) {
  const parts = [stamp(response.created_at) || 'not dated'];
  parts.push(response.scope ? scopeText(response.scope) : 'no scope recorded');
  parts.push(`version ${versionText(response.accepted_source_version)}`);
  if (response.questionnaire_version) parts.push(response.questionnaire_version);
  if (target) parts.push(`frozen as ${response.target_id}`);
  if (response.revision_of) parts.push(`a correction of ${response.revision_of}, revision ${response.revision ?? 2}`);
  if (correction) parts.push(`corrected by ${correction.feedback_id}`);
  if (response.withdrawn_at) parts.push(`withdrawn ${stamp(response.withdrawn_at)}`);
  return parts.flatMap((text, index) => (index
    ? [elem('span', { text: '·' }), elem('span', { text })]
    : [elem('span', { text })]));
}

function answerRow(target, answer) {
  const question = (target?.questionnaire?.questions ?? []).find((entry) => entry.id === answer.question_id) ?? null;
  return elem('div', { className: 'feedback__answer' },
    elem('dt', { className: 'feedback__answer-label', text: question?.label ?? answer.question_id }),
    elem('dd', {
      className: `feedback__answer-value${answer.value == null ? ' feedback__answer-value--skipped' : ''}`,
      text: teamValueWords(question, answer.value)
    })
  );
}

function teamValueWords(question, value) {
  if (value == null) return 'skipped — the reader chose no option, which is not a low answer';
  const anchors = question?.low || question?.high ? `, ${question?.low ?? ''} → ${question?.high ?? ''}` : '';
  return `${value} of ${(question?.options ?? []).length || 5}${anchors}`;
}

function commentRow(comment) {
  const box = elem('div', { className: 'feedback__comment-row' },
    elem('p', { className: 'feedback__comment-text', text: comment.text }));
  for (const range of comment.evidence ?? []) {
    box.append(elem('figure', { className: 'feedback__evidence' },
      elem('blockquote', { className: 'feedback__passage' }, elem('p', { text: range.quote })),
      elem('figcaption', { className: 'feedback__quote-meta', text: `read from the frozen copy: ${range.file}, characters ${range.start}–${range.end}` })
    ));
  }
  return box;
}

function responseActions(model, response, mine) {
  if (!mine) return null;
  if (response.withdrawn) {
    return elem('p', { className: 'feedback__row-actions' },
      elem('span', { className: 'analysis__hint', text: 'A withdrawn response cannot be corrected; write a new response instead.' }));
  }
  const corrected = state.responses.some((entry) => entry.revision_of === response.feedback_id);
  const box = elem('div', { className: 'feedback__row-actions' });
  if (model.confirms === response.feedback_id) {
    box.append(elem('span', { className: 'feedback__ask', text: 'Withdraw this response for good? The answers are taken back and the record stays readable.' }));
    box.append(elem('button', {
      className: 'btn btn--small',
      attrs: { type: 'button' },
      text: 'Withdraw it',
      on: { click: () => withdrawResponse(response.feedback_id) }
    }));
    box.append(elem('button', {
      className: 'btn btn--small btn--quiet',
      attrs: { type: 'button' },
      text: 'Keep it as it is',
      on: { click: () => cancelConfirm() }
    }));
    return box;
  }
  if (corrected) {
    // A response is corrected once: the host refuses a second correction of the same one.
    box.append(elem('span', { className: 'analysis__hint', text: 'This response was already corrected; correct the correction instead.' }));
  } else {
    box.append(elem('button', {
      className: 'btn btn--small',
      attrs: { type: 'button' },
      text: 'Correct this response',
      on: { click: () => correctResponse(response) }
    }));
  }
  box.append(elem('button', {
    className: 'btn btn--small btn--quiet',
    attrs: { type: 'button' },
    text: 'Withdraw this response',
    on: { click: () => confirmWithdraw(response.feedback_id) }
  }));
  return box;
}
