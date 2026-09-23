/**
 * scriptaWorlds — The ALA sessions: every run of the open book — the turns in which the agent wrote a
 * chapter, an edition or an import, and the separate-phase reviews — with the console of the one the
 * reader selected.
 *
 * Both kinds of run answer the same way: the host appends what the agent displayed to a journal while it
 * works, and the console is that journal read through `GET /api/universes/:id/turns/:number/console` or
 * `GET /api/universes/:id/assessments/:runId/console`. While the selection is live the event stream
 * appends a turn's text the moment it appears, a full re-read every few seconds keeps both kinds honest,
 * and the run list follows the book. Nothing depends on a run finishing: it can be watched from its
 * first line or opened weeks later.
 */
import { loadAssessments, loadRunConsole, loadTurnConsole } from './api.js';
import { closePanel, openPanel } from './overlays.js';
import { renderSessionConsole, renderSessions, updateConsoleText } from './render/sessions.js';
import { LIVE_STATUSES, RUN_LIVE_STATUSES, SESSION_RECONCILE_MS, state } from './state.js';

let reconcile = null;

export function sessionsTarget() {
  return state.sessions;
}

export const turnTarget = (number) => ({ kind: 'turn', number });

export const runTarget = (runId) => ({ kind: 'run', runId });

export function sameTarget(one, other) {
  if (!one || !other || one.kind !== other.kind) return false;
  return one.kind === 'turn' ? one.number === other.number : one.runId === other.runId;
}

/** The run the dialog opens on when the reader did not name one: live work first, then the newest. */
function defaultTarget() {
  const turns = state.detail?.turns ?? [];
  const liveTurn = turns.filter((turn) => LIVE_STATUSES.has(turn.status)).sort((a, b) => a.number - b.number)[0];
  if (liveTurn) return turnTarget(liveTurn.number);
  const liveRun = state.runs.find((run) => RUN_LIVE_STATUSES.has(run.status));
  if (liveRun) return runTarget(liveRun.run_id);
  const newestTurn = turns.at(-1) ?? null;
  const newestRun = state.runs[0] ?? null;
  if (newestTurn && newestRun) {
    const turnStamp = newestTurn.finishedAt ?? newestTurn.createdAt ?? '';
    const runStamp = newestRun.finished_at ?? newestRun.created_at ?? '';
    return runStamp > turnStamp ? runTarget(newestRun.run_id) : turnTarget(newestTurn.number);
  }
  if (newestTurn) return turnTarget(newestTurn.number);
  if (newestRun) return runTarget(newestRun.run_id);
  return null;
}

/**
 * Open the sessions dialog. The caller names what to watch when it started something — `turn` for the
 * writing request it just queued, `run` for the review it just started — so the reader lands on that
 * console instead of on a list. Without a name the dialog keeps its selection or opens on the oldest
 * live run, and on the newest one when nothing is running.
 */
export function openSessions({ turn = null, run = null } = {}) {
  if (!state.universeId) return;
  const model = state.sessions ?? {
    target: null, text: '', live: false, updatedAt: null, source: null, error: null, pinned: true
  };
  state.sessions = model;
  if (run) model.target = runTarget(run);
  else if (turn != null) model.target = turnTarget(turn);
  else if (!model.target) model.target = defaultTarget();
  openPanel('sessions');
  renderSessions();
  void loadRuns();
  if (model.target) void selectTarget(model.target);
  else renderSessionConsole();
}

async function loadRuns() {
  try {
    await loadAssessments(true);
  } catch {
    // the list keeps what it has; the console of the selected run is unaffected
  }
  if (state.panel === 'sessions') renderSessions();
}

/** Select one run of the list — a turn or a review — and read its console from the start. */
export async function selectTarget(target) {
  const model = state.sessions;
  if (!model || !target) return;
  model.target = target;
  model.text = '';
  model.live = false;
  model.updatedAt = null;
  model.source = null;
  model.error = null;
  model.pinned = true;
  renderSessions();
  renderSessionConsole();
  await fetchConsole();
}

export async function selectTurn(number) {
  return selectTarget(turnTarget(number));
}

export async function selectRun(runId) {
  return selectTarget(runTarget(runId));
}

async function fetchConsole() {
  const model = state.sessions;
  if (!model?.target || !state.universeId) return;
  const target = model.target;
  try {
    if (target.kind === 'turn') {
      const payload = await loadTurnConsole(target.number);
      if (state.sessions !== model || !sameTarget(model.target, target)) return;
      model.text = String(payload?.console?.text ?? '');
      model.live = payload?.console?.live === true;
      model.updatedAt = payload?.console?.updatedAt ?? null;
      model.source = payload?.console?.source ?? null;
      model.error = null;
      patchTurnSummary(payload?.turn);
    } else {
      const payload = await loadRunConsole(target.runId);
      if (state.sessions !== model || !sameTarget(model.target, target)) return;
      model.text = String(payload?.console?.text ?? '');
      model.live = payload?.console?.live === true;
      model.updatedAt = payload?.console?.updatedAt ?? null;
      model.source = payload?.console?.source ?? null;
      model.error = payload?.console ? null : 'This run is no longer in the store.';
    }
  } catch (error) {
    if (state.sessions !== model) return;
    model.error = error.message;
  }
  renderSessions();
  renderSessionConsole();
  scheduleReconcile();
}

/**
 * While the dialog is open the list re-reads itself every few seconds and the console of the
 * selection with it, so a run started elsewhere appears here, a review that settles stops saying
 * `running`, and a turn that starts shows up — without the reader reopening anything. A turn's
 * console is also appended by the event stream the moment it changes; the read is what makes the
 * list honest for the runs that publish no stream at all.
 */
function scheduleReconcile() {
  const model = state.sessions;
  const needed = state.panel === 'sessions';
  if (reconcile) {
    clearInterval(reconcile);
    reconcile = null;
  }
  if (!needed) return;
  reconcile = setInterval(async () => {
    if (state.panel !== 'sessions') {
      scheduleReconcile();
      return;
    }
    await loadRuns();
    if (state.sessions?.live === true) await fetchConsole();
  }, SESSION_RECONCILE_MS);
}

/** Keep the listed summary of one turn in step with what the console read back. */
function patchTurnSummary(summary) {
  if (!summary?.number) return;
  const turns = state.detail?.turns;
  if (!Array.isArray(turns)) return;
  const listed = turns.find((turn) => turn.number === summary.number);
  if (!listed) {
    turns.push(summary);
    turns.sort((a, b) => a.number - b.number);
    return;
  }
  Object.assign(listed, summary);
}

function turnOfJobId(jobId) {
  if (!jobId || !jobId.includes('#')) return null;
  const number = Number.parseInt(jobId.split('#')[1], 10);
  return Number.isInteger(number) ? number : null;
}

function clockNow() {
  const pad2 = (value) => String(value).padStart(2, '0');
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

/**
 * One event of the open universe's stream, forwarded by `sse.js`. When it belongs to the selected
 * turn it is appended to the console at once, with the same shape the server renders its journal
 * lines in. The periodic re-read replaces the whole text, so an optimistic line never lingers.
 */
export function feedSessions(payload) {
  const model = state.sessions;
  if (!model || state.panel !== 'sessions' || !model.target || !payload || typeof payload !== 'object') return;
  if (model.target.kind !== 'turn') return;
  const turn = payload.job?.turnNumber ?? turnOfJobId(payload.jobId);
  if (turn !== model.target.number) return;
  const time = clockNow();
  let appended = null;
  switch (payload.type) {
    case 'delta':
      appended = String(payload.text ?? '');
      break;
    case 'phase':
      appended = `[${time}] ${String(payload.text ?? '').trim()}`;
      break;
    case 'tool':
      appended = payload.state === 'start'
        ? `[${time}] → ${payload.name}${payload.detail ? ` ${payload.detail}` : ''}`
        : `[${time}] ${payload.ok === false ? '✗' : '✓'} ${payload.name}`;
      break;
    case 'job':
      // A queued turn that starts running, or a turn that was retried, changes the row and the head
      // of the console at once instead of waiting for the next full read.
      if (payload.job) {
        patchTurnSummary(turnSummaryOfJob(payload.job));
        renderSessions();
        renderSessionConsole();
      }
      return;
    case 'done':
    case 'error':
      model.live = false;
      void fetchConsole();
      return;
    default:
      return;
  }
  if (!appended) return;
  model.text = `${model.text}${model.text.endsWith('\n') || model.text === '' ? '' : '\n'}${appended}`;
  updateConsoleText();
}

function turnSummaryOfJob(job) {
  const summary = {
    number: job.turnNumber,
    kind: job.kind === 'rewrite' ? 'chapter' : (job.kind ?? 'chapter'),
    rewrite: job.kind === 'rewrite',
    status: job.status,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    durationMs: job.result?.durationMs ?? null,
    request: job.request ?? '',
    chapterNumber: job.chapterNumber ?? null,
    chapterTitle: job.result?.chapterTitle ?? null,
    error: job.error ?? null,
    exports: job.result?.exports ?? []
  };
  return summary;
}

/** Closing the dialog stops the re-read and closes the panel; the selection stays for the next open. */
export function closeSessions() {
  scheduleReconcile();
  closePanel();
}

/** Leaving the book: no run of another book stays selected and no timer outlives the universe. */
export function resetSessions() {
  if (reconcile) {
    clearInterval(reconcile);
    reconcile = null;
  }
  state.sessions = null;
}
