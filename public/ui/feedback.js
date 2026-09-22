/**
 * scriptaWorlds — The reader's own response: the questionnaire of a book, answered by a person.
 *
 * A response is about a version of the text, never about the book as it keeps changing: opening the
 * questionnaire freezes the accepted version into a target outside `universes/` (docs/contracts.md
 * §8.7), and every answer, comment and quotation the reader writes is anchored to that frozen copy.
 * Nothing here edits a chapter, nothing is averaged with anyone else's answers, and the identity the
 * host issues is the only thing a submission needs.
 *
 * What happens around a response afterwards — the list of them, the roster of readers, a correction and
 * a withdrawal — lives in `./responses.js`, which this module reads.
 */
import { freezeFeedbackTarget, submitReaderFeedback } from './api.js';
import { openPanel, renderPanels } from './overlays.js';
import { acceptedChapterNumbers } from './review.js';
import {
  adopt,
  carryOver,
  chapterPath,
  copyText,
  ensureReader,
  explain,
  repaint,
  refreshFeedback,
  storedReader,
  touched,
  upsertResponse
} from './responses.js';
import { dom, state } from './state.js';

/** The limits of §8.7 the form respects before the server has to refuse anything. */
export const QUOTE_CHARS = 600;

export const COMMENT_CHARS = 4000;

export const WHERE_CHARS = 200;

export const COMMENT_LIMIT = 20;

/** The open feedback surface, or null while it is closed. */
export function feedbackTarget() {
  return state.feedback;
}

/** One comment of a response, before it is filled in. */
function blankComment() {
  return { text: '', evidence: null };
}

/* --------------------------------------------------------------- opening */

/**
 * Open the feedback surface on the book the reader is reading. The toolbar control passes the chapter
 * it was used from, which is the chapter a quotation comes from by default; the questionnaire itself
 * covers the book, because a reading is about the text as a whole and not about one episode of it.
 */
export function openFeedback({ chapter = null } = {}) {
  const known = storedReader();
  state.feedback = {
    view: 'answer',
    chapter,
    target: null,
    copy: new Map(),
    copyChapter: chapter,
    picked: null,
    questions: [],
    answers: new Map(),
    comments: [blankComment()],
    where: '',
    reader: known,
    name: known?.display_name ?? '',
    nameOpen: known === null,
    busy: false,
    freezeError: null,
    error: null,
    notice: null,
    revisionOf: null,
    feedbackId: null,
    confirms: null,
    rev: 0,
    renderedRev: -1
  };
  openPanel('feedback');
  dom['feedback-close'].focus();
  freeze().catch(() => {});
  refreshFeedback({ force: true }).catch(() => {});
}

/** Switch between answering the questionnaire and reading what the team already said. */
export function showFeedback(view) {
  const model = state.feedback;
  if (!model || model.view === view) return;
  model.view = view;
  if (view === 'team') refreshFeedback({ force: false }).catch(() => {});
  repaint();
}

/* ------------------------------------------------------------- the target */

/**
 * Freeze the accepted version of the displayed book as a reading target, or open the target a reader of
 * the same version already made. The questionnaire is the target's, not the interface's: what a reader
 * answers is read against exactly the questions and the text their own target carries.
 */
export async function freeze() {
  const model = state.feedback;
  if (!model || model.busy || !state.universeId) return;
  const numbers = acceptedChapterNumbers();
  if (numbers.length === 0) {
    model.freezeError = 'This book has no accepted chapter to read yet, so there is nothing to freeze.';
    repaint();
    return;
  }
  model.busy = true;
  model.freezeError = null;
  model.error = null;
  renderPanels();
  try {
    const carried = model.target ? carryOver(model) : null;
    const wasCorrecting = model.revisionOf != null;
    const { target } = await freezeFeedbackTarget({ scope: { kind: 'book' }, runId: null, note: null, findingIds: [] });
    if (!target) throw new Error('The host answered without a target to answer against.');
    model.revisionOf = null;
    adopt(target, carried);
    const parts = [];
    if (wasCorrecting) parts.push('the correction was dropped, because a response about the version on screen is a new response and not a correction of one about an earlier copy');
    if (carried?.quotations) {
      parts.push(carried.quotations === 1
        ? 'the quotation you made belongs to the earlier copy and was left behind'
        : `${carried.quotations} quotations belonged to the earlier copy and were left behind`);
    }
    if (parts.length) {
      const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
      model.notice = `${[first, ...parts.slice(1)].join('; ')}. Quote the passage again in the version you just froze if you still want it quoted.`;
    }
  } catch (error) {
    model.freezeError = explain(error);
  } finally {
    model.busy = false;
    repaint();
  }
}

/* ------------------------------------------------------------- quarters */

export function chooseAnswer(questionId, option) {
  const model = state.feedback;
  const answer = model?.answers.get(questionId);
  if (!answer) return;
  answer.value = option;
  touched(model);
  renderPanels();
}

/** A skipped question is an answer of its own: it is recorded as skipped and never read as a low score. */
export function skipAnswer(questionId) {
  const model = state.feedback;
  const answer = model?.answers.get(questionId);
  if (!answer) return;
  answer.value = null;
  touched(model);
  renderPanels();
}

export function setWhere(value) {
  const model = state.feedback;
  if (!model) return;
  model.where = String(value ?? '').slice(0, WHERE_CHARS);
  touched(model);
}

export function setCommentText(index, value) {
  const model = state.feedback;
  const comment = model?.comments[index];
  if (!comment) return;
  comment.text = String(value ?? '').slice(0, COMMENT_CHARS);
  touched(model);
}

export function addComment() {
  const model = state.feedback;
  if (!model || model.comments.length >= COMMENT_LIMIT) return;
  model.comments.push(blankComment());
  touched(model);
  repaint();
}

export function removeComment(index) {
  const model = state.feedback;
  if (!model || model.comments.length <= 1) return;
  model.comments.splice(index, 1);
  touched(model);
  repaint();
}

export function removeQuote(index) {
  const model = state.feedback;
  const comment = model?.comments[index];
  if (!comment) return;
  comment.evidence = null;
  touched(model);
  repaint();
}

/* ------------------------------------------------------------ the passages */

/**
 * Remember the passage a reader selected in the book, or in the frozen copy inside this dialog. The
 * reading area is covered by the dialog, so its selection is remembered as it is made: a click that
 * clears the highlight afterwards does not lose the passage.
 */
export function rememberSelection() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement ?? null;
  if (!anchor) return;
  const slide = anchor.closest('.slide');
  if (slide) {
    const number = Number.parseInt(String(slide.dataset.key ?? '').slice(1), 10);
    if (!Number.isInteger(number) || !state.universeId) return;
    const text = selection.toString().trim();
    if (!text) return;
    if (state.selection?.text === text && state.selection?.chapter === number) return;
    state.selection = { text, chapter: number, universeId: state.universeId };
    const model = state.feedback;
    if (model?.view === 'answer') repaint();
    return;
  }
  const copy = anchor.closest('[data-feedback-copy]');
  const model = state.feedback;
  if (!copy || !model) return;
  const range = selection.getRangeAt(0);
  model.picked = { chapter: Number(copy.dataset.feedbackCopy), ...offsetsIn(copy, range) };
}

/** The offsets of a range inside one container, in the characters of that container's text. */
function offsetsIn(container, range) {
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const text = range.toString();
  return { start, end: start + text.length, text };
}

/** The passage selected in the book, when it can still be anchored to the frozen copy. */
export function bookSelection() {
  const model = state.feedback;
  const selection = state.selection;
  if (!model?.target || !selection) return null;
  if (selection.universeId !== state.universeId) return null;
  if (!model.frozen) return null;
  if (copyText(model, selection.chapter) == null) return null;
  if (!chapterPath(model, selection.chapter)) return null;
  return selection;
}

/** Why quoting from the book is not offered, in the reader's words. */
export function quoteHint(model) {
  if (!model.frozen) return 'This questionnaire is about an earlier version of the book; the text on screen is not the text it is about, so a passage cannot be quoted against it.';
  if (!bookSelection()) return 'Select the passage in the chapter you are reading, or pick it in the frozen copy below.';
  return null;
}

/** Quote the passage the reader selected in the book, anchored to the frozen copy of that chapter. */
export function quoteFromBook(index) {
  const model = state.feedback;
  const selection = bookSelection();
  if (!model || !selection) return;
  const text = copyText(model, selection.chapter);
  const path = chapterPath(model, selection.chapter);
  const range = anchorPassage(text, selection.text);
  if (!range) {
    model.error = `The passage you selected could not be found word for word in the frozen copy of chapter ${selection.chapter}. Select a plainer passage, without formatting across it, or quote it in the frozen copy below.`;
    repaint();
    return;
  }
  setQuote(index, { file: path, start: range.start, end: range.end, quote: text.slice(range.start, range.end) });
}

/** Quote what the reader selected inside the frozen copy shown in this dialog: the offsets are exact. */
export function quoteFromCopy(index) {
  const model = state.feedback;
  if (!model) return;
  const chapter = model.copyChapter;
  const text = copyText(model, chapter);
  const path = chapterPath(model, chapter);
  if (text == null || !path) {
    model.error = `The frozen copy of chapter ${chapter} is not on screen, so nothing can be quoted from it.`;
    repaint();
    return;
  }
  const found = liveCopySelection(index) ?? (model.picked?.chapter === chapter ? model.picked : null);
  if (!found) {
    model.error = 'Select a passage inside the frozen copy first.';
    repaint();
    return;
  }
  setQuote(index, { file: path, start: found.start, end: found.end, quote: text.slice(found.start, found.end) });
}

function liveCopySelection(index) {
  const pane = document.getElementById(`feedback-copy-text-${index}`);
  const selection = document.getSelection();
  if (!pane || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (!pane.contains(selection.anchorNode)) return null;
  return offsetsIn(pane, selection.getRangeAt(0));
}

function setQuote(index, evidence) {
  const model = state.feedback;
  const comment = model.comments[index];
  if (!comment) return;
  const length = evidence.end - evidence.start;
  if (length <= 0) {
    model.error = 'That selection is empty.';
    repaint();
    return;
  }
  if (length > QUOTE_CHARS) {
    model.error = `A quotation is at most ${QUOTE_CHARS} characters; that selection is ${length}.`;
    repaint();
    return;
  }
  comment.evidence = evidence;
  state.selection = null;
  model.picked = null;
  model.error = null;
  touched(model);
  repaint();
}

/**
 * The offsets of a passage the reader selected in the rendered chapter, resolved in the frozen copy.
 * The rendered text has its Markdown markers gone and its wrapped lines joined, so an exact search is
 * tried first and a search that ignores runs of whitespace follows; a passage that cannot be located
 * exactly once is refused rather than anchored to the wrong words.
 */
function anchorPassage(text, prose) {
  const wanted = String(prose ?? '').trim();
  if (!text || !wanted) return null;
  const direct = text.indexOf(wanted);
  if (direct >= 0 && text.indexOf(wanted, direct + 1) < 0) return { start: direct, end: direct + wanted.length };
  const haystack = collapse(text);
  const needle = collapse(wanted).text;
  const found = haystack.text.indexOf(needle);
  if (found < 0 || haystack.text.indexOf(needle, found + 1) >= 0) return null;
  const start = haystack.map[found];
  const end = haystack.map[found + needle.length - 1] + 1;
  return end > start ? { start, end } : null;
}

/** One form of a text with every run of whitespace folded to one space, and where each character was. */
function collapse(text) {
  const out = [];
  const map = [];
  let space = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) {
      space = out.length > 0;
      continue;
    }
    if (space) {
      out.push(' ');
      map.push(index);
      space = false;
    }
    out.push(character);
    map.push(index);
  }
  return { text: out.join(''), map };
}

/* ------------------------------------------------------------ submission */

/**
 * Send what the reader wrote. The text is frozen, the identity is the server's, and a retry of the same
 * submission is answered with the entry that exists instead of writing a second one.
 */
export async function sendFeedback() {
  const model = state.feedback;
  if (!model || model.busy || !state.universeId) return;
  if (!model.target) {
    model.error = 'The text is not frozen yet; wait for the frozen copy and try again.';
    repaint();
    return;
  }
  const comments = model.comments.filter((comment) => comment.text.trim() !== '');
  const answered = [...model.answers.values()].some((answer) => answer.value != null);
  if (!answered && comments.length === 0) {
    model.error = 'There is nothing to send yet: answer a question, or write a comment. Skipping every question is allowed, but a response that says nothing is not.';
    repaint();
    return;
  }
  model.busy = true;
  model.error = null;
  model.notice = null;
  model.confirms = null;
  renderPanels();
  try {
    const reader = await ensureReader();
    if (!reader) return;
    const body = {
      targetId: model.target.target_id,
      readerId: reader.reader_id,
      feedbackId: model.feedbackId ?? (model.feedbackId = draftId()),
      answers: model.questions.map((question) => ({
        question_id: question.id,
        value: model.answers.get(question.id)?.value ?? null,
        comment: null
      })),
      comments: comments.map((comment) => ({
        text: comment.text.trim(),
        evidence: comment.evidence ? [{ ...comment.evidence }] : []
      })),
      conditions: { where: model.where.trim() || null },
      revision_of: model.revisionOf ?? null
    };
    const { feedback, deduplicated } = await submitReaderFeedback(body);
    if (!feedback) throw new Error('The host answered without the response it recorded.');
    model.feedbackId = null;
    // The correction is written: the form is a new response again, not another correction of the same one.
    model.revisionOf = null;
    model.notice = deduplicated
      ? `This response was already recorded as ${feedback.feedback_id}; nothing was written twice.`
      : `Your answer is recorded as ${feedback.feedback_id}. It is listed with the others, under your name, exactly as you gave it.`;
    upsertResponse(feedback);
    await refreshFeedback({ force: true }).catch(() => {});
  } catch (error) {
    model.error = explain(error);
    if (error.code === 'READER_NOT_FOUND') {
      model.reader = null;
      model.nameOpen = true;
    }
  } finally {
    model.busy = false;
    repaint();
  }
}

const draftId = () => `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
