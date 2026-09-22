// The A/B reading session of the team's readers (`docs/contracts.md` §8.7): two frozen targets, one
// question, and the preference a reader states between them with its rationale and the conditions they
// read under. The ordinary comparison of `./feedback-comparison.mjs` juxtaposes the descriptive
// distributions the responses already hold; this module records an observation that did not exist
// before, because a preference between two texts is not a rating of either. The invariants:
//
//  - a session names two immutable targets, and a target is written once, so the pair a reader compared
//    cannot change under the record of what they said about it. Both sides are reported with the
//    accepted version and the frozen hash they carry, and a target that is no longer the accepted text
//    is marked `historical` rather than replaced;
//  - the display order is drawn once, when the session is created, from the session's own identifier: the
//    identifier is random for a session the store issues (and naming one makes a session reproducible),
//    and the order is stored, so a refresh of the page shows the two texts in the places the reader saw
//    them and never shuffles them again;
//  - a preference is one of `A`, `B`, `tie` or `unable`. `tie` and `unable` are answers, not missing
//    values: a reader who could not choose or could not tell the two apart has said so, and the counts
//    report them apart from the choices;
//  - the reader's own ratings of the two sides are recorded when they give them, beside the preference
//    and never instead of it: a comparative observation is the two texts read together;
//  - one member of the team is enough to record a session. The document states that it claims no
//    reliability and no effect — a recorded observation is data, and the same store keeps the ordinary
//    descriptive distributions and their counts beside it — so a small team is never prevented from
//    collecting what it has, and no number here is presented as a measurement of a difference;
//  - the exposure conditions travel with the answer: where the reader read, for how long, on what
//    device, how much of the texts they read, which of the two they had seen before and whether a
//    report was in front of them. A comparative reading made after reading an evaluation is not the
//    same evidence as an unaided one, and the record says which it was;
//  - nothing here writes inside `universes/`, and every write is serialized per universe, so two
//    sessions opened at once cannot each write the same record.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { UniverseError } from './errors.mjs';
import { nowIso, readJson, writeJson } from './io.mjs';
import { readFeedbackReader } from './feedback-readers.mjs';
import { LIMITS, feedbackRoot, readFeedbackTarget, readFrozenText } from './feedback-targets.mjs';
import { readJsonBody, sendJson } from './http.mjs';

export const COMPARISON_SESSION_SCHEMA = 'reader-feedback-comparison-session.v1';
export const COMPARISON_RESPONSE_SCHEMA = 'reader-feedback-comparison-response.v1';

/** What a reader may say about two texts: a side, a tie, or that they cannot tell them apart. */
export const PREFERENCES = ['A', 'B', 'tie', 'unable'];

/** Which of the two texts the reader had read before this session. */
export const SEEN_BEFORE = ['neither', 'A', 'B', 'both'];
const READ_KINDS = ['complete', 'partial', 'unknown'];

export const comparisonsRoot = (universeId) => join(feedbackRoot(universeId), 'comparisons');
export const sessionDir = (universeId, sessionId) => join(comparisonsRoot(universeId), sessionId);
export const sessionFile = (universeId, sessionId) => join(sessionDir(universeId, sessionId), 'session.json');
export const sessionResponseFile = (universeId, sessionId) => join(sessionDir(universeId, sessionId), 'response.json');

const SESSION_ID_RE = /^cmp-[a-z0-9][a-z0-9._-]{2,63}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');

const invalid = (message) => new UniverseError('BAD_SESSION', message, 400);
const unknownSession = (sessionId) => new UniverseError('NOT_FOUND', `Unknown comparison session ${sessionId}.`, 404);

// Session creation is serialized per universe the way a submission is in `./feedback-entries.mjs`: the
// lookup, the draw and the write must not interleave, or two simultaneous openings would each write a
// session of their own for one reader.
const chains = new Map();

function serialize(universeId, work) {
  const previous = chains.get(universeId) ?? Promise.resolve();
  const next = previous.then(work, work);
  chains.set(universeId, next.then(() => undefined, () => undefined));
  return next;
}

/**
 * The display order of one session: the side shown on the left first. It is drawn from the identifier
 * when the session is created — random for the identifier the store issues — and stored, so a refresh
 * reads the same order instead of drawing a new one.
 */
const orderOf = (sessionId) => (Number.parseInt(digest(`order|${sessionId}`).slice(0, 8), 16) % 2 === 0 ? ['A', 'B'] : ['B', 'A']);

const issuedSessionId = () => `cmp-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;

export const isComparisonSessionId = (sessionId) => typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);

/** The declared question of a target, or `null`: what the reader is asked to answer about the pair. */
const questionOf = (target, questionId) => (target.questionnaire?.questions ?? []).find((question) => question.id === questionId) ?? null;

/** One side of a session: the target, the version it froze, and the hash a reader of it saw. */
const sideOf = (target) => ({
  target_id: target.target_id,
  accepted_version: target.source_version,
  historical: target.historical ?? null,
  scope: target.scope ?? null,
  language: target.language ?? null,
  questionnaire_version: target.questionnaire?.version ?? null,
  displayed_hash: target.displayed?.hash ?? null,
  // The displayed files travel with the side, so a surface can name the frozen copy it is showing and
  // ask the store for it by the path the target recorded.
  files: (target.displayed?.files ?? []).map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
  chapters: (target.chapters ?? []).map((chapter) => ({ number: chapter.number, title: chapter.title, path: chapter.path, sha256: chapter.sha256 }))
});

/** The pair of targets of a session, sorted, so two sessions over the same two texts can be tallied. */
const pairKeyOf = (session) => [session.targets.A.target_id, session.targets.B.target_id].sort().join('|');

/** Where and how one reading happened: recorded when given, never required, never invented. */
function checkConditions(raw) {
  if (raw === null || raw === undefined) {
    return { where: null, duration_minutes: null, device: null, read: null, seen_before: null, saw_report: null };
  }
  const source = typeof raw === 'object' ? raw : {};
  const text = (value, max, what) => {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (trimmed.length > max) throw invalid(`The ${what} of a reading is at most ${max} characters.`);
    return trimmed.length === 0 ? null : trimmed;
  };
  const where = text(source.where, LIMITS.whereChars, 'place');
  const device = text(source.device, LIMITS.deviceChars, 'device');
  const minutes = source.duration_minutes === null || source.duration_minutes === undefined
    ? null
    : Number.parseInt(source.duration_minutes, 10);
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60)) {
    throw invalid('How long a reading took is a whole number of minutes between 0 and 1440.');
  }
  const read = source.read === null || source.read === undefined ? null : String(source.read);
  if (read !== null && !READ_KINDS.includes(read)) throw invalid(`How much was read is one of ${READ_KINDS.join(', ')}.`);
  const seen = source.seen_before === null || source.seen_before === undefined ? null : String(source.seen_before);
  if (seen !== null && !SEEN_BEFORE.includes(seen)) throw invalid(`Which text was read before is one of ${SEEN_BEFORE.join(', ')}.`);
  const sawReport = source.saw_report === null || source.saw_report === undefined ? null : source.saw_report === true;
  return { where, duration_minutes: minutes, device, read, seen_before: seen, saw_report: sawReport };
}

/** The ratings a reader gave the two sides when they chose to give them: declared options, or `null`. */
function checkRatings(raw, question) {
  if (raw === null || raw === undefined) return { A: null, B: null };
  const source = typeof raw === 'object' ? raw : {};
  const declared = (question.options ?? []).map((option) => String(option));
  const one = (value, side) => {
    if (value === null || value === undefined) return null;
    if (!declared.includes(String(value))) {
      throw invalid(`The rating of side ${side} is one of ${declared.join(', ')} as the questionnaire declares them, or nothing.`);
    }
    return typeof value === 'number' ? value : Number(value);
  };
  return { A: one(source.A, 'A'), B: one(source.B, 'B') };
}

/** The session as a reader and a UI read it: the record, the answer if there is one, and the tally. */
function view(session, response, counts) {
  return {
    ...session,
    display: { ...session.display, left: session.display.order[0], right: session.display.order[1] },
    response,
    counts
  };
}

/** How many sessions and answers exist for one pair of texts, by position and by role, never summed. */
function countsOf(sessions, responses, { questionId = null, pair = null } = {}) {
  const scoped = sessions.filter((session) => (questionId === null || session.question.question_id === questionId)
    && (pair === null || pairKeyOf(session) === pair));
  const mine = responses.filter((response) => scoped.some((session) => session.session_id === response.session_id));
  const zeroes = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
  const byPosition = zeroes(['left', 'right', 'tie', 'unable']);
  const byRole = zeroes(PREFERENCES);
  const orders = zeroes(['A,B', 'B,A']);
  for (const session of scoped) orders[session.display.order.join(',')] += 1;
  for (const response of mine) {
    byRole[response.preference] += 1;
    const position = response.preference === 'tie' || response.preference === 'unable'
      ? response.preference
      : (response.display.order[0] === response.preference ? 'left' : 'right');
    byPosition[position] += 1;
  }
  return {
    sessions: scoped.length,
    responses: mine.length,
    orders,
    by_position: byPosition,
    by_role: byRole,
    note: 'the two tallies are reported apart on purpose: the display order is drawn per session, so a reader who chose the text on the left and a reader who chose role A did not say the same thing. These are counts of recorded observations, and the store states no effect and no reliability from them'
  };
}

/** Every session record of a book, oldest first, every directory that holds one. */
async function readSessions(universeId) {
  const folder = comparisonsRoot(universeId);
  const names = await readdir(folder).catch(() => []);
  const sessions = [];
  for (const name of [...names].sort()) {
    if (!isComparisonSessionId(name)) continue;
    const record = await readJson(sessionFile(universeId, name), null);
    if (record) sessions.push(record);
  }
  return sessions;
}

/** The stored answer of one session, or `null`. */
async function readResponse(universeId, sessionId) {
  return readJson(sessionResponseFile(universeId, sessionId), null);
}

/**
 * Open an A/B session over two frozen targets for one reader. The two texts must be different targets of
 * this book, and both must declare the question the reader is asked about them — with the same options,
 * because two scales are not a comparison. The display order is drawn here and stored. `404 NOT_FOUND`
 * for a target or a reader this book does not have, `400 BAD_SESSION` for two names that are not two
 * different targets of a shared question, and `409 READER_DELETED` for an identity that asked to be
 * deleted.
 */
export async function startComparisonSession({
  universeId,
  questionId = null,
  targetId = null,
  otherTargetId = null,
  readerId = null,
  sessionId = null
}) {
  const asked = String(questionId ?? '').trim();
  const first = String(targetId ?? '').trim();
  const second = String(otherTargetId ?? '').trim();
  if (!asked || !first || !second) {
    throw invalid('A comparison session names one question and two different targets (`question`, `target`, `otherTarget`).');
  }
  if (first === second) throw invalid('A comparison session compares two different readings; both sides name the same target.');
  const reader = await readFeedbackReader(universeId, readerId);
  if (reader.deleted_at) {
    throw new UniverseError('READER_DELETED', `Reader ${reader.reader_id} asked for their identity to be deleted, so no new reading is opened for it.`, 409);
  }
  const left = await readFeedbackTarget(universeId, first);
  const right = await readFeedbackTarget(universeId, second);
  const question = questionOf(left, asked);
  const other = questionOf(right, asked);
  if (question === null || other === null) {
    const missing = question === null ? first : second;
    throw invalid(`The target ${missing} does not declare the question ${asked}, so the two readings cannot be compared on it.`);
  }
  if ((question.options ?? []).join(',') !== (other.options ?? []).join(',')) {
    throw invalid(`The two targets declare ${asked} on different scales (${(question.options ?? []).join(', ')} and ${(other.options ?? []).join(', ')}); a session compares two readings of one question, never two scales.`);
  }
  const id = sessionId === null || sessionId === undefined || sessionId === '' ? issuedSessionId() : String(sessionId);
  if (!isComparisonSessionId(id)) throw invalid('A comparison session identifier has the form cmp-… (three to 64 characters of letters, digits, dots, dashes or underscores).');
  const pair = [left.target_id, right.target_id].sort().join('|');
  return serialize(universeId, async () => {
    const existing = await readJson(sessionFile(universeId, id), null);
    if (existing) {
      const same = existing.reader.reader_id === reader.reader_id
        && existing.question.question_id === asked
        && pairKeyOf(existing) === pair;
      if (!same) throw new UniverseError('CONFLICT', `Comparison session ${id} already exists for another pair or reader.`, 409);
      return { session: await readComparisonSession(universeId, id), deduplicated: true };
    }
    const record = {
      schema_version: COMPARISON_SESSION_SCHEMA,
      session_id: id,
      universe_id: universeId,
      created_at: nowIso(),
      reader: { reader_id: reader.reader_id, display_name: reader.display_name, kind: reader.kind },
      question: {
        question_id: question.id,
        label: question.label,
        low: question.low ?? null,
        high: question.high ?? null,
        options: question.options ?? [],
        questionnaire_version: left.questionnaire?.version ?? null
      },
      same_questionnaire: (left.questionnaire?.version ?? null) === (right.questionnaire?.version ?? null),
      targets: { A: sideOf(left), B: sideOf(right) },
      display: {
        order: orderOf(id),
        drawn_from: 'the session identifier, once, when the session was created',
        note: 'the order is stored with the session, so a refresh shows the two texts in the places the reader saw them and never shuffles them again'
      },
      measurement: {
        claimed: false,
        reason: 'a recorded session is one reader\'s comparative observation of two texts, not a measurement of a difference: the store claims no effect and no reliability from it, states the counts it has, and keeps the ordinary descriptive distributions beside them'
      }
    };
    await mkdir(sessionDir(universeId, id), { recursive: true });
    await writeJson(sessionFile(universeId, id), record);
    return { session: view(record, null, countsOf(await readSessions(universeId), [], { questionId: asked, pair: pairKeyOf(record) })), deduplicated: false };
  });
}

/**
 * One session with its answer and the tally of the pair it belongs to, or `404 NOT_FOUND`. The display
 * order is the one stored when the session was created.
 */
export async function readComparisonSession(universeId, sessionId) {
  if (!isComparisonSessionId(sessionId)) throw unknownSession(sessionId);
  const record = await readJson(sessionFile(universeId, sessionId), null);
  if (!record) throw unknownSession(sessionId);
  const sessions = await readSessions(universeId);
  const responses = (await Promise.all(sessions.map((session) => readResponse(universeId, session.session_id)))).filter((entry) => entry !== null);
  return view(record, await readResponse(universeId, sessionId), countsOf(sessions, responses, {
    questionId: record.question.question_id,
    pair: pairKeyOf(record)
  }));
}

/** The sessions of one book, oldest first, or the ones of one target; each with its tally. */
export async function listComparisonSessions(universeId, { targetId = null } = {}) {
  const wanted = targetId === null || targetId === undefined ? null : String(targetId);
  const sessions = await readSessions(universeId);
  const responses = (await Promise.all(sessions.map((session) => readResponse(universeId, session.session_id)))).filter((entry) => entry !== null);
  return sessions
    .filter((session) => wanted === null || session.targets.A.target_id === wanted || session.targets.B.target_id === wanted)
    .map((session) => view(session, responses.find((response) => response.session_id === session.session_id) ?? null, countsOf(sessions, responses, {
      questionId: session.question.question_id,
      pair: pairKeyOf(session)
    })));
}

/** The preferences recorded for one question over one pair of texts, counted for what they are. */
export async function listComparisonResponses(universeId, { targetId = null, otherTargetId = null } = {}) {
  const sessions = await listComparisonSessions(universeId, { targetId });
  const wanted = otherTargetId === null || otherTargetId === undefined ? null : String(otherTargetId);
  return sessions
    .filter((session) => wanted === null || session.targets.A.target_id === wanted || session.targets.B.target_id === wanted)
    .map((session) => session.response)
    .filter((response) => response !== null);
}

/**
 * Record what one reader said about the two texts of their session: a preference, the rationale they
 * gave for it, the ratings they chose to give each side, and the conditions they read under. One member
 * of the team is enough — the answer is an observation and the document says so — and a second answer to
 * the same session is the same answer (`deduplicated`) or `409 CONFLICT`, never a second opinion.
 */
export async function recordComparisonPreference({
  universeId,
  sessionId = null,
  preference = null,
  rationale = null,
  ratings = null,
  conditions = null,
  readerId = null
}) {
  const id = String(sessionId ?? '').trim();
  if (!isComparisonSessionId(id)) throw unknownSession(id);
  const chosen = String(preference ?? '').trim();
  if (!PREFERENCES.includes(chosen)) {
    throw invalid(`A comparison is ${PREFERENCES.join(', ')} (received ${chosen || 'nothing'}): a reader who cannot tell the two texts apart has said something and it is recorded as such.`);
  }
  const text = rationale === null || rationale === undefined ? null : String(rationale).trim();
  if (text !== null && text.length > LIMITS.commentChars) {
    throw invalid(`The rationale of a comparison is at most ${LIMITS.commentChars} characters.`);
  }
  return serialize(universeId, async () => {
    const session = await readJson(sessionFile(universeId, id), null);
    if (!session) throw unknownSession(id);
    if (readerId !== null && readerId !== undefined && String(readerId) !== session.reader.reader_id) {
      throw new UniverseError('BAD_SESSION', `Comparison session ${id} belongs to reader ${session.reader.reader_id}; an answer cannot be attributed to another identity.`, 400);
    }
    const question = session.question;
    const normalized = {
      schema_version: COMPARISON_RESPONSE_SCHEMA,
      response_id: `${id}-answer`,
      session_id: id,
      universe_id: universeId,
      reader: session.reader,
      question: { question_id: question.question_id, questionnaire_version: question.questionnaire_version },
      preference: chosen,
      rationale: text === null || text.length === 0 ? null : text,
      ratings: checkRatings(ratings, question),
      conditions: checkConditions(conditions),
      // The places the reader saw are repeated with the answer, so the answer is readable on its own and
      // its position can be checked against the record of the session it belongs to.
      display: session.display,
      answered_at: nowIso()
    };
    const submission = digest(JSON.stringify({ ...normalized, answered_at: null }));
    const existing = await readJson(sessionResponseFile(universeId, id), null);
    if (existing) {
      // The same answer submitted twice is the same answer: the identity of the content is the digest
      // the record was written with, so a retry after a lost connection answers the record that exists.
      if (existing.submission_sha256 === submission) return { response: existing, deduplicated: true };
      throw new UniverseError('CONFLICT', `Comparison session ${id} already holds a different answer.`, 409);
    }
    await writeJson(sessionResponseFile(universeId, id), { ...normalized, submission_sha256: submission });
    const sessions = await readSessions(universeId);
    const responses = (await Promise.all(sessions.map((each) => readResponse(universeId, each.session_id)))).filter((entry) => entry !== null);
    return {
      response: { ...normalized, submission_sha256: submission },
      session: view(session, { ...normalized, submission_sha256: submission }, countsOf(sessions, responses, {
        questionId: session.question.question_id,
        pair: pairKeyOf(session)
      })),
      deduplicated: false
    };
  });
}

/**
 * The HTTP surface of the sessions, for the host router (`docs/contracts.md` §8.7):
 *
 *   POST   /api/universes/:id/feedback/sessions            {question,target,otherTarget,readerId} → 201 {session}
 *   GET    /api/universes/:id/feedback/sessions[?target=]  → 200 {sessions}
 *   GET    /api/universes/:id/feedback/sessions/:sessionId → 200 {session}
 *   POST   /api/universes/:id/feedback/sessions/:sessionId {preference,rationale,ratings,conditions} → 201 {session}
 *
 * It answers `true` when it handled the request, so the router can fall through for its own segments.
 */
export async function handleComparisonSessionRoutes({ req, res, id, sessionId = null, url = null }) {
  if (sessionId === null) {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const { session, deduplicated } = await startComparisonSession({
        universeId: id,
        questionId: body?.question ?? body?.questionId ?? null,
        targetId: body?.target ?? body?.targetId ?? null,
        otherTargetId: body?.otherTarget ?? body?.otherTargetId ?? null,
        readerId: body?.readerId ?? null,
        sessionId: body?.sessionId ?? null
      });
      sendJson(res, deduplicated ? 200 : 201, { session });
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { sessions: await listComparisonSessions(id, { targetId: url?.searchParams?.get('target') ?? null }) });
      return true;
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }
  if (req.method === 'GET') {
    sendJson(res, 200, { session: await readComparisonSession(id, sessionId) });
    return true;
  }
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    const { session, deduplicated } = await recordComparisonPreference({
      universeId: id,
      sessionId,
      preference: body?.preference ?? null,
      rationale: body?.rationale ?? null,
      ratings: body?.ratings ?? null,
      conditions: body?.conditions ?? null
    });
    sendJson(res, deduplicated ? 200 : 201, { session });
    return true;
  }
  throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
}

/** The frozen text of one side of a session, read from the target the session names. */
export async function readSessionSide(universeId, session, role) {
  const side = session?.targets?.[role] ?? null;
  if (!side) throw invalid(`A session has two sides, A and B (received ${role}).`);
  const target = await readFeedbackTarget(universeId, side.target_id);
  const file = (target.displayed?.files ?? [])[0] ?? null;
  const frozen = file === null ? null : await readFrozenText(universeId, target, file.path);
  return { side, file, text: frozen?.text ?? null };
}
