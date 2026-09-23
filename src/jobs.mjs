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
import { acceptedChapters, nextTurnNumber, scanTurns, writeTurnRecord } from './universe-chapters.mjs';
import { readText } from './io.mjs';
import { prepareSnapshot, readAncestry, restoreState, writeAncestry } from './universe-state.mjs';
import { currentVersion } from './assessment-packet.mjs';
import { normaliseDirections, normaliseRevision } from './request-fields.mjs';
import { sha256Hex } from './version.mjs';
import { composeAgentLog, runOmpAgent } from './omp.mjs';
import { journalEvent } from './turn-console.mjs';
import { failTurn, prepareRewrite, turnPrompt, verifyChapterTurn, verifyExportTurn, verifyImportTurn } from './turn.mjs';

const MAX_EVENTS = 800;


// Completed jobs kept in memory (their durable records stay on disk for the reader).
const MAX_SETTLED_JOBS = 40;
const MAX_TEXT_CHARS = 120_000;

export class JobManager {
  #jobs = new Map();
  #subscribers = new Map();
  #universeSubscribers = new Map();
  #locks = new Map();
  #queue = [];
  #running = 0;
  #stopping = false;

  /**
   * The chapter a request was sent from, or `null`. A number that does not name an accepted chapter is
   * a client bug, not a preference, so it is refused before the request is queued.
   */
  async #validatedSourceChapter(universeId, value) {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1) {
      throw new UniverseError('BAD_NUMBER', '`sourceChapter` must be a chapter number.', 400);
    }
    const accepted = await acceptedChapters(universeId);
    if (!accepted.some((chapter) => chapter.number === number)) {
      throw new UniverseError('BAD_NUMBER', `Chapter ${number} is not an accepted chapter of this book.`, 400);
    }
    return number;
  }

  /**
   * A universe whose accepted state could not be restored refuses new work: the snapshot that would
   * have restored it is unusable, so any further write could entrench the wrong book.
   */
  async #assertWritable(universeId) {
    if (this.#stopping) {
      throw new UniverseError('SHUTTING_DOWN', 'The server is shutting down; no new turn is accepted.', 503);
    }
    for (const turn of await scanTurns(universeId)) {
      if (turn.status !== 'recovery_required') continue;
      throw new UniverseError(
        'RECOVERY_REQUIRED',
        `Turn ${turn.number} could not restore the accepted state of this book (${turn.error ?? 'unknown reason'}); establish it by hand before writing again.`,
        409
      );
    }
  }

  async start({ universeId, message, kind = 'chapter', format = 'both', directions = [], approval = null, sourceChapter = null }) {
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
    const accepted = normaliseDirections(directions, approval);
    // Where the request came from: the chapter the reader was looking at, which is not always the
    // chapter this turn will write. It is recorded so a chapter can be traced to the reader's place in
    // the book, and an unknown chapter number is refused instead of silently ignored.
    const source = await this.#validatedSourceChapter(universeId, sourceChapter);
    await this.#assertWritable(universeId);
    const job = this.#createJob({ universeId, message: cleanMessage, kind, format });
    job.directions = accepted.directions;
    job.approval = accepted.approval;
    job.sourceChapter = source;
    await this.#enqueue(job);
    return this.snapshot(job);
  }

  /**
   * Queue a rewrite of an existing chapter. All store mutation (archiving the old text, dropping
   * later chapters, restoring the pre-chapter state) happens inside the run, under the same
   * per-universe execution lock as generation, so the HTTP handler never changes input files while
   * an agent is working. The job carries the target chapter and the turn whose snapshot is the
   * pre-chapter state.
   */
  async startRewrite({ universeId, chapterNumber, instructions, dropLater = false, findings = [], preserve = [], sourceVersion = null }) {
    const meta = await readUniverseMeta(universeId);
    if (meta.status === 'closed') {
      throw new UniverseError('CLOSED', 'This universe is closed. Reopen it to rewrite it.', 409);
    }
    await this.#assertWritable(universeId);
    const accepted = await acceptedChapters(universeId);
    const target = accepted.find((chapter) => chapter.number === chapterNumber) ?? null;
    if (!target) {
      throw new UniverseError('NOT_FOUND', `Chapter ${chapterNumber} does not exist.`, 404);
    }
    // The request is bound to the version it was written for: its hash, the later chapters that
    // existed at that moment, and the recorded ancestry the rewrite must generate from.
    const ancestry = await readAncestry(universeId, chapterNumber);
    if (!ancestry) {
      throw new UniverseError(
        'NO_ANCESTRY',
        `Chapter ${chapterNumber} has no recorded pre-chapter state, so it cannot be rewound safely; reconstruct that state first.`,
        409
      );
    }
    const revision = normaliseRevision({ findings, preserve });
    // Findings are bound to the version they were reported against: a revision of a book that already
    // moved on would act on stale evidence, so it is refused instead of interpreted.
    if (revision.findings.length > 0 && sourceVersion) {
      const current = await currentVersion(universeId);
      if (current !== null && current !== sourceVersion) {
        throw new UniverseError(
          'STALE_REQUEST',
          `These findings were reported against ${String(sourceVersion).slice(0, 24)}… but the accepted version is ${String(current).slice(0, 24)}…; reconcile them before revising.`,
          409
        );
      }
    }
    const job = this.#createJob({
      universeId,
      message: String(instructions ?? '').trim(),
      kind: 'rewrite',
      format: 'both'
    });
    job.chapterNumber = chapterNumber;
    job.dropLater = dropLater === true;
    job.ancestryTurn = ancestry.source_turn;
    job.findings = revision.findings;
    job.preserve = revision.preserve;
    job.findingsVersion = revision.findings.length > 0 ? (sourceVersion ?? null) : null;
    job.previousText = '';
    await this.#enqueue(job);
    return this.snapshot(job);
  }

  /**
   * Queue one import turn: a range of an uploaded book that ALA writes into the store under
   * `scripta-import`. The range is what keeps the turn bounded, and the next range is read from the
   * import progress the skill keeps in the universe, so a long book is imported one step at a time.
   */
  async startImport({ universeId, importId, range, info = null }) {
    const meta = await readUniverseMeta(universeId);
    if (meta.status === 'closed') {
      throw new UniverseError('CLOSED', 'This universe is closed. Reopen it to finish the import.', 409);
    }
    await this.#assertWritable(universeId);
    const job = this.#createJob({
      universeId,
      message: `Import chapters ${range.from}-${range.to} of an uploaded book`,
      kind: 'import',
      format: 'both'
    });
    job.importId = importId;
    job.importRange = range;
    job.importInfo = info;
    await this.#enqueue(job);
    return this.snapshot(job);
  }

  /** Retry an interrupted or failed turn, reusing the same turn number and request. */
  async retry(universeId, turnNumber) {
    const record = await this.#readTurn(universeId, turnNumber);
    if (!record) throw new UniverseError('NOT_FOUND', `Turn ${turnNumber} does not exist.`, 404);
    if (record.status === 'recovery_required') {
      // A book whose accepted state could not be restored is only retried through a successful
      // restore: the retry repairs the state first, and refuses while the snapshot stays unusable.
      const repaired = await restoreState(universeId, turnNumber);
      if (!repaired.ok) {
        throw new UniverseError(
          'RECOVERY_REQUIRED',
          `The accepted state of this book could not be restored (${repaired.reason}); establish it by hand before retrying.`,
          409
        );
      }
      await writeTurnRecord(universeId, { ...record, status: 'interrupted', error: 'the accepted state was restored; the turn can be retried' });
      record.status = 'interrupted';
    }
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
      kind: record.rewrite ? 'rewrite' : record.kind === 'export' ? 'export' : record.kind === 'import' ? 'import' : 'chapter',
      format: record.format ?? 'both',
      turnNumber
    });
    job.directions = Array.isArray(record.directions) ? record.directions : [];
    job.approval = record.approval ?? null;
    job.sourceChapter = record.sourceChapter ?? null;
    job.findings = Array.isArray(record.findings) ? record.findings : [];
    job.preserve = Array.isArray(record.preserve) ? record.preserve : [];
    job.findingsVersion = record.findingsVersion ?? null;
    if (record.rewrite && record.chapterNumber) {
      job.chapterNumber = record.chapterNumber;
      job.dropLater = record.dropLater === true;
      job.ancestryTurn = record.ancestryTurn ?? null;
      job.targetSha256 = record.targetSha256 ?? null;
      job.authorizedLaterChapters = Array.isArray(record.authorizedLaterChapters) ? record.authorizedLaterChapters : null;
    }
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
      // A rewrite is bound to the version it was written for, and the binding is durable: the target
      // hash and the later chapters that existed when the reader asked travel with the queued record.
      let target = null;
      let laterChapterNumbers = null;
      if (job.kind === 'rewrite' && Number.isInteger(job.chapterNumber)) {
        // The binding names the *accepted* book: a chapter that another turn of this universe is still
        // writing is a candidate, not accepted material, so it never enters the request.
        const accepted = await acceptedChapters(job.universeId);
        const chapter = accepted.find((entry) => entry.number === job.chapterNumber) ?? null;
        if (!chapter) throw new UniverseError('NOT_FOUND', `Chapter ${job.chapterNumber} does not exist.`, 404);
        const bytes = await readText(join(universeDir(job.universeId), chapter.file), '');
        target = { name: chapter.file.split('/').pop(), sha256: sha256Hex(bytes), bytes: bytes.length };
        laterChapterNumbers = accepted
          .filter((entry) => entry.number > job.chapterNumber)
          .map((entry) => entry.number);
        job.targetSha256 = target.sha256;
        job.authorizedLaterChapters = laterChapterNumbers;
      }
      if (!reuseRecord) {
        await writeTurnRecord(job.universeId, {
          number: job.turnNumber,
          kind: job.kind === 'export' ? 'export' : job.kind === 'import' ? 'import' : 'chapter',
          rewrite: job.kind === 'rewrite',
          chapterNumber: job.kind === 'rewrite' ? job.chapterNumber : null,
          dropLater: job.kind === 'rewrite' ? job.dropLater === true : null,
          ancestryTurn: job.kind === 'rewrite' ? (job.ancestryTurn ?? null) : null,
          targetSha256: job.kind === 'rewrite' ? (target?.sha256 ?? null) : null,
          authorizedLaterChapters: job.kind === 'rewrite' ? laterChapterNumbers : null,
          status: 'queued',
          createdAt: job.createdAt,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          request: job.message,
          model: config.model,
          format: job.format,
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
    // The console journal starts with the queued line, so a run read later names the request it came
    // from even if the reader never saw it live.
    journalEvent(job.universeId, job.turnNumber, { type: 'job', job: this.snapshot(job) });
    this.#emitUniverse(job.universeId, { type: 'job', job: this.snapshot(job), jobId: job.id });
    this.#pump();
  }

  /** Resume the queue persisted on disk (turns in `queued` state) after a server restart. */
  async resumeQueued(entries) {
    const ordered = [...entries].sort((a, b) => (a.turnNumber ?? 0) - (b.turnNumber ?? 0));
    for (const entry of ordered) {
      const turn = entry.turn ?? {};
      const kind = turn.rewrite ? 'rewrite' : turn.kind === 'export' ? 'export' : 'chapter';
      const job = this.#createJob({
        universeId: entry.universeId,
        message: turn.request ?? '',
        kind,
        format: turn.format ?? 'both',
        turnNumber: entry.turnNumber
      });
      if (turn.rewrite && turn.chapterNumber) {
        job.chapterNumber = turn.chapterNumber;
        job.dropLater = turn.dropLater === true;
        job.ancestryTurn = turn.ancestryTurn ?? null;
        job.targetSha256 = turn.targetSha256 ?? null;
        job.authorizedLaterChapters = Array.isArray(turn.authorizedLaterChapters) ? turn.authorizedLaterChapters : null;
      }
      this.#queue.push(job);
      // A resumed turn opens a new session in the same journal: the reader sees the restart as
      // another queued line, not as a gap.
      journalEvent(entry.universeId, entry.turnNumber, { type: 'job', job: this.snapshot(job) });
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
      chapterNumber: job.chapterNumber ?? null,
      request: job.message,
      queuePosition: job.status === 'queued' ? this.joinQueue(job.id) ?? 0 : 0,
      result: job.result,
      error: job.error
    };
  }

  #emit(job, event) {
    const payload = event.jobId ? event : { ...event, jobId: job.id };
    // The durable console: everything a live subscriber sees is also appended to the turn's journal,
    // so the run stays readable after the in-memory buffer is gone.
    journalEvent(job.universeId, job.turnNumber, payload);
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
    if (this.#stopping) return;
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

  /** Keep only the most recent settled jobs in memory; their durable records stay on disk. */
  #retain() {
    const settled = [...this.#jobs.values()]
      .filter((entry) => entry.status === 'done' || entry.status === 'error')
      .sort((a, b) => String(a.finishedAt ?? '').localeCompare(String(b.finishedAt ?? '')));
    if (settled.length <= MAX_SETTLED_JOBS) return;
    for (const entry of settled.slice(0, settled.length - MAX_SETTLED_JOBS)) {
      this.#jobs.delete(entry.id);
      this.#subscribers.delete(entry.id);
    }
  }

  /**
   * Stop intake, keep the queue on disk, signal the running agents and wait for them to be gone before
   * returning. Ownership of the store is released only after this resolves, so a second server can
   * never start writing while a child of this one is still alive.
   */
  async stop({ timeoutMs = 10_000 } = {}) {
    if (this.#stopping) return { stopped: 0, killed: 0 };
    this.#stopping = true;
    const running = [...this.#jobs.values()].filter((job) => job.status === 'running');
    this.#queue = [];
    if (running.length === 0) return { stopped: 0, killed: 0 };
    for (const job of running) job.child?.kill('SIGTERM');
    const waitForExit = async (deadline) => {
      while (Date.now() < deadline && running.some((job) => job.status === 'running')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    await waitForExit(Date.now() + timeoutMs);
    const stillRunning = running.filter((job) => job.status === 'running');
    for (const job of stillRunning) job.child?.kill('SIGKILL');
    await waitForExit(Date.now() + 3_000);
    return { stopped: running.length, killed: stillRunning.length };
  }

  /** Whether intake has been closed by a shutdown. */
  get stopping() {
    return this.#stopping;
  }

  async #run(job) {
    const { universeId } = job;
    job.status = 'running';
    job.startedAt = nowIso();

    const turnNumber = job.turnNumber;
    try {
      const meta = await readUniverseMeta(universeId);
      if (job.kind === 'chapter' && meta.status === 'closed') {
        throw new UniverseError('CLOSED', 'This universe is closed. Reopen it to continue the story.', 409);
      }
      const isRewrite = job.kind === 'rewrite';
      await this.#assertWritable(universeId);
      // Snapshot the whole accepted book before any mutation, published atomically and verified, so a
      // crash can never leave a half-written recovery point. Every turn takes one, including an export
      // turn: an agent that writes narrative files while rendering an edition must not leave them
      // behind when the turn fails. For a new chapter the snapshot is also the chapter's ancestry; for
      // a rewrite it is the rollback reference for the current accepted book.
      const snapshot = await prepareSnapshot(universeId, turnNumber, job.kind);

      let chapterFiles = (await readdir(join(universeDir(universeId), 'chapters')).catch(() => []))
        .filter((name) => /^\d{4}-.+\.md$/.test(name));
      let chapterNumber;
      if (isRewrite) {
        chapterNumber = job.chapterNumber;
        // Archive the old text and offers, drop later chapters and restore the pre-chapter state,
        // all before the agent runs and under this turn's execution lock. The request was bound to a
        // version at enqueue time and is revalidated here against the book as it is now.
        job.previousText = await prepareRewrite({
          universeId,
          chapterNumber,
          dropLater: job.dropLater,
          ancestryTurn: job.ancestryTurn ?? null,
          expectedTargetSha256: job.targetSha256 ?? null,
          expectedLaterChapters: job.authorizedLaterChapters ?? null
        });
        chapterFiles = (await readdir(join(universeDir(universeId), 'chapters')).catch(() => []))
          .filter((name) => /^\d{4}-.+\.md$/.test(name));
      } else {
        chapterNumber = chapterFiles.reduce((max, name) => Math.max(max, Number.parseInt(name.slice(0, 4), 10)), 0) + 1;
      }
      const startedMs = Date.now();
      if (job.kind !== 'export') job.chapterNumber = chapterNumber;
      // The running line is published once the chapter the turn writes is known, so the live console
      // and the interface name it instead of a placeholder.
      this.#emit(job, { type: 'job', job: this.snapshot(job) });

      // The narrative context of the turn is selected explicitly from the accepted view — the two most
      // recent accepted chapters, and nothing else by default — and the selection is recorded, so a
      // reader can see which version and which chapters a chapter was written from.
      const acceptedForContext = await acceptedChapters(universeId);
      const contextChapters = acceptedForContext.slice(-2).map((chapter) => chapter.file);
      const omittedChapters = acceptedForContext.slice(0, -2).map((chapter) => chapter.number);
      const prompt = turnPrompt({
        meta,
        job,
        chapterNumber,
        chapterFiles,
        contextChapters,
        omittedChapters,
        directions: job.directions ?? [],
        findings: job.findings ?? [],
        preserve: job.preserve ?? []
      });

      const record = {
        number: turnNumber,
        kind: job.kind === 'export' ? 'export' : job.kind === 'import' ? 'import' : 'chapter',
        rewrite: isRewrite,
        instructions: isRewrite ? job.message : null,
        dropLater: isRewrite ? job.dropLater === true : null,
        ancestryTurn: isRewrite ? (job.ancestryTurn ?? null) : null,
        targetSha256: isRewrite ? (job.targetSha256 ?? null) : null,
        authorizedLaterChapters: isRewrite ? (job.authorizedLaterChapters ?? null) : null,
        status: 'running',
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: null,
        durationMs: null,
        request: job.message,
        model: config.model,
        format: job.format,
        chapterNumber: job.kind === 'export' ? null : chapterNumber,
        context: job.kind === 'export'
          ? null
          : {
              version: snapshot?.accepted_version ?? null,
              chapters: contextChapters,
              omittedChapters
            },
        directions: job.directions ?? [],
        approval: job.approval ?? null,
        sourceChapter: job.sourceChapter ?? null,
        findings: job.findings ?? [],
        preserve: job.preserve ?? [],
        findingsVersion: job.findingsVersion ?? null,
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
        onSpawn: (child) => { job.child = child; },
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

      if (job.kind === 'import') {
        await verifyImportTurn({ universeId, range: job.importRange, record });
      } else if (job.kind !== 'export') {
        await verifyChapterTurn({ universeId, chapterNumber, chapterFiles, record });
      } else {
        await verifyExportTurn({ universeId, startedMs, record, format: job.format });
      }

      record.status = 'done';
      record.finishedAt = nowIso();
      record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
      record.answer = answer;
      record.agentLog = agentLog;
      await writeTurnRecord(universeId, record);
      // The ancestry of a chapter is the state that preceded it, and it is recorded once: successive
      // rewrites of that chapter generate from the same ancestry instead of from the latest rewrite.
      if (job.kind === 'chapter' && !isRewrite) {
        await writeAncestry(universeId, chapterNumber, turnNumber, snapshot?.accepted_version ?? null);
      }
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
      this.#retain();
      return;
    } catch (error) {
      const message = error instanceof UniverseError
        ? error.message
        : `internal error: ${error?.message ?? error}`;
      await failTurn({ universeId, job, turnNumber, message, interrupted: this.#stopping });
      job.status = 'error';
      job.finishedAt = nowIso();
      this.#retain();
      job.error = message;
      this.#emit(job, { type: 'error', message, job: this.snapshot(job) });
    }
  }
}

export const jobs = new JobManager();
