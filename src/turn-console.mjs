// The durable console of one turn: every event the running agent produced, appended to
// `turns/NNNN.events.jsonl` as it happens, and the rendering of that journal a client reads back as
// one text. The in-memory event buffer of a job is bounded and disappears with the server process;
// the journal is what lets a run be watched while it runs and read back after it settled, failed or
// was interrupted — including runs from before this page was opened.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { universeDir } from './paths.mjs';
import { pad, readJson, truncate } from './io.mjs';
import { turnSummary } from './universe-chapters.mjs';

// The same ceiling the composed agent log keeps: a console longer than this keeps its markers
// (phases, tools, the settle line) but stops recording raw narration deltas.
const MAX_JOURNAL_CHARS = 400_000;

const MAX_RENDER_CHARS = 400_000;

// One serialized append chain per turn, so journal lines reach the file in the order they happened
// even when events arrive faster than the disk answers. The byte counter bounds growth in memory; a
// process that restarts into the same turn number (a retry) starts a fresh counter and the file may
// briefly grow past the ceiling, which the cap on the rendered text hides from the reader.
const chains = new Map();
const sizes = new Map();

export function journalPath(universeId, turnNumber) {
  return join(universeDir(universeId), 'turns', `${pad(turnNumber)}.events.jsonl`);
}

/** Where the evaluator of one review run appends its stream: beside the run, inside its own `generated/`. */
export function evaluatorJournalPath(runDir) {
  return join(runDir, 'generated', 'evaluator.events.jsonl');
}

/**
 * Append one event to one journal, in the order it happened, whatever the writer. The chain and the
 * ceiling are per journal, so a turn and the evaluator of a review never share either.
 */
function appendJournal(path, key, event) {
  if (event?.type === 'delta' && (sizes.get(key) ?? 0) > MAX_JOURNAL_CHARS) return;
  let line;
  try {
    line = `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`;
  } catch {
    return;
  }
  sizes.set(key, (sizes.get(key) ?? 0) + line.length);
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, 'utf8');
    })
    .catch((error) => {
      console.log(`[console] ${key} journal write failed: ${error?.message ?? error}`);
    });
  chains.set(key, next);
}

/** Append one event of one turn to its journal. Never throws: a run must not fail on its log. */
export function journalEvent(universeId, turnNumber, event) {
  if (!Number.isInteger(turnNumber)) return;
  appendJournal(journalPath(universeId, turnNumber), `${universeId}#${turnNumber}`, event);
}

/** Append one event of the evaluator child of one review run to the journal beside that run. */
export function journalEvaluatorEvent(runDir, event) {
  appendJournal(evaluatorJournalPath(runDir), runDir, event);
}

function clock(at) {
  const time = new Date(at).getTime();
  return Number.isNaN(time) ? '--:--:--' : new Date(at).toISOString().slice(11, 19);
}

function describeJob(job = {}) {
  if (job.kind === 'rewrite') return `rewriting chapter ${job.chapterNumber ?? '?'}`;
  if (job.kind === 'export') return `printed edition (${job.format ?? 'both'})`;
  if (job.kind === 'import') return 'import';
  return `chapter ${job.chapterNumber ?? '?'}`;
}

function secondsBetween(from, to) {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '';
  return ` — ${Math.round(ms / 1000)} s`;
}

/** One journal entry as one console line, or `null` for an entry that prints nothing. */
function renderLine(entry) {
  const time = clock(entry.at);
  switch (entry.type) {
    case 'job': {
      const job = entry.job ?? {};
      if (job.status === 'queued') return `[${time}] queued — request: ${String(job.request ?? '').replace(/\s+/g, ' ').trim()}`;
      if (job.status === 'running') return `[${time}] running — ${describeJob(job)}`;
      return null;
    }
    case 'phase':
      return `[${time}] ${String(entry.text ?? '').trim()}`;
    case 'tool':
      if (entry.state === 'start') return `[${time}] → ${entry.name}${entry.detail ? ` ${entry.detail}` : ''}`;
      return `[${time}] ${entry.ok === false ? '✗' : '✓'} ${entry.name}`;
    case 'delta':
      return String(entry.text ?? '');
    case 'done':
      return `[${time}] ✓ done${secondsBetween(entry.job?.startedAt, entry.job?.finishedAt)}`;
    case 'error':
      return `[${time}] ✗ failed — ${entry.message ?? 'unknown error'}`;
    default:
      return null;
  }
}

/** The rendered lines of one journal, oldest first, with the time of its last entry. */
export async function readJournal(path) {
  const raw = await readFile(path, 'utf8').catch(() => '');
  const lines = [];
  let updatedAt = null;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.at) updatedAt = entry.at;
    const text = renderLine(entry);
    if (text == null || text === '') continue;
    // Text arrives in fragments, one event per token or per word: consecutive fragments are one
    // passage, not one line each, so they are joined onto the line they continue.
    const previous = lines[lines.length - 1];
    if (entry.type === 'delta' && previous?.delta) {
      previous.text += text;
      continue;
    }
    lines.push({ at: entry.at ?? null, text, delta: entry.type === 'delta' });
  }
  return { lines, updatedAt };
}

/**
 * The console of one turn as a client reads it: the turn summary, and `{ text, live, updatedAt,
 * source }`. `source` is `journal` for a turn this server watched, and `agentLog` for a turn that
 * ran before journals existed, whose composed log is the only record left. A turn with neither
 * records nothing, and says so instead of answering an empty string.
 */
export async function readTurnConsole(universeId, turnNumber) {
  const record = await readJson(join(universeDir(universeId), 'turns', `${pad(turnNumber)}.json`), null);
  if (!record) return null;
  const status = record.status ?? 'done';
  const live = status === 'queued' || status === 'running';
  const journal = await readJournal(journalPath(universeId, turnNumber));
  if (journal.lines.length === 0) {
    const fallback = String(record.agentLog ?? '').trim();
    return {
      turn: turnSummary(record),
      console: {
        text: fallback || 'Nothing was recorded for this run.',
        live,
        updatedAt: record.finishedAt ?? record.startedAt ?? record.createdAt ?? null,
        source: fallback ? 'agentLog' : 'none'
      }
    };
  }
  return {
    turn: turnSummary(record),
    console: {
      text: truncate(journal.lines.map((line) => line.text).join('\n'), MAX_RENDER_CHARS),
      live,
      updatedAt: journal.updatedAt,
      source: 'journal'
    }
  };
}
