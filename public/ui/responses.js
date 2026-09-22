/**
 * scriptaWorlds — The responses of a book, and the readers they belong to.
 *
 * This is the data side of the feedback surface (`docs/contracts.md` §8.7): the list of responses a book
 * holds and the targets they answer, the roster of identities and the one identity this browser
 * remembered — created once, renamed when it must be, forgotten when someone else reads — the frozen
 * copy the open questionnaire anchors a passage to, and the two acts that change a response afterwards:
 * a correction, which is a new response naming the one it replaces, and a withdrawal, which keeps the
 * record and takes the answers back. It holds no form of its own: the questionnaire a reader answers
 * lives in `./feedback.js`, which reads everything here.
 */
import {
  createFeedbackReader,
  loadFeedback,
  loadFeedbackReaders,
  readFeedbackTarget,
  renameFeedbackReader,
  withdrawReaderFeedback
} from './api.js';
import { showError } from './errors.js';
import { renderPanels } from './overlays.js';
import { readerKey, state } from './state.js';

/** The name a reader is listed under, and what the host accepts for one. */
export const NAME_CHARS = 80;

/** Rebuild whichever pane is open. Handlers that only change a value the DOM already shows do not need it. */
export function repaint() {
  const model = state.feedback;
  if (!model) return;
  model.rev += 1;
  renderPanels();
}

/** The content of the open form changed, so a retry is no longer the same submission. */
export function touched(model) {
  model.feedbackId = null;
  model.notice = null;
}

/* ------------------------------------------------------- the frozen copy */

/**
 * The frozen copy of the chapters that are on screen. The text of a chapter is read from the browser's
 * own copy of what was displayed, so a quotation is anchored to the words the reader saw and not to
 * whatever the book says a moment later; an older target, whose text is no longer the accepted one,
 * carries no copy to quote from.
 */
export function adopt(target, prefill = null) {
  const model = state.feedback;
  model.target = target;
  model.copy = new Map();
  for (const chapter of target.chapters ?? []) {
    model.copy.set(chapter.number, state.chapters.get(chapter.number)?.markdown ?? null);
  }
  model.frozen = target.historical !== true;
  model.questions = target.questionnaire?.questions ?? [];
  model.answers = new Map(model.questions.map((question) => {
    const found = (prefill?.answers ?? []).find((answer) => answer.question_id === question.id);
    return [question.id, { value: found?.value ?? null }];
  }));
  model.comments = (prefill?.comments ?? []).length
    ? prefill.comments.map((comment) => ({ text: String(comment.text ?? ''), evidence: firstRange(comment.evidence) }))
    : [{ text: '', evidence: null }];
  model.picked = null;
  model.freezeError = null;
  if (model.copyChapter == null || !model.copy.has(model.copyChapter)) {
    model.copyChapter = (target.chapters ?? [])[0]?.number ?? null;
  }
}

/** The stored quotation of a response, reduced to the one range a comment of this form carries. */
function firstRange(evidence) {
  const range = Array.isArray(evidence) ? evidence[0] : null;
  if (!range) return null;
  return {
    file: String(range.file ?? ''),
    start: Number(range.start),
    end: Number(range.end),
    quote: String(range.quote ?? '')
  };
}

/**
 * What a reader already wrote, carried across a re-freeze: the answers and the words, never the
 * quotations — a quotation is a range in one frozen copy and means nothing in another.
 */
export function carryOver(model) {
  return {
    answers: model.questions.map((question) => ({ question_id: question.id, value: model.answers.get(question.id)?.value ?? null })),
    comments: model.comments.map((comment) => ({ text: comment.text, evidence: [] })),
    quotations: model.comments.filter((comment) => comment.evidence).length
  };
}

/** The chapter of the frozen copy a number belongs to, or null when the target does not display it. */
export function chapterPath(model, number) {
  return (model?.target?.chapters ?? []).find((chapter) => chapter.number === number)?.path ?? null;
}

/** The text of one chapter of the frozen copy, as this browser displayed it. */
export function copyText(model, number) {
  return model?.copy?.get(number) ?? null;
}

/** Which chapter of the frozen copy a passage is picked in. */
export function selectCopyChapter(number) {
  const model = state.feedback;
  if (!model || !Number.isInteger(number)) return;
  model.copyChapter = number;
  model.picked = null;
  repaint();
}

/* --------------------------------------------------------------- identity */

/** The identity this browser remembered for a book, or null when it never gave a name. */
export function storedReader() {
  if (!state.universeId) return null;
  try {
    const raw = localStorage.getItem(readerKey(state.universeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.reader_id) return null;
    return { reader_id: String(parsed.reader_id), display_name: String(parsed.display_name ?? '') };
  } catch {
    return null;
  }
}

export function rememberReader(reader) {
  if (!state.universeId || !reader?.reader_id) return;
  try {
    localStorage.setItem(readerKey(state.universeId), JSON.stringify({ reader_id: reader.reader_id, display_name: reader.display_name }));
  } catch { /* storage refused: the reader is asked for their name again next time */ }
}

export function forgetReader() {
  if (!state.universeId) return;
  try {
    localStorage.removeItem(readerKey(state.universeId));
  } catch { /* storage refused */ }
}

/** The remembered identity is checked against the roster: a deleted one is not a reader any more. */
function reconcileReader() {
  const model = state.feedback;
  if (!model?.reader) return false;
  const found = state.readers.find((reader) => reader.reader_id === model.reader.reader_id);
  if (found && !found.deleted_at) {
    if (found.display_name === model.reader.display_name) return false;
    model.reader.display_name = found.display_name;
    if (!model.nameOpen) model.name = found.display_name;
    return true;
  }
  if (!state.readersLoaded) return false;
  model.reader = null;
  model.name = '';
  model.nameOpen = true;
  model.error = 'The identity this browser remembered is not a reader of this book any more; type your name to be listed under.';
  return true;
}

/** Another person is at this browser: the next name typed is a reader of its own. */
export function useAnotherName() {
  const model = state.feedback;
  if (!model) return;
  forgetReader();
  model.reader = null;
  model.name = '';
  model.nameOpen = true;
  model.feedbackId = null;
  model.error = null;
  model.notice = 'The next name you type is a reader of its own; the responses already given stay attributed to the previous one.';
  repaint();
}

/** Open the name field so the reader can correct how they are listed without losing their responses. */
export function changeName() {
  const model = state.feedback;
  if (!model) return;
  model.nameOpen = true;
  model.name = model.reader?.display_name ?? model.name;
  repaint();
}

export function setName(value) {
  const model = state.feedback;
  if (!model) return;
  model.name = String(value ?? '').slice(0, NAME_CHARS);
  touched(model);
}

/** The identity a submission is attributed to, created or renamed as the reader asked. */
export async function ensureReader() {
  const model = state.feedback;
  const typed = model.name.trim();
  if (model.reader && !model.nameOpen) return model.reader;
  if (model.reader) {
    if (!typed) {
      model.error = 'A reader needs a name; type the one you want to be listed under.';
      return null;
    }
    if (typed === model.reader.display_name) {
      model.nameOpen = false;
      return model.reader;
    }
    const renamed = await renameFeedbackReader(model.reader.reader_id, typed);
    if (!renamed) throw new Error('The host renamed nobody.');
    model.reader = { reader_id: renamed.reader_id, display_name: renamed.display_name };
    rememberReader(model.reader);
    model.nameOpen = false;
    return model.reader;
  }
  if (!typed) {
    model.error = 'Type the name you want to be listed under; nothing else about you is needed.';
    return null;
  }
  const created = await createFeedbackReader(typed);
  if (!created) throw new Error('The host created no identity.');
  model.reader = { reader_id: created.reader_id, display_name: created.display_name };
  rememberReader(model.reader);
  model.nameOpen = false;
  return model.reader;
}

/* ------------------------------------------------------------ the list */

export function upsertResponse(response) {
  if (!response?.feedback_id) return;
  const rest = state.responses.filter((entry) => entry.feedback_id !== response.feedback_id);
  rest.push(response);
  rest.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
    || String(b.feedback_id).localeCompare(String(a.feedback_id)));
  state.responses = rest;
}

/** Every response of the book, newest first, with the targets they answer and the roster of readers. */
export async function refreshFeedback({ force = true } = {}) {
  const list = await loadFeedback(force);
  await loadFeedbackReaders(force).catch(() => state.readers);
  if (reconcileReader()) repaint();
  else if (state.panel === 'feedback') renderPanels();
  return list;
}

/**
 * A turn finished or a review settled: the accepted version may have moved, which makes the responses
 * about the version it replaced historical. The open panel follows that instead of a timer of its own.
 */
export function feedbackChanged() {
  if (!state.universeId) return;
  state.feedbackLoaded = false;
  state.readersLoaded = false;
  if (state.panel === 'feedback') refreshFeedback({ force: true }).catch(() => {});
}

/** Leaving a book: no response of another book is listed and no identity of it is kept in memory. */
export function resetFeedbackState() {
  state.feedback = null;
  state.responses = [];
  state.feedbackTargets = [];
  state.feedbackCounts = null;
  state.feedbackLoaded = false;
  state.readers = [];
  state.readersLoaded = false;
  state.selection = null;
}

/* --------------------------------------------------------- the two acts */

/** A withdrawal: the response stays readable, marked, and its answers are taken back. */
export async function withdrawResponse(feedbackId) {
  const model = state.feedback;
  if (model) {
    model.confirms = null;
    model.error = null;
    renderPanels();
  }
  try {
    const response = await withdrawReaderFeedback(feedbackId);
    if (response) upsertResponse(response);
    await refreshFeedback({ force: true }).catch(() => {});
  } catch (error) {
    const message = explain(error);
    if (model) {
      model.error = message;
      renderPanels();
    } else {
      showError(message);
    }
  }
}

/** The two steps of a withdrawal: the first press asks, the second one takes the answers back. */
export function confirmWithdraw(feedbackId) {
  const model = state.feedback;
  if (!model) return;
  model.confirms = model.confirms === feedbackId ? null : feedbackId;
  repaint();
}

export function cancelConfirm() {
  const model = state.feedback;
  if (!model) return;
  model.confirms = null;
  repaint();
}

/**
 * Correct one of this reader's own responses. A correction is a new response that points at the one it
 * replaces (`revision_of`), against the same frozen copy: the corrected response stays readable, so
 * what the reader said first is not erased by what they said next.
 */
export async function correctResponse(response) {
  const model = state.feedback;
  if (!model) return;
  model.busy = true;
  model.error = null;
  model.notice = null;
  renderPanels();
  try {
    const target = state.feedbackTargets.find((entry) => entry.target_id === response.target_id)
      ?? await readFeedbackTarget(response.target_id);
    if (!target) throw new Error(`The frozen copy ${response.target_id} is not listed for this book any more.`);
    model.view = 'answer';
    model.revisionOf = response.feedback_id;
    if (!model.reader && response.reader_id) {
      const reader = state.readers.find((entry) => entry.reader_id === response.reader_id);
      model.reader = reader ? { reader_id: reader.reader_id, display_name: reader.display_name } : null;
    }
    adopt(target, { answers: response.answers, comments: response.comments });
    model.notice = `Correcting ${response.feedback_id}: the response below is the one it replaces, and a correction is revision ${(response.revision ?? 1) + 1}.`;
  } catch (error) {
    model.error = explain(error);
  } finally {
    model.busy = false;
    repaint();
  }
}

/* ----------------------------------------------------------------- words */

const ERROR_HINTS = {
  STALE_TARGET: 'The frozen copy cannot be reproduced any more: freeze the version you are reading and answer that one.',
  READER_NOT_FOUND: 'That identity is not a reader of this book any more; type your name to be listed under.',
  INVALID_FEEDBACK: 'The host refused the response; a quotation has to match the frozen copy word for word, and a comment has a length limit.',
  CONFLICT: 'This submission identifier was already used for different content; send again to write a new response.',
  NOT_FOUND: 'The frozen copy or the reader is no longer there; freeze the text again and try once more.'
};

/** The message a reader can act on, with the code's own advice when the server sent one. */
export function explain(error) {
  const message = String(error?.message ?? error ?? '').trim() || 'The feedback could not be saved.';
  const hint = ERROR_HINTS[error?.code];
  return hint ? `${message} ${hint}` : message;
}
