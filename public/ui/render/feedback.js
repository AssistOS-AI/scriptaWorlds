/**
 * scriptaWorlds — The reader's pane of the feedback panel, and the panel itself.
 *
 * `renderFeedback` is the facade the dialog calls: it swaps the two panes, keeps the strip and the list
 * of responses current, and syncs the values that live in nodes the rebuild keeps. The reader's own pane
 * is here — the frozen copy the answers are about, the questionnaire with its anchors and its skip
 * control, the comments with their quotations, and the identity the host issued. What the team reads
 * back is `./responses.js`; the surface behind both is `../feedback.js`.
 *
 * The form is rebuilt only when the surface itself changes (`state.feedback.rev`), so a list that
 * refreshes itself never discards a half-written comment.
 */
import {
  ANSWER_COMMENT_CHARS,
  COMMENT_CHARS,
  COMMENT_LIMIT,
  QUOTE_CHARS,
  WHERE_CHARS,
  addComment,
  bookSelection,
  chooseAnswer,
  chooseReaction,
  feedbackTarget,
  freeze,
  quoteFromBook,
  quoteFromCopy,
  quoteHint,
  removeComment,
  removeQuote,
  sendFeedback,
  setCommentText,
  setExposure,
  setReactionComment,
  setWhere,
  showFeedback,
  skipAnswer,
  toggleComparison
} from '../feedback.js';
import { NAME_CHARS, changeName, chapterPath, copyText, selectCopyChapter, setName, useAnotherName } from '../responses.js';
import { dom, el, elem, plural, short, state } from '../state.js';
import { countsWords, responseRows, teamPane, viewStrip, viewStripItems } from './responses.js';
import { scopeText, stamp, versionText } from './runs.js';

export function renderFeedback() {
  const model = feedbackTarget();
  if (!model) return;
  dom['feedback-title'].textContent = `Reader feedback — ${short(state.universe?.title ?? 'this book', 60)}`;
  const body = dom['feedback-body'];
  if (model.renderedRev !== model.rev) {
    body.replaceChildren(...(model.view === 'team' ? [teamPane(model)] : answerPane(model)));
    model.renderedRev = model.rev;
  }
  // The strip and the list of responses hold no text a reader is typing, so they follow the state on
  // every render: a refreshed count or a withdrawal shows up without rebuilding the form around them.
  const strip = el('feedback-views');
  if (strip) strip.replaceChildren(...viewStripItems(model));
  const list = el('feedback-list');
  if (list) list.replaceChildren(...responseRows(model));
  syncFeedback(model);
}

/** The values that live in nodes the rebuild keeps: an error, a notice, a count, a control's state. */
function syncFeedback(model) {
  const error = el('feedback-error');
  if (error) {
    error.textContent = model.error ?? '';
    error.hidden = !model.error;
  }
  const notice = el('feedback-notice');
  if (notice) {
    notice.textContent = model.notice ?? '';
    notice.hidden = !model.notice;
  }
  const counts = el('feedback-counts');
  if (counts) counts.textContent = countsWords();
  const send = el('feedback-send');
  if (send) {
    send.disabled = model.busy || !model.target;
    send.textContent = model.busy ? 'Sending…' : (model.revisionOf ? 'Send the correction' : 'Send my answers');
  }
  for (const question of model.questions) {
    const answer = model.answers.get(question.id);
    const line = el(`feedback-answer-${question.id}`);
    if (line) line.textContent = answerWords(question, answer?.value ?? null);
    const skip = el(`feedback-skip-${question.id}`);
    if (skip) skip.setAttribute('aria-pressed', answer?.value == null ? 'true' : 'false');
    for (const option of question.options ?? []) {
      const label = el(`feedback-option-${question.id}-${option}`);
      if (label) label.classList.toggle('feedback__option--on', answer?.value === option);
    }
  }
}

/* ------------------------------------------------------------- the answer */

function answerPane(model) {
  return [
    viewStrip(model),
    elem('form', {
      className: 'analysis__form',
      attrs: { id: 'feedback-form' },
      on: { submit: (event) => { event.preventDefault(); sendFeedback(); } }
    },
    elem('p', { className: 'analysis__hint', text: 'This is your own reading of the book, not a form to fill in: answer what you want to answer, skip what you do not, and write a comment that may stand on its own. Your answers are kept beside the book and are never averaged with anyone else\'s.' }),
    elem('p', { className: 'feedback__freeze', attrs: { id: 'feedback-freeze' }, text: freezeWords(model) }),
    ...freezeActions(model),
    elem('p', { className: 'feedback__counts', attrs: { id: 'feedback-counts' }, text: countsWords() }),
    identitySet(model),
    questionnaireSet(model),
    commentsSet(model),
    reactionsSet(model),
    conditionsSet(model),
    elem('p', { className: 'analysis__error', attrs: { id: 'feedback-error', role: 'alert' } }),
    elem('p', { className: 'feedback__notice', attrs: { id: 'feedback-notice', role: 'status' } }),
    elem('div', { className: 'popup__actions' },
      elem('button', { className: 'btn btn--accent', attrs: { type: 'submit', id: 'feedback-send' }, text: 'Send my answers' }),
      elem('button', {
        className: 'btn btn--quiet',
        attrs: { type: 'button', id: 'feedback-comparison-open' },
        text: model.comparisonOpen ? 'Close the comparison' : 'Compare two versions',
        on: { click: () => toggleComparison() }
      }),
      elem('button', { className: 'btn btn--quiet', attrs: { type: 'button' }, text: 'See what readers said', on: { click: () => showFeedback('team') } })
    ),
    // The two-text reading session of §8.7 draws itself here; the form only offers the place.
    ...(model.comparisonOpen ? [elem('div', { className: 'feedback__comparison', attrs: { id: 'feedback-comparison' } })] : []))
  ];
}

function freezeWords(model) {
  if (model.freezeError) return model.freezeError;
  if (!model.target) return model.busy ? 'Freezing the text you are reading…' : 'The text is not frozen yet.';
  const chapters = model.target.chapters?.length ?? 0;
  const scope = model.target.scope?.kind === 'book'
    ? `the whole book (${plural(chapters, 'chapter', 'chapters')})`
    : scopeText(model.target.scope);
  const words = `This questionnaire is about ${scope} as it was when you opened it — frozen ${stamp(model.target.created_at) || 'not dated'}, version ${versionText(model.target.source_version)}, ${model.target.questionnaire?.version ?? 'its own questionnaire'}. Every answer, comment and quotation is anchored to that frozen copy.`;
  return model.target.historical
    ? `${words} The book has been rewritten since, so this copy is an earlier version of it and a response to it is listed as historical.`
    : words;
}

function freezeActions(model) {
  if (model.target?.historical) {
    return [elem('div', { className: 'feedback__freeze-actions' },
      elem('button', {
        className: 'btn btn--small',
        attrs: { type: 'button' },
        text: 'Freeze the version on screen now',
        on: { click: () => freeze({ current: true }) }
      }))];
  }
  if (model.freezeError) {
    return [elem('div', { className: 'feedback__freeze-actions' },
      elem('button', {
        className: 'btn btn--small',
        attrs: { type: 'button' },
        // The draft stays in the form: this reads the accepted text again and freezes that version.
        text: 'Freeze the version on screen now',
        on: { click: () => freeze({ current: true }) }
      }),
      elem('button', {
        className: 'btn btn--small btn--quiet',
        attrs: { type: 'button' },
        text: 'Try freezing again',
        on: { click: () => freeze() }
      }))];
  }
  return [];
}

function identitySet(model) {
  const box = elem('fieldset', { className: 'analysis__set', attrs: { id: 'feedback-identity' } },
    elem('legend', { text: 'Who is answering' }));
  if (model.reader && !model.nameOpen) {
    box.append(elem('p', { className: 'feedback__who' },
      elem('span', { text: 'Answering as ' }),
      elem('strong', { text: model.reader.display_name }),
      elem('span', { className: 'feedback__id', text: model.reader.reader_id })
    ));
    box.append(elem('div', { className: 'feedback__who-actions' },
      elem('button', {
        className: 'btn btn--small',
        attrs: { type: 'button' },
        text: 'Change the name I am listed under',
        on: { click: () => changeName() }
      }),
      elem('button', {
        className: 'btn btn--small btn--quiet',
        attrs: { type: 'button' },
        text: 'Someone else is reading',
        on: { click: () => useAnotherName() }
      })
    ));
    box.append(elem('p', { className: 'analysis__hint', text: 'The identity the host issued travels with every response you give, so your answers stay yours even when you are renamed. Nothing else about you is recorded.' }));
    return box;
  }
  box.append(elem('label', { className: 'field', attrs: { for: 'feedback-name' } },
    elem('span', { className: 'field__label', text: 'Your name' }),
    elem('input', {
      className: 'analysis__input',
      attrs: {
        id: 'feedback-name',
        type: 'text',
        maxlength: String(NAME_CHARS),
        placeholder: 'The name your answers are listed under',
        value: model.name ?? ''
      },
      on: { input: (event) => setName(event.currentTarget.value) }
    })
  ));
  box.append(elem('p', { className: 'analysis__hint', text: model.reader
    ? 'Changing the name keeps every response you already gave attributed to you.'
    : 'The name is all a response needs, and this browser remembers the identity for this book. What you read is nobody else\'s business: nothing else about you is asked for.' }));
  return box;
}

function questionnaireSet(model) {
  const box = elem('fieldset', { className: 'analysis__set', attrs: { id: 'feedback-questions' } },
    elem('legend', { text: 'The questionnaire' }));
  if (!model.questions.length) {
    box.append(elem('p', { className: 'analysis__hint', text: 'The questions come with the frozen copy of the book; they are not here yet.' }));
    return box;
  }
  box.append(elem('p', { className: 'analysis__hint', text: 'Each question is anchored between two words. Choose one of the numbers, or skip the question — a skipped answer is recorded as skipped and is never read as a low one.' }));
  for (const question of model.questions) box.append(questionGroup(model, question));
  return box;
}

function questionGroup(model, question) {
  const answer = model.answers.get(question.id);
  const labelId = `feedback-label-${question.id}`;
  const options = question.options ?? [];
  return elem('div', { className: 'feedback__question', attrs: { role: 'group', 'aria-labelledby': labelId } },
    elem('div', { className: 'feedback__question-head' },
      elem('span', { className: 'feedback__question-label', attrs: { id: labelId }, text: question.label }),
      elem('button', {
        className: 'feedback__skip',
        attrs: {
          type: 'button',
          id: `feedback-skip-${question.id}`,
          'aria-pressed': answer?.value == null ? 'true' : 'false',
          title: 'Skip this question'
        },
        text: 'Skip',
        on: { click: () => skipAnswer(question.id) }
      })
    ),
    elem('div', { className: 'feedback__scale' },
      elem('span', { className: 'feedback__anchor', text: question.low ?? '' }),
      elem('span', { className: 'feedback__options' }, ...options.map((option) => {
        const id = `feedback-option-${question.id}-${option}`;
        return elem('label', {
          className: `feedback__option${answer?.value === option ? ' feedback__option--on' : ''}`,
          attrs: { id, for: `${id}-input` }
        },
        elem('input', {
          attrs: {
            type: 'radio',
            id: `${id}-input`,
            name: `feedback-${question.id}`,
            value: String(option),
            ...(answer?.value === option ? { checked: true } : {})
          },
          on: { change: () => chooseAnswer(question.id, option) }
        }),
        elem('span', { className: 'feedback__option-number', text: String(option) }));
      })),
      elem('span', { className: 'feedback__anchor', text: question.high ?? '' })
    ),
    elem('p', { className: 'feedback__answer-state', attrs: { id: `feedback-answer-${question.id}` }, text: answerWords(question, answer?.value ?? null) })
  );
}

function answerWords(question, value) {
  if (value == null) return 'skipped — nothing is chosen here, and a skipped question is never read as a low answer';
  const options = question.options ?? [];
  const anchors = question.low || question.high ? ` · ${question.low ?? ''} → ${question.high ?? ''}` : '';
  return `${value} of ${options.length || 5}${anchors}`;
}

function commentsSet(model) {
  const box = elem('fieldset', { className: 'analysis__set', attrs: { id: 'feedback-comments' } },
    elem('legend', { text: 'Comments and quotations' }),
    elem('p', { className: 'analysis__hint', text: `A comment may stand on its own, and a question needs no comment. A comment is at most ${COMMENT_CHARS} characters; a quoted passage is at most ${QUOTE_CHARS} and must come from the frozen copy.` }));
  model.comments.forEach((comment, index) => box.append(commentBlock(model, comment, index)));
  if (model.comments.length < COMMENT_LIMIT) {
    box.append(elem('div', { className: 'feedback__row-actions' },
      elem('button', { className: 'btn btn--small', attrs: { type: 'button' }, text: 'Add another comment', on: { click: () => addComment() } })
    ));
  }
  return box;
}

function commentBlock(model, comment, index) {
  const block = elem('div', { className: 'feedback__comment' },
    elem('label', { className: 'field', attrs: { for: `feedback-comment-${index}` } },
      elem('span', { className: 'field__label', text: model.comments.length > 1 ? `Comment ${index + 1}` : 'A comment' })
    ),
    elem('textarea', {
      className: 'feedback__text',
      attrs: {
        id: `feedback-comment-${index}`,
        rows: '3',
        maxlength: String(COMMENT_CHARS),
        placeholder: 'What this text does for you, and where it does it…'
      },
      props: { value: comment.text },
      on: { input: (event) => setCommentText(index, event.currentTarget.value) }
    }),
    quotationBlock(model, comment, index)
  );
  if (model.comments.length > 1) {
    block.append(elem('div', { className: 'feedback__row-actions' },
      elem('button', {
        className: 'btn btn--small btn--quiet',
        attrs: { type: 'button' },
        text: 'Remove this comment',
        on: { click: () => removeComment(index) }
      })
    ));
  }
  return block;
}

function quotationBlock(model, comment, index) {
  const box = elem('div', { className: 'feedback__quote' });
  if (comment.evidence) {
    const range = comment.evidence;
    box.append(elem('blockquote', { className: 'feedback__passage' }, elem('p', { text: range.quote })));
    box.append(elem('p', { className: 'feedback__quote-meta', text: `quoted from ${range.file} of the frozen copy, characters ${range.start}–${range.end}` }));
    box.append(elem('div', { className: 'feedback__row-actions' },
      elem('button', {
        className: 'btn btn--small btn--quiet',
        attrs: { type: 'button' },
        text: 'Remove the quotation',
        on: { click: () => removeQuote(index) }
      })
    ));
    return box;
  }
  const selection = bookSelection();
  if (selection) {
    box.append(elem('div', { className: 'feedback__from-book' },
      elem('p', { className: 'analysis__hint', text: `The passage you selected in chapter ${selection.chapter}:` }),
      elem('blockquote', { className: 'feedback__passage feedback__passage--picked' }, elem('p', { text: short(selection.text, 240) })),
      elem('div', { className: 'feedback__row-actions' },
        elem('button', {
          className: 'btn btn--small',
          attrs: { type: 'button' },
          text: 'Quote this passage in this comment',
          on: { click: () => quoteFromBook(index) }
        })
      )
    ));
  } else {
    box.append(elem('p', { className: 'analysis__hint', text: quoteHint(model) }));
  }
  box.append(copyPicker(model, index));
  return box;
}

/**
 * The frozen copy of one chapter, so a passage can be picked with the exact characters of that copy:
 * the reader selects in this pane, and the offsets are read from their own selection.
 */
function copyPicker(model, index) {
  const chapter = model.copyChapter;
  const text = copyText(model, chapter);
  const details = elem('details', { className: 'feedback__copy' },
    elem('summary', { text: text == null ? 'No frozen copy to pick a passage in' : `Pick a passage in the frozen copy of chapter ${chapter}` }));
  if (text == null || !chapterPath(model, chapter)) {
    details.append(elem('p', { className: 'analysis__hint', text: model.frozen
      ? `The text of chapter ${chapter} was not on screen when this questionnaire was frozen, so nothing can be quoted from it here; select the passage in the book instead.`
      : 'This questionnaire is about an earlier version of the book, and the text of that version is not in this browser any more.' }));
    return details;
  }
  details.append(elem('label', { className: 'analysis__inline', attrs: { for: `feedback-copy-select-${index}` } },
    elem('span', { text: 'In chapter' }),
    elem('select', {
      className: 'analysis__select',
      attrs: { id: `feedback-copy-select-${index}` },
      on: { change: (event) => selectCopyChapter(Number(event.currentTarget.value)) }
    }, ...(model.target?.chapters ?? []).map((entry) => elem('option', {
      attrs: { value: String(entry.number), ...(entry.number === chapter ? { selected: true } : {}) },
      text: `Chapter ${entry.number}${entry.title ? ` · ${entry.title}` : ''}`
    })))
  ));
  details.append(elem('p', { className: 'analysis__hint', text: model.copiedFromStore?.has(chapter)
    ? 'This is the frozen text the target itself holds, read from the store because this browser no longer has the version you read; quote from it and the quotation is anchored to the words of that copy.'
    : 'Select the passage here and quote it: the quotation then carries the characters of the frozen copy, exactly as this reader saw them.' }));
  details.append(elem('pre', {
    className: 'feedback__copy-text',
    attrs: { id: `feedback-copy-text-${index}`, 'data-feedback-copy': String(chapter), tabindex: '0' },
    text
  }));
  details.append(elem('div', { className: 'feedback__row-actions' },
    elem('button', {
      className: 'btn btn--small',
      attrs: { type: 'button' },
      text: 'Quote the passage selected here',
      on: { click: () => quoteFromCopy(index) }
    })
  ));
  return details;
}

function conditionsSet(model) {
  return elem('fieldset', { className: 'analysis__set' },
    elem('legend', { text: 'Where you read (optional)' }),
    elem('label', { className: 'field', attrs: { for: 'feedback-where' } },
      elem('span', { className: 'field__label', text: 'Where were you reading?' }),
      elem('input', {
        className: 'analysis__input',
        attrs: {
          id: 'feedback-where',
          type: 'text',
          maxlength: String(WHERE_CHARS),
          placeholder: 'On the train home, in the office, late at night…',
          value: model.where ?? ''
        },
        on: { input: (event) => setWhere(event.currentTarget.value) }
      })
    ),
    elem('p', { className: 'analysis__hint', text: 'Recorded when you give it, never required, and never invented for you.' }),
    exposureSet(model)
  );
}

/**
 * What the reader had already seen before answering. It is a declaration, not an inference: an
 * untouched box stays undeclared, and the store records exactly what was declared, so an unaided
 * reading can never be confused with a report-assisted one later.
 */
function exposureSet(model) {
  const box = elem('div', { className: 'feedback__exposure', attrs: { id: 'feedback-exposure' } },
    elem('p', { className: 'field__label', text: 'Had you already seen, before you answered?' }));
  const line = (name, label) => elem('label', { className: 'feedback__check', attrs: { for: `feedback-exposure-${name}` } },
    elem('input', {
      attrs: {
        id: `feedback-exposure-${name}`,
        type: 'checkbox',
        ...(model.exposure?.[name] === true ? { checked: true } : {})
      },
      on: { change: (event) => setExposure(name, event.currentTarget.checked) }
    }),
    elem('span', { text: label }));
  box.append(line('model_scores', 'The model\'s scores or findings for this text'));
  box.append(line('other_comments', 'Other readers\' comments on this text'));
  box.append(elem('p', { className: 'analysis__hint', id: 'feedback-exposure-state', text: exposureWords(model) }));
  return box;
}

function exposureWords(model) {
  const seen = [];
  if (model.exposure?.model_scores === true) seen.push('the model\'s scores');
  if (model.exposure?.other_comments === true) seen.push('other readers\' comments');
  const declared = model.exposure?.model_scores != null || model.exposure?.other_comments != null;
  if (!declared) return 'Nothing is declared yet, and nothing is assumed for you.';
  return seen.length === 0
    ? 'Recorded as read without having seen a report or other readers\' comments.'
    : `Recorded as having already seen ${seen.join(' and ')} before answering.`;
}

/**
 * The reactions of this response: how useful the report the reader was looking at was, and whether they
 * found a defect in the text. Both are declared by the frozen questionnaire, both are optional, and the
 * usefulness reaction is only offered when this session actually names a report.
 */
function reactionsSet(model) {
  const declared = model.reactionsDeclared ?? [];
  const box = elem('fieldset', { className: 'analysis__set', attrs: { id: 'feedback-reactions' } },
    elem('legend', { text: 'What you made of it (optional)' }));
  if (declared.length === 0) {
    box.append(elem('p', { className: 'analysis__hint', text: 'The frozen copy of this book carries no reaction to give; answer the questions above instead.' }));
    return box;
  }
  for (const reaction of declared) {
    const aboutReport = reaction.about === 'report';
    if (aboutReport && !model.reportRunId) {
      box.append(elem('p', { className: 'analysis__hint', attrs: { id: `feedback-reaction-${reaction.id}-hint` }, text: `${reaction.label} is answered when you open this form from a report; no report is open for this reading, so this reaction is left undeclared.` }));
      continue;
    }
    const chosen = model.reactions?.[reaction.id] ?? null;
    box.append(elem('div', { className: 'feedback__question', attrs: { role: 'group', 'aria-labelledby': `feedback-reaction-${reaction.id}-label` } },
      elem('span', { className: 'feedback__question-label', attrs: { id: `feedback-reaction-${reaction.id}-label` }, text: reaction.label }),
      elem('div', { className: 'feedback__scale' },
        elem('span', { className: 'feedback__anchor', text: reaction.low ?? '' }),
        elem('span', { className: 'feedback__options' }, ...reaction.options.map((option) => elem('label', {
          className: `feedback__option${chosen?.value === option ? ' feedback__option--on' : ''}`,
          attrs: { id: `feedback-reaction-${reaction.id}-${option}`, for: `feedback-reaction-${reaction.id}-${option}-input` }
        },
        elem('input', {
          attrs: {
            type: 'radio',
            id: `feedback-reaction-${reaction.id}-${option}-input`,
            name: `feedback-reaction-${reaction.id}`,
            value: String(option),
            ...(chosen?.value === option ? { checked: true } : {})
          },
          on: { change: () => chooseReaction(reaction.id, option) }
        }),
        elem('span', { className: 'feedback__option-number', text: String(option) })))),
        elem('span', { className: 'feedback__anchor', text: reaction.high ?? '' })
      ),
      chosen ? elem('label', { className: 'field', attrs: { for: `feedback-reaction-${reaction.id}-comment` } },
        elem('span', { className: 'field__label', text: 'Why (optional)' }),
        elem('input', {
          className: 'analysis__input',
          attrs: {
            id: `feedback-reaction-${reaction.id}-comment`,
            type: 'text',
            maxlength: String(ANSWER_COMMENT_CHARS),
            placeholder: 'A sentence, if you want one',
            value: chosen.comment ?? ''
          },
          on: { input: (event) => setReactionComment(reaction.id, event.currentTarget.value) }
        })) : elem('p', { className: 'analysis__hint', text: 'Leave it untouched to record no reaction at all.' })
    ));
  }
  box.append(elem('p', { className: 'analysis__hint', text: 'A reaction is recorded only when you choose one; an untouched reaction stays undeclared and is never read as a low one.' }));
  return box;
}
