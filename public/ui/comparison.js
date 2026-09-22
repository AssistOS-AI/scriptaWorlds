/**
 * scriptaWorlds — the A/B reading session surface (`docs/contracts.md` §8.7): two frozen readings of one
 * book on one question, the order they are shown in, and the preference a reader states between them with
 * its rationale and the conditions they read under.
 *
 * Every fact here comes from the store. The session document carries the two targets, the accepted
 * version each one froze, their hashes and the display order that was drawn when the session opened, and
 * the text of each side is fetched from the frozen copy of its own target: a refresh therefore shows the
 * same two texts in the same places, and a historical side shows the prose its reader was actually given
 * rather than the chapter as it stands today. What a reader records here is an observation and not a
 * measurement — one member of a team is enough to record one — so the count of what was recorded is shown
 * by place and by role, apart, and no preference is ever added to a rating.
 */
import { api } from './api.js';
import { elem, plural, state } from './state.js';

/** The four answers of a comparison. A tie and an `unable` are answers, never missing values. */
const PREFERENCES = [
  { value: 'A', label: 'The text in role A' },
  { value: 'B', label: 'The text in role B' },
  { value: 'tie', label: 'Neither was better' },
  { value: 'unable', label: 'I could not tell them apart' }
];

const READ_OPTIONS = [['complete', 'read in full'], ['partial', 'read in part'], ['unknown', 'did not say']];
const SEEN_OPTIONS = [['neither', 'neither of the two'], ['A', 'the text in role A'], ['B', 'the text in role B'], ['both', 'both of them']];

const short = (value) => (typeof value === 'string' && value.length > 18 ? `${value.slice(0, 18)}…` : String(value ?? ''));

/** One scope in words, so a comparison is never read as being about some other text. */
function scopeLabel(scope) {
  const chapters = (scope?.chapters ?? []).join(', ');
  if (scope?.kind === 'book') return `the whole book (chapters ${chapters})`;
  if (scope?.kind === 'arc') return `an arc (chapters ${chapters})`;
  if (scope?.kind === 'chapter') return (scope.chapters ?? []).length === 1 ? `chapter ${chapters}` : `chapters ${chapters}`;
  return 'an unnamed scope';
}

/** One side in words: what was read, in which language, with which questionnaire, and how old it is. */
const sideLabel = (side) => `${scopeLabel(side.scope)} of ${short(side.accepted_version)} in ${side.language ?? 'an unknown language'} with ${side.questionnaire_version ?? 'an unknown questionnaire'}${side.historical === true ? ', an earlier version of the book' : ''}`;

/** The three routes of the sessions (`docs/contracts.md` §8.7). */
const sessionUrl = (universeId, sessionId = null) =>
  `/api/universes/${encodeURIComponent(universeId)}/feedback/sessions${sessionId === null ? '' : `/${encodeURIComponent(sessionId)}`}`;

/** The frozen bytes of one displayed file of one side, or `null` when the store does not serve it. */
function frozenText(universeId, side, file) {
  const name = String(file.path).split('/').pop();
  return api(
    `/api/universes/${encodeURIComponent(universeId)}/feedback/targets/${encodeURIComponent(side.target_id)}/text/${encodeURIComponent(name)}`,
    { text: true }
  ).then((body) => (typeof body === 'string' && body.length > 0 ? body : null), () => null);
}

/** The text of both sides, each from the frozen copy of its own target. */
async function loadTexts(model) {
  const sides = model.session?.targets ?? null;
  if (sides === null) return;
  for (const role of ['A', 'B']) {
    const file = (sides[role].files ?? [])[0] ?? null;
    model.texts[role] = file === null ? null : await frozenText(model.universeId, sides[role], file);
  }
}

/** The targets and the reader identities a session can be opened with, and a first choice of both. */
async function loadChoices(model) {
  const listing = await api(`/api/universes/${encodeURIComponent(model.universeId)}/feedback`).catch(() => null);
  const readers = await api(`/api/universes/${encodeURIComponent(model.universeId)}/readers`).catch(() => null);
  model.targets = listing?.targets ?? [];
  model.readers = readers?.readers ?? [];
  if (model.targetId === null && model.targets.length > 0) model.targetId = model.targets[0].target_id;
  if (model.otherTargetId === null) {
    const other = model.targets.find((target) => target.target_id !== model.targetId);
    model.otherTargetId = other?.target_id ?? null;
  }
  if (model.readerId === null) {
    const team = model.readers.filter((reader) => reader.kind === 'team_human' && !reader.deleted_at);
    model.readerId = (team[0] ?? model.readers[0])?.reader_id ?? null;
  }
  if (model.questionId === null) model.questionId = 'interest';
  return model;
}

/** The questions both named targets declare, with the same options: only those can be compared. */
async function sharedQuestions(model) {
  if (!model.targetId || !model.otherTargetId || model.targetId === model.otherTargetId) return [];
  const read = (targetId) => api(`/api/universes/${encodeURIComponent(model.universeId)}/feedback/targets/${encodeURIComponent(targetId)}`)
    .then((payload) => payload?.target ?? null, () => null);
  const [left, right] = await Promise.all([read(model.targetId), read(model.otherTargetId)]);
  const mine = left?.questionnaire?.questions ?? [];
  const theirs = new Map((right?.questionnaire?.questions ?? []).map((question) => [question.id, question]));
  return mine
    .filter((question) => theirs.has(question.id) && (theirs.get(question.id).options ?? []).join(',') === (question.options ?? []).join(','))
    .map((question) => ({ ...question, questionnaire_version: left.questionnaire.version }));
}

/* --------------------------------------------------------------- render */

function renderError(model) {
  return model.error === null ? null : elem('p', { className: 'feedback__notice', text: model.error });
}

/** One labelled control row: the label above the control, the way the questionnaire is drawn. */
function field(label, control) {
  return elem('label', { className: 'feedback__row' },
    elem('span', { className: 'feedback__question-label', text: label }),
    control
  );
}

/** A select over `[value, label]` pairs, with one value chosen and one handler. */
function select(options, value, on) {
  return elem('select', { className: 'feedback__option', on: { change: on } },
    ...options.map(([optionValue, optionLabel]) => elem('option', {
      text: optionLabel,
      props: { value: optionValue, selected: optionValue === value }
    }))
  );
}

/** The form that opens a session: two frozen readings, one shared question, one reader. */
function renderChooser(model) {
  const questions = model.shared ?? [];
  const targetOptions = model.targets.map((target) => [target.target_id,
    `${scopeLabel(target.scope)} · ${short(target.source_version)}${target.historical === true ? ' (earlier version)' : ''}`]);
  const readerOptions = model.readers.map((reader) => [reader.reader_id, `${reader.display_name} (${reader.kind})`]);
  return elem('div', { className: 'feedback__question' },
    elem('p', { className: 'feedback__ask', text: 'Compare two frozen readings of this book on one question. The order the two texts are shown in is drawn when the session opens and kept, so a refresh shows the same two texts in the same places.' }),
    field('First reading (role A)', select(targetOptions, model.targetId, (event) => {
      model.targetId = event.target.value;
      void refresh(model);
    })),
    field('Second reading (role B)', select(targetOptions, model.otherTargetId, (event) => {
      model.otherTargetId = event.target.value;
      void refresh(model);
    })),
    questions.length === 0
      ? elem('p', { className: 'analysis__hint', text: 'These two readings do not declare one question on the same scale, so nothing can be compared between them. Choose two readings of the same questionnaire.' })
      : field('Question', select(questions.map((question) => [question.id, `${question.label} (${question.questionnaire_version})`]), model.questionId, (event) => {
        model.questionId = event.target.value;
        render(model);
      })),
    readerOptions.length === 0
      ? elem('p', { className: 'analysis__hint', text: 'This book has no reader identity yet; a session is opened by one reader, so create one in the questionnaire first.' })
      : field('Reader', select(readerOptions, model.readerId, (event) => {
        model.readerId = event.target.value;
        render(model);
      })),
    elem('div', { className: 'feedback__row-actions' },
      elem('button', {
        className: 'feedback__option',
        text: model.busy ? 'Opening…' : 'Open the session',
        props: { disabled: model.busy || questions.length === 0 || model.readerId === null || model.targetId === model.otherTargetId },
        on: { click: () => void open(model) }
      }),
      model.targetId === model.otherTargetId
        ? elem('span', { className: 'analysis__hint', text: 'A session compares two different readings of this book.' })
        : null
    )
  );
}

/** One side as the reader sees it: what it is, which bytes it is, and its frozen text. */
function renderSide(model, role, place) {
  const side = model.session.targets[role];
  const text = model.texts[role];
  const files = side.files ?? [];
  return elem('div', { className: 'feedback__response' },
    elem('p', { className: 'feedback__question-label', text: `${place} · role ${role}` }),
    elem('p', { className: 'feedback__meta', text: sideLabel(side) }),
    elem('p', { className: 'feedback__meta', text: `frozen copy ${side.displayed_hash ?? 'unnamed'} · target ${side.target_id}` }),
    elem('p', { className: 'feedback__meta', text: `${plural(files.length, 'file')}: ${files.map((file) => `${file.path} (${String(file.sha256).slice(0, 12)}…)`).join(', ')}` }),
    text === null
      ? elem('p', { className: 'analysis__hint', text: 'The frozen text of this reading is not served by the store right now; the hashes above name exactly which bytes this side is.' })
      : elem('details', { className: 'feedback__copy' },
        elem('summary', { text: `Read the frozen copy of ${scopeLabel(side.scope)}` }),
        elem('pre', { className: 'feedback__copy-text', text })
      )
  );
}

/** The four answers, the rationale, the optional ratings of each side and the reading conditions. */
function renderAnswer(model) {
  const session = model.session;
  const question = session.question;
  const form = model.form ?? (model.form = { preference: null, rationale: null, ratings: { A: null, B: null }, conditions: {} });
  const rating = (side, label) => field(label, select(
    [['', 'not given'], ...(question.options ?? []).map((option) => [String(option), String(option)])],
    form.ratings[side] === null ? '' : String(form.ratings[side]),
    (event) => { form.ratings[side] = event.target.value === '' ? null : Number.parseInt(event.target.value, 10); }
  ));
  const text = (label, value, on) => field(label, elem('input', {
    className: 'feedback__comment',
    props: { type: 'text', value: value ?? '' },
    on: { input: on }
  }));
  const pick = (label, options, value, on) => field(label, select(
    [['', 'not given'], ...options],
    value ?? '',
    (event) => on(event.target.value === '' ? null : event.target.value)
  ));
  const conditions = form.conditions;
  return elem('div', { className: 'feedback__question' },
    elem('p', { className: 'feedback__ask', text: `Which of the two readings answers "${question.label}" better?` }),
    elem('p', { className: 'feedback__meta', text: 'A tie and an inability to tell the two apart are answers of their own, and both are recorded as such.' }),
    elem('div', { className: 'feedback__options' },
      ...PREFERENCES.map((preference) => {
        const placed = preference.value === 'A' || preference.value === 'B'
          ? session.display.left === preference.value ? 'shown on the left' : 'shown on the right'
          : null;
        const chosen = form.preference === preference.value;
        return elem('button', {
          className: `feedback__option${chosen ? ' feedback__option--on' : ''}`,
          text: placed === null ? preference.label : `${preference.label} (${placed})`,
          props: { disabled: model.busy },
          attrs: { 'aria-pressed': chosen ? 'true' : 'false' },
          on: {
            click: () => {
              form.preference = preference.value;
              render(model);
            }
          }
        });
      })
    ),
    field('Why (optional)', elem('textarea', {
      className: 'feedback__comment',
      props: { value: form.rationale ?? '' },
      on: { input: (event) => { form.rationale = event.target.value; } }
    })),
    rating('A', 'Your rating of the reading in role A'),
    rating('B', 'Your rating of the reading in role B'),
    text('Where you read', conditions.where, (event) => { conditions.where = event.target.value; }),
    text('On what device', conditions.device, (event) => { conditions.device = event.target.value; }),
    pick('How much of the two you read', READ_OPTIONS, conditions.read, (value) => { conditions.read = value; }),
    pick('Which of the two you had read before', SEEN_OPTIONS, conditions.seen_before, (value) => { conditions.seen_before = value; }),
    elem('div', { className: 'feedback__row-actions' },
      elem('button', {
        className: 'feedback__option',
        text: model.busy ? 'Recording…' : 'Record this answer',
        props: { disabled: model.busy || form.preference === null },
        on: { click: () => void answer(model, form.preference) }
      }),
      form.preference === null
        ? elem('span', { className: 'analysis__hint', text: 'Choose one of the four answers above; a tie and an inability to tell the two apart are recorded as what they are.' })
        : null
    )
  );
}

/** What the reader said, once it is recorded: the preference with its place and the conditions. */
function renderRecorded(model, response) {
  const session = model.session;
  const chosen = PREFERENCES.find((preference) => preference.value === response.preference)?.label ?? response.preference;
  const place = response.preference === 'A' || response.preference === 'B'
    ? (response.display.left === response.preference ? 'shown on the left' : 'shown on the right')
    : 'neither side chosen';
  const ratings = response.ratings ?? { A: null, B: null };
  return elem('div', { className: 'feedback__question' },
    elem('p', { className: 'feedback__ask', text: `Recorded: ${chosen} (${place}).` }),
    response.rationale === null ? null : elem('p', { className: 'feedback__comment-text', text: response.rationale }),
    elem('p', { className: 'feedback__meta', text: `Your ratings: role A ${ratings.A ?? 'not given'}, role B ${ratings.B ?? 'not given'}. This preference is not a rating and the two are never added together.` }),
    elem('p', { className: 'feedback__meta', text: `Read ${response.conditions?.read ?? 'without saying how much'}, ${response.conditions?.where ?? 'without saying where'}, on ${response.conditions?.device ?? 'an unnamed device'}; before this session you had read ${response.conditions?.seen_before ?? 'an undeclared part'} of the two.` }),
    elem('p', { className: 'feedback__meta', text: `Recorded ${response.answered_at ?? 'at an unrecorded time'} as ${response.response_id}. One session holds one answer: open a new session to read the two texts again.` })
  );
}

/** What has been recorded for this pair, by place and by role, never added together. */
function renderTally(model) {
  const counts = model.session?.counts ?? null;
  if (counts === null) return null;
  const byRole = PREFERENCES.map((preference) => `${preference.value} ${counts.by_role[preference.value] ?? 0}`).join(' · ');
  const place = counts.by_position ?? {};
  return elem('div', { className: 'feedback__counts' },
    elem('p', { className: 'feedback__meta', text: `${plural(counts.sessions, 'session')} opened on this pair of readings, ${plural(counts.responses, 'answer')} recorded.` }),
    elem('p', { className: 'feedback__meta', text: `By role: ${byRole}` }),
    elem('p', { className: 'feedback__meta', text: `By place: left ${place.left ?? 0} · right ${place.right ?? 0} · tie ${place.tie ?? 0} · unable ${place.unable ?? 0}. The order is drawn per session, so the two tallies are not the same observation.` }),
    elem('p', { className: 'analysis__hint', text: 'These are counts of recorded observations, not a measurement of a difference between the two texts.' })
  );
}

/** One session: the two sides in the order they were drawn, then the answer or the form for it. */
function renderSession(model) {
  const session = model.session;
  return elem('div', { className: 'feedback__question' },
    elem('p', { className: 'feedback__question-label', text: `${session.question.label} · questionnaire ${session.question.questionnaire_version}` }),
    elem('p', { className: 'feedback__meta', text: `Session ${session.session_id}, opened by ${session.reader.display_name} (${session.reader.kind}) — the two texts are shown ${session.display.left === 'A' ? 'A then B' : 'B then A'} and stay that way on every refresh.` }),
    elem('div', { className: 'feedback__answers' },
      renderSide(model, session.display.left, 'The text on the left'),
      renderSide(model, session.display.right, 'The text on the right')
    ),
    session.response === null ? renderAnswer(model) : renderRecorded(model, session.response),
    renderTally(model),
    elem('div', { className: 'feedback__row-actions' },
      elem('button', {
        className: 'feedback__option',
        text: 'New session',
        props: { disabled: model.busy },
        on: { click: () => void restart(model) }
      })
    )
  );
}

/** The whole surface from the model: chooser, session, and whatever went wrong, in that order. */
function render(model) {
  const container = model.container;
  if (!container) return;
  const parts = [model.session === null ? renderChooser(model) : renderSession(model), renderError(model)];
  container.replaceChildren(...parts.filter((part) => part !== null && part !== undefined));
}

/* -------------------------------------------------------------- actions */

/** Re-read what the two chosen readings share, then draw the chooser again. */
async function refresh(model) {
  model.shared = await sharedQuestions(model);
  if (model.shared.length > 0 && !model.shared.some((question) => question.id === model.questionId)) {
    model.questionId = model.shared[0].id;
  }
  render(model);
}

/** Open the session the chooser describes and read the two frozen texts of its sides. */
async function open(model) {
  model.busy = true;
  model.error = null;
  render(model);
  try {
    const payload = await api(sessionUrl(model.universeId), {
      method: 'POST',
      body: {
        question: model.questionId,
        target: model.targetId,
        otherTarget: model.otherTargetId,
        readerId: model.readerId
      }
    });
    model.session = payload?.session ?? null;
    model.form = null;
    await loadTexts(model);
  } catch (error) {
    model.error = error?.message ?? String(error);
  }
  model.busy = false;
  render(model);
}

/** Record the reader's answer to the session, with the rationale and the conditions they gave. */
async function answer(model, preference) {
  model.busy = true;
  model.error = null;
  const form = model.form ?? { rationale: null, ratings: { A: null, B: null }, conditions: {} };
  try {
    const payload = await api(sessionUrl(model.universeId, model.session.session_id), {
      method: 'POST',
      body: {
        preference,
        rationale: form.rationale,
        ratings: form.ratings,
        conditions: form.conditions
      }
    });
    model.session = payload?.session ?? model.session;
  } catch (error) {
    model.error = error?.message ?? String(error);
  }
  model.busy = false;
  render(model);
}

/** Start over: the chooser again, with the same two readings and the same reader selected. */
async function restart(model) {
  model.session = null;
  model.form = null;
  model.error = null;
  render(model);
}

/* ---------------------------------------------------------------- mount */

/**
 * Draw the comparison surface into `container` and return the model it holds. It reads the universe from
 * `state`, resolves its own choices through the ordinary feedback routes, and never throws: a failure is
 * shown in the surface instead of leaving the panel empty.
 */
export async function mountComparison(container, options = {}) {
  const model = {
    container,
    universeId: options.universeId ?? state.universeId,
    questionId: options.questionId ?? null,
    targetId: options.targetId ?? null,
    otherTargetId: options.otherTargetId ?? null,
    readerId: options.readerId ?? null,
    sessionId: options.sessionId ?? null,
    targets: [],
    readers: [],
    shared: [],
    texts: { A: null, B: null },
    session: null,
    form: null,
    error: null,
    busy: false
  };
  if (!model.universeId) {
    container.replaceChildren(elem('p', { className: 'feedback__notice', text: 'Open a book before comparing two of its readings.' }));
    return model;
  }
  container.replaceChildren(elem('p', { className: 'feedback__meta', text: 'Reading the readings of this book…' }));
  try {
    if (model.sessionId !== null) {
      const payload = await api(sessionUrl(model.universeId, model.sessionId));
      model.session = payload?.session ?? null;
      if (model.session === null) model.error = `Unknown comparison session ${model.sessionId}.`;
      await loadTexts(model);
    } else {
      await loadChoices(model);
      await refresh(model);
    }
  } catch (error) {
    model.error = error?.message ?? String(error);
  }
  render(model);
  return model;
}
