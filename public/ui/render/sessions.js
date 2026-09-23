/**
 * scriptaWorlds — The sessions dialog: the list of every run of the open book — the turns ALA wrote a
 * chapter, an edition or an import in, and the separate-phase reviews — and the console of the run
 * the reader selected.
 *
 * The list, the count line and the console are separate containers: a live run repaints the console
 * many times a minute, while the list only changes when a run starts or settles. The count line says
 * how many runs of this book exist right now, which is the first thing the dialog answers, and every
 * run the host knows of is listed — nothing about a review is reachable only from another dialog.
 */
import { runTarget, sameTarget, selectTarget, sessionsTarget, turnTarget } from '../sessions.js';
import { RUN_LIVE_STATUSES, dom, elem, plural, state } from '../state.js';

function statusLabel(status) {
  return String(status ?? 'unknown').replace(/_/g, ' ');
}

function statusBadge(status) {
  return elem('span', { className: `badge badge--${status ?? 'unknown'}`, text: statusLabel(status) });
}

function isLiveTurn(turn) {
  return turn.status === 'queued' || turn.status === 'running';
}

function turnTitle(turn) {
  if (turn.kind === 'export') return 'Edition';
  if (turn.kind === 'import') return 'Import';
  const number = turn.chapterNumber;
  if (turn.rewrite) return number != null ? `Rewrite of chapter ${number}` : 'Rewrite';
  return number != null ? `Chapter ${number}` : 'Chapter';
}

function runTitle(run) {
  return run.phase === 'continuity' ? 'Continuity review' : 'Metrics review';
}

function runScope(run) {
  // What the run was asked to review, not what the packet covers: a chapter review of one chapter in a
  // book of twelve says `chapter 4`.
  const scope = run.requested_scope ?? run.scope;
  if (!scope) return '';
  if (scope.kind === 'book') return 'the whole book';
  const chapters = Array.isArray(scope.chapters) ? scope.chapters : [];
  if (chapters.length) return `${chapters.length === 1 ? 'chapter' : 'chapters'} ${chapters.join(', ')}`;
  return String(scope.kind);
}

function timeOf(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function secondsOf(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : null;
}

function stampOf(parts) {
  return parts.filter(Boolean).join(' · ');
}

function row({ selected, title, status, sub, meta, onSelect }) {
  return elem('li', { className: 'sessions__item' },
    elem('button', {
      className: 'sessions__pick',
      attrs: { type: 'button', 'aria-current': selected ? 'true' : 'false' },
      on: { click: onSelect }
    },
    elem('span', { className: 'sessions__pick-head' },
      statusBadge(status),
      elem('span', { className: 'sessions__pick-title', text: title })
    ),
    elem('span', { className: 'sessions__pick-sub', text: sub || statusLabel(status) }),
    meta ? elem('span', { className: 'sessions__pick-sub', text: meta }) : null
    )
  );
}

function turnRow(turn) {
  const request = String(turn.request ?? '').replace(/\s+/g, ' ').trim();
  const started = timeOf(turn.startedAt ?? turn.createdAt);
  return row({
    selected: sameTarget(sessionsTarget()?.target, turnTarget(turn.number)),
    title: `Turn ${turn.number} · ${turnTitle(turn)}`,
    status: turn.status,
    sub: request,
    meta: stampOf([started, secondsOf(turn.durationMs)]),
    onSelect: () => { void selectTarget(turnTarget(turn.number)); }
  });
}

function runRow(run) {
  const started = timeOf(run.started_at ?? run.created_at);
  const meta = stampOf([started, run.trigger === 'arc' && run.arc_id ? `arc ${run.arc_id}` : null, secondsOf(run.duration_ms)]);
  return row({
    selected: sameTarget(sessionsTarget()?.target, runTarget(run.run_id)),
    title: runTitle(run),
    status: run.status,
    sub: runScope(run),
    meta,
    onSelect: () => { void selectTarget(runTarget(run.run_id)); }
  });
}

/**
 * The list of runs: live ones first — turns in the order they will run, then the reviews that are
 * still going — and then every settled run of both kinds, newest first by the moment it ended.
 */
export function renderSessions() {
  const count = dom['sessions-count'];
  const list = dom['sessions-list'];
  if (!count || !list || !state.sessions) return;
  const turns = [...(state.detail?.turns ?? [])];
  const runs = [...(state.runs ?? [])];
  const liveTurns = turns.filter(isLiveTurn).sort((a, b) => a.number - b.number);
  const liveRuns = runs.filter((run) => RUN_LIVE_STATUSES.has(run.status)).sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  const pastTurns = turns.filter((turn) => !isLiveTurn(turn));
  const pastRuns = runs.filter((run) => !RUN_LIVE_STATUSES.has(run.status));
  const live = liveTurns.length + liveRuns.length;
  const past = pastTurns.length + pastRuns.length;
  count.textContent = live + past === 0
    ? 'No run of this book yet.'
    : live > 0
      ? `${plural(live, 'run', 'runs')} of this book ${live === 1 ? 'exists' : 'exist'} right now · ${plural(past, 'past run', 'past runs')}`
      : `No run of this book exists right now · ${plural(past, 'past run', 'past runs')}`;
  if (live + past === 0) {
    list.replaceChildren(elem('li', { className: 'sessions__empty', text: 'Ask ALA for a chapter and the run appears here, live and afterwards.' }));
    return;
  }
  const settled = [
    ...pastTurns.map((turn) => ({ sort: String(turn.finishedAt ?? turn.createdAt ?? ''), node: turnRow(turn) })),
    ...pastRuns.map((run) => ({ sort: String(run.finished_at ?? run.created_at ?? ''), node: runRow(run) }))
  ].sort((a, b) => b.sort.localeCompare(a.sort)).map((entry) => entry.node);
  list.replaceChildren(...liveTurns.map(turnRow), ...liveRuns.map(runRow), ...settled);
}

function consoleTitle() {
  const model = sessionsTarget();
  const target = model?.target;
  if (!target) return '';
  if (target.kind === 'turn') {
    const turn = (state.detail?.turns ?? []).find((entry) => entry.number === target.number);
    return turn ? `Turn ${turn.number} · ${turnTitle(turn)}` : `Turn ${target.number}`;
  }
  const run = (state.runs ?? []).find((entry) => entry.run_id === target.runId);
  return run ? runTitle(run) : 'Review';
}

function consoleStatus() {
  const model = sessionsTarget();
  const target = model?.target;
  if (!target) return 'unknown';
  const record = target.kind === 'turn'
    ? (state.detail?.turns ?? []).find((entry) => entry.number === target.number)
    : (state.runs ?? []).find((entry) => entry.run_id === target.runId);
  return record?.status ?? 'unknown';
}

function consoleHead(model) {
  const stamp = model.updatedAt
    ? new Date(model.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  return elem('div', { className: 'sessions__view-head' },
    statusBadge(consoleStatus()),
    elem('span', { className: 'sessions__view-title', text: consoleTitle() }),
    model.live ? elem('span', { text: 'live…' }) : null,
    stamp ? elem('span', { text: `updated ${stamp}` }) : null
  );
}

/** The console of the selected run: its head, then the text itself or the state it is in. */
export function renderSessionConsole() {
  const model = sessionsTarget();
  const pane = dom['sessions-console'];
  if (!model || !pane) return;
  if (!model.target) {
    pane.replaceChildren(elem('p', { className: 'sessions__hint', text: 'No run of this book yet.' }));
    return;
  }
  if (model.error) {
    pane.replaceChildren(
      consoleHead(model),
      elem('p', { className: 'sessions__hint', text: `The console of this run could not be read: ${model.error}` })
    );
    return;
  }
  if (model.text === '') {
    pane.replaceChildren(
      consoleHead(model),
      elem('p', { className: 'sessions__hint', text: 'Reading the console of this run…' })
    );
    return;
  }
  pane.replaceChildren(consoleHead(model), consoleText(model));
  pinToEnd(model);
}

/**
 * A console that is attached and pinned follows its own end. The position is set after the text is in
 * the document, because a detached element has no scroll height yet.
 */
function pinToEnd(model) {
  if (!model.pinned) return;
  const pre = dom['sessions-console']?.querySelector('.sessions__text');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

function consoleText(model) {
  const pre = elem('pre', { className: 'sessions__text', text: model.text });
  pre.addEventListener('scroll', () => {
    model.pinned = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
  });
  return pre;
}

/**
 * What the stream appended: only the text node moves, so a console that is streaming does not
 * rebuild the pane — and one the reader scrolled up keeps its place.
 */
export function updateConsoleText() {
  const model = sessionsTarget();
  const pane = dom['sessions-console'];
  if (!model || !pane) return;
  const pre = pane.querySelector('.sessions__text');
  if (!pre) {
    renderSessionConsole();
    return;
  }
  const pinned = model.pinned;
  pre.textContent = model.text;
  if (pinned) pre.scrollTop = pre.scrollHeight;
}
