// The turn pipeline: the job registry, the per-universe FIFO queue, the concurrency rule, the durable
// turn records, the SSE events and the HTTP snapshots. One job owns one omp process (`./omp.mjs`),
// starts it with the prompt built by `./prompts.mjs`, verifies what the agent wrote, and repairs the
// store when a turn fails.
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';
import { universeDir } from './paths.mjs';
import { nowIso, pad, readJson, truncate } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { applyAgentTitle, readUniverseMeta, touchUniverse } from './universe.mjs';
import { nextTurnNumber, writeTurnRecord } from './universe-chapters.mjs';
import { commitState, snapshotState } from './universe-state.mjs';
import { composeAgentLog, runOmpAgent } from './omp.mjs';
import { failTurn, turnPrompt, verifyChapterTurn, verifyExportTurn } from './turn.mjs';

const MAX_EVENTS = 800;
const MAX_TEXT_CHARS = 120_000;

export class JobManager {
  #jobs = new Map();
  #subscribers = new Map();
  #universeSubscribers = new Map();
  #locks = new Map();
  #queue = [];
  #running = 0;

  async start({ universeId, message, kind = 'chapter', format = 'both' }) {
    const cleanMessage = String(message ?? '').trim();
    if (!cleanMessage) {
      throw new UniverseError('BAD_MESSAGE', 'Write a message for ALA.', 400);
    }
    if (!['chapter', 'export'].includes(kind)) {
      throw new UniverseError('BAD_KIND', 'Unknown turn kind (chapter|export).', 400);
    }
    if (!['docx', 'pdf', 'both'].includes(format)) {
      throw new UniverseError('BAD_FORMAT', 'Unknown format (docx|pdf|both).', 400);
    }
    const meta = await readUniverseMeta(universeId);
    if (kind === 'chapter' && meta.status === 'closed') {
      throw new UniverseError('CLOSED', 'This universe is closed. Reopen it to continue the story.', 409);
    }
    const job = this.#createJob({ universeId, message: cleanMessage, kind, format });
    await this.#enqueue(job);
    return this.snapshot(job);
  }

  /**
   * Rescrie un capitol existent: serverul a restaurat deja canonul de dinaintea lui, a arhivat
   * the old version and (when needed) dropped later chapters. Here we only start the agent.
   */
  async startRewrite({ universeId, chapterNumber, instructions, previousText }) {
    const meta = await readUniverseMeta(universeId);
    if (meta.status === 'closed') {
      throw new UniverseError('CLOSED', 'This universe is closed. Reopen it to rewrite it.', 409);
    }
    const job = this.#createJob({
      universeId,
      message: String(instructions ?? '').trim(),
      kind: 'rewrite',
      format: 'both'
    });
    job.chapterNumber = chapterNumber;
    job.previousText = previousText;
    await this.#enqueue(job);
    return this.snapshot(job);
  }

  /** Retry an interrupted or failed turn, reusing the same turn number and request. */
  async retry(universeId, turnNumber) {
    const record = await this.#readTurn(universeId, turnNumber);
    if (!record) throw new UniverseError('NOT_FOUND', `Turn ${turnNumber} does not exist.`, 404);
    if (!['interrupted', 'error'].includes(record.status)) {
      throw new UniverseError('NOT_RETRYABLE', 'Only interrupted or failed turns can be retried.', 409);
    }
    const existing = this.#jobs.get(`${universeId}#${turnNumber}`);
    if (existing && existing.status === 'queued') return this.snapshot(existing);
    const meta = await readUniverseMeta(universeId);
    if (record.kind === 'chapter' && meta.status === 'closed') {
      throw new UniverseError('CLOSED', 'This universe is closed. Reopen it to continue the story.', 409);
    }
    const job = this.#createJob({
      universeId,
      message: record.request ?? '',
      kind: record.rewrite ? 'rewrite' : record.kind === 'export' ? 'export' : 'chapter',
      format: record.format ?? 'both',
      turnNumber
    });
    if (record.rewrite && record.chapterNumber) job.chapterNumber = record.chapterNumber;
    await this.#enqueue(job, { reuseRecord: true });
    return this.snapshot(job);
  }

  #createJob({ universeId, message, kind, format, turnNumber = null }) {
    const job = {
      id: turnNumber === null
        ? `j_${randomBytes(4).toString('hex')}`
        : `${universeId}#${turnNumber}`,
      universeId,
      kind,
      format,
      status: 'queued',
      createdAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      turnNumber,
      message,
      result: null,
      error: null,
      events: [],
      text: '',
      tools: []
    };
    this.#jobs.set(job.id, job);
    return job;
  }

  async #readTurn(universeId, turnNumber) {
    return readJson(join(universeDir(universeId), 'turns', `${pad(turnNumber)}.json`), null);
  }

  /** Allocate the turn number, write the durable record to turns/NNNN.json and enqueue the job. */
  async #enqueue(job, { reuseRecord = false } = {}) {
    const previous = this.#locks.get(job.universeId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (job.turnNumber === null) {
        job.turnNumber = await nextTurnNumber(job.universeId);
      }
      job.id = this.#jobs.has(job.id) ? job.id : `${job.universeId}#${job.turnNumber}`;
      if (!reuseRecord) {
        await writeTurnRecord(job.universeId, {
          number: job.turnNumber,
          kind: job.kind === 'export' ? 'export' : 'chapter',
          rewrite: job.kind === 'rewrite',
          chapterNumber: job.kind === 'rewrite' ? job.chapterNumber : null,
          status: 'queued',
          createdAt: job.createdAt,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          request: job.message,
          model: config.model,
          format: job.format,
          chapterNumber: null,
          chapterFile: null,
          chapterTitle: null,
          answer: '',
          agentLog: '',
          exports: [],
          warnings: [],
          error: null
        });
      } else {
        const record = await this.#readTurn(job.universeId, job.turnNumber);
        if (record) {
          await writeTurnRecord(job.universeId, {
            ...record,
            status: 'queued',
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            error: null,
            chapterFile: null,
            chapterTitle: null
          });
        }
      }
    });
    this.#locks.set(job.universeId, next.catch(() => {}));
    await next;
    this.#queue.push(job);
    this.#emitUniverse(job.universeId, { type: 'job', job: this.snapshot(job), jobId: job.id });
    this.#pump();
  }

  /** Resume the queue persisted on disk (turns in `queued` state) after a server restart. */
  async resumeQueued(entries) {
    const ordered = [...entries].sort((a, b) => (a.turnNumber ?? 0) - (b.turnNumber ?? 0));
    for (const entry of ordered) {
      const turn = entry.turn ?? {};
      const job = this.#createJob({
        universeId: entry.universeId,
        message: turn.request ?? '',
        kind: turn.kind === 'export' ? 'export' : 'chapter',
        format: turn.format ?? 'both',
        turnNumber: entry.turnNumber
      });
      this.#queue.push(job);
      this.#emitUniverse(entry.universeId, { type: 'job', job: this.snapshot(job), jobId: job.id });
    }
    if (ordered.length > 0) this.#pump();
    return ordered.length;
  }

  get(jobId) {
    const job = this.#jobs.get(jobId);
    return job ? this.snapshot(job) : null;
  }

  events(jobId) {
    return this.#jobs.get(jobId)?.events ?? [];
  }

  activeForUniverse(universeId) {
    for (const job of this.#jobs.values()) {
      if (job.universeId !== universeId) continue;
      if (job.status === 'running') return this.snapshot(job);
    }
    return null;
  }

  queuedForUniverse(universeId) {
    return [...this.#jobs.values()]
      .filter((job) => job.universeId === universeId && job.status === 'queued')
      .sort((a, b) => (a.turnNumber ?? 0) - (b.turnNumber ?? 0))
      .map((job) => this.snapshot(job));
  }

  joinQueue(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job || job.status !== 'queued') return null;
    const position = this.#queue.filter((entry) => entry.universeId === job.universeId).indexOf(job) + 1;
    return position > 0 ? position : null;
  }

  subscribe(jobId, listener) {
    const job = this.#jobs.get(jobId);
    if (!job) return () => {};
    if (!this.#subscribers.has(jobId)) this.#subscribers.set(jobId, new Set());
    this.#subscribers.get(jobId).add(listener);
    return () => {
      this.#subscribers.get(jobId)?.delete(listener);
    };
  }

  subscribeUniverse(universeId, listener) {
    if (!this.#universeSubscribers.has(universeId)) this.#universeSubscribers.set(universeId, new Set());
    this.#universeSubscribers.get(universeId).add(listener);
    return () => {
      this.#universeSubscribers.get(universeId)?.delete(listener);
    };
  }

  snapshot(job) {
    return {
      id: job.id,
      universeId: job.universeId,
      kind: job.kind,
      format: job.format,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      turnNumber: job.turnNumber,
      request: job.message,
      queuePosition: job.status === 'queued' ? this.joinQueue(job.id) ?? 0 : 0,
      result: job.result,
      error: job.error
    };
  }

  #emit(job, event) {
    const payload = event.jobId ? event : { ...event, jobId: job.id };
    if (payload.type !== 'delta' && payload.type !== 'tool') {
      job.events.push(payload);
    } else if (job.events.length < MAX_EVENTS) {
      job.events.push(payload);
    }
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    for (const listener of this.#subscribers.get(job.id) ?? []) {
      try {
        listener(payload);
      } catch {
        // a broken SSE client must not break the run
      }
    }
    this.#emitUniverse(job.universeId, payload);
  }

  #emitUniverse(universeId, payload) {
    for (const listener of this.#universeSubscribers.get(universeId) ?? []) {
      try {
        listener(payload);
      } catch {
        // a broken SSE client must not break the run
      }
    }
  }

  #busyUniverses() {
    const busy = new Set();
    for (const job of this.#jobs.values()) {
      if (job.status === 'running') busy.add(job.universeId);
    }
    return busy;
  }

  /**
   * Start jobs while there is room: no implicit global cap (config 0 = unlimited), but never two
   * turns at once inside the same universe — queue order is preserved.
   */
  #pump() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      if (config.maxConcurrentJobs > 0 && this.#running >= config.maxConcurrentJobs) return;
      const busy = this.#busyUniverses();
      const index = this.#queue.findIndex((job) => !busy.has(job.universeId));
      if (index < 0) return;
      const [job] = this.#queue.splice(index, 1);
      this.#running += 1;
      progressed = true;
      this.#run(job).finally(() => {
        this.#running -= 1;
        this.#pump();
      });
    }
  }

  async #run(job) {
    const { universeId } = job;
    job.status = 'running';
    job.startedAt = nowIso();
    this.#emit(job, { type: 'job', job: this.snapshot(job) });

    const turnNumber = job.turnNumber;
    try {
      const meta = await readUniverseMeta(universeId);
      if (job.kind === 'chapter' && meta.status === 'closed') {
        throw new UniverseError('CLOSED', 'This universe is closed. Reopen it to continue the story.', 409);
      }
      const isRewrite = job.kind === 'rewrite';
      if (!isRewrite) await snapshotState(universeId, turnNumber);

      const chapterFiles = (await readdir(join(universeDir(universeId), 'chapters')).catch(() => []))
        .filter((name) => /^\d{4}-.+\.md$/.test(name));
      const chapterNumber = isRewrite
        ? job.chapterNumber
        : chapterFiles.reduce((max, name) => Math.max(max, Number.parseInt(name.slice(0, 4), 10)), 0) + 1;
      const startedMs = Date.now();

      const prompt = turnPrompt({ meta, job, chapterNumber, chapterFiles });

      const record = {
        number: turnNumber,
        kind: job.kind === 'export' ? 'export' : 'chapter',
        rewrite: isRewrite,
        instructions: isRewrite ? job.message : null,
        status: 'running',
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: null,
        durationMs: null,
        request: job.message,
        model: config.model,
        format: job.format,
        chapterNumber: job.kind === 'export' ? null : chapterNumber,
        chapterFile: null,
        chapterTitle: null,
        answer: '',
        agentLog: '',
        exports: [],
        warnings: [],
        offer: null,
        error: null
      };
      await writeTurnRecord(universeId, record);

      this.#emit(job, {
        type: 'phase',
        phase: 'agent',
        text: isRewrite
          ? `ALA is rewriting chapter ${chapterNumber}`
          : job.kind === 'export'
            ? `ALA is preparing the printed edition (${job.format})`
            : `ALA is writing chapter ${chapterNumber}`
      });

      const run = await runOmpAgent({
        cwd: universeDir(universeId),
        prompt,
        timeoutMs: job.kind === 'export' ? config.exportTimeoutMs : config.chapterTimeoutMs,
        onEvent: (event) => {
          if (event.type === 'delta') {
            job.text = truncate(`${job.text}${event.text}`, MAX_TEXT_CHARS);
          } else if (event.type === 'tool' && event.state === 'start') {
            job.tools.push({ name: event.name, detail: event.detail });
          }
          this.#emit(job, event);
        }
      });

      const answer = (run.finalAnswer || run.assistantTexts.join('\n\n')).trim();
      const agentLog = composeAgentLog({ prompt, run, answer });

      this.#emit(job, { type: 'phase', phase: 'verify', text: 'verific rezultatul' });

      if (!run.ok) {
        const reason = run.timedOut
          ? 'the generation deadline expired'
          : run.spawnError
            ? `the agent did not start: ${run.spawnError}`
            : `the agent exited with code ${run.code}`;
        throw new UniverseError('AGENT_FAILED', reason, 502);
      }

      if (job.kind !== 'export') {
        await verifyChapterTurn({ universeId, chapterNumber, chapterFiles, record });
      } else {
        await verifyExportTurn({ universeId, startedMs, record });
      }

      record.status = 'done';
      record.finishedAt = nowIso();
      record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
      record.answer = answer;
      record.agentLog = agentLog;
      await writeTurnRecord(universeId, record);
      await commitState(universeId, turnNumber);
      await touchUniverse(universeId);
      const assignedTitle = await applyAgentTitle(universeId).catch(() => null);
      if (assignedTitle) console.log(`[universe] ${universeId} named by ALA: ${assignedTitle}`);

      job.status = 'done';
      job.finishedAt = record.finishedAt;
      job.result = {
        chapterNumber: record.chapterNumber,
        chapterTitle: record.chapterTitle,
        exports: record.exports,
        warnings: record.warnings,
        offer: record.offer ?? null,
        durationMs: record.durationMs
      };
      this.#emit(job, { type: 'done', job: this.snapshot(job) });
      return;
    } catch (error) {
      const message = error instanceof UniverseError
        ? error.message
        : `internal error: ${error?.message ?? error}`;
      await failTurn({ universeId, job, turnNumber, message });
      job.status = 'error';
      job.error = message;
      job.finishedAt = nowIso();
      this.#emit(job, { type: 'error', message, job: this.snapshot(job) });
    }
  }
}

export const jobs = new JobManager();
