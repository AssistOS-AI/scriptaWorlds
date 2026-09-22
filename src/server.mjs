import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES, config, requireOmp } from './config.mjs';
import { SseConnection, readJsonBody, sendError, sendJson, serveFile, serveStatic } from './http.mjs';
import { jobs } from './jobs.mjs';
import { publicDir, skillsDir, syncUniverseSkills, universesDir } from './paths.mjs';
import { findTemplate, listTemplates } from './templates.mjs';
import { cellDetail, tableForClient } from './periodic.mjs';
import { acquireStoreLock } from './lock.mjs';
import { creationFromTemplate, readLibraryIndex, readTemplate } from './library.mjs';
import { firstChapterRequest } from './universe-prompts.mjs';
import { recoverAllUniverses } from './universe-state.mjs';
import {
  createUniverseFromImport,
  extractImport,
  listImports,
  loadImportContract,
  readImport,
  readImportStatus,
  receiveImport
} from './imports.mjs';
import {
  cancelAssessment,
  listApprovals,
  recordApproval,
  declareArcCompletion,
  listArcEvents,
  listAssessments,
  readAssessment,
  runOutputPath,
  recoverAssessments,
  retryAssessment,
  startAssessment
} from './assessments.mjs';
import {
  createUniverse,
  listUniverses,
  readChapter,
  readIdeas,
  readTurn,
  readUniverseDetail,
  readUniverseMeta,
  setUniverseLanguage,
  setUniverseStatus,
} from './universe.mjs';
import { UniverseError } from './errors.mjs';
import { handleFeedbackRoutes } from './feedback-routes.mjs';

const startedAt = Date.now();
let ompInfo = { version: '', command: config.ompBin };

function parseInteger(value, label) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UniverseError('BAD_NUMBER', `Invalid ${label}.`, 400);
  }
  return parsed;
}

/**
 * Maps the body of `POST /api/universes` to the fields `createUniverse` accepts.
 * The reader writes the starting situation in the `Premise` field; `opening` is the older name of
 * the same idea and stays accepted, and a template supplies its own law, summary and first opening.
 * A value sent by the client always wins over the template.
 */
export function universeInputFromBody(body = {}, template = null) {
  const law = String(body.law ?? '').trim() || template?.law || '';
  const premise = String(body.premise ?? '').trim()
    || String(body.opening ?? '').trim()
    || template?.openings?.[0]
    || '';
  return {
    title: body.title,
    provisionalTitle: '',
    summary: String(body.summary ?? '').trim() || template?.title || '',
    law,
    premise,
    language: body.language,
    elements: Array.isArray(body.elements) ? body.elements : []
  };
}

/**
 * The fields `createUniverse` receives, from either a template of the library (the book supplies the
 * law, the cells and the situation, and the reader may add their own ingredients on top) or the
 * request body itself. Text sent with neither a template nor an ingredient is the empty-template
 * case: the request the reader wrote becomes the law of the new world, so the free-text start is a
 * usable path instead of a `BAD_LAW` rejection.
 */
export function universeInputFromRequest({ body = {}, template = null, libraryTemplate = null } = {}) {
  if (libraryTemplate) {
    return creationFromTemplate(libraryTemplate, {
      language: body.language,
      prompt: body.prompt,
      elements: Array.isArray(body.elements) ? body.elements : []
    });
  }
  const input = universeInputFromBody(body, template);
  const typed = String(body.prompt ?? '').trim();
  if (!input.law.trim() && input.elements.length === 0 && typed.length >= 24) {
    input.law = typed;
  }
  return input;
}

async function handleUniverses(req, res, segments, url) {
  const [, , id, sub, extra] = segments;

  if (!id) {
    if (req.method === 'GET') {
      sendJson(res, 200, { universes: await listUniverses() });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req, config.maxBodyBytes);
      const template = body.templateId ? await findTemplate(String(body.templateId)) : null;
      // Two ways to start: from a template of the library (the book supplies the law, the cells and
      // the situation) or from the body itself (the reader composed the ingredients).
      const librarySlug = String(body.library ?? '').trim();
      const libraryTemplate = librarySlug ? await readTemplate(librarySlug) : null;
      const universe = await createUniverse(universeInputFromRequest({ body, template, libraryTemplate }));
      console.log(`[universe] created: ${universe.id} (${universe.title}, ${universe.language}, law ${universe.law.length} chars)`);
      let job = null;
      if (body.start === true) {
        const typed = String(body.prompt ?? '').trim();
        // The first chapter gets the reader's own words: the template text as they edited it, or the
        // request they wrote. Only when both are empty does the server build a structured request.
        const message = typed
          || String(libraryTemplate?.request ?? '').trim()
          || firstChapterRequest({
            language: universe.language,
            title: universe.title,
            law: universe.law,
            premise: universe.premise,
            elements: universe.elements ?? []
          });
        job = await jobs.start({ universeId: universe.id, message, kind: 'chapter' });
        console.log(`[job] ${job.id} first chapter for ${universe.id}`);
      }
      sendJson(res, 201, { universe, job });
      return true;
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  await readUniverseMeta(id);

  if (!sub) {
    if (req.method !== 'GET') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    const detail = await readUniverseDetail(id);
    detail.activeJob = jobs.activeForUniverse(id);
    detail.queuedJobs = jobs.queuedForUniverse(id);
    sendJson(res, 200, detail);
    return true;
  }

  if (sub === 'open' || sub === 'close') {
    if (req.method !== 'POST') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    const universe = await setUniverseStatus(id, sub === 'open' ? 'open' : 'closed');
    console.log(`[universe] ${universe.id} → ${universe.status}`);
    sendJson(res, 200, { universe });
    return true;
  }

  if (sub === 'settings') {
    if (req.method !== 'POST') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    const body = await readJsonBody(req, config.maxBodyBytes);
    const universe = body.language
      ? await setUniverseLanguage(id, body.language)
      : await readUniverseMeta(id);
    console.log(`[universe] ${id} settings: language=${universe.language}`);
    sendJson(res, 200, { universe });
    return true;
  }

  if (sub === 'ideas') {
    if (req.method !== 'GET') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    sendJson(res, 200, { ideas: await readIdeas(id) });
    return true;
  }

  if (sub === 'chapters') {
    if (req.method === 'GET' && extra !== undefined) {
      const number = parseInteger(extra, 'chapter number');
      sendJson(res, 200, { chapter: await readChapter(id, number) });
      return true;
    }
    if (req.method === 'POST' && extra !== undefined && segments[5] === 'rewrite') {
      const number = parseInteger(extra, 'chapter number');
      const body = await readJsonBody(req, config.maxBodyBytes);
      const instructions = String(body.instructions ?? '').trim();
      if (instructions.length < 10) {
        throw new UniverseError(
          'BAD_INSTRUCTIONS',
          'Describe what is wrong with the chapter and what should change (at least one sentence).',
          400
        );
      }
      const meta = await readUniverseMeta(id);
      if (meta.status === 'closed') {
        throw new UniverseError('CLOSED', 'This universe is closed. Reopen it to rewrite it.', 409);
      }
      const detail = await readUniverseDetail(id);
      const chapter = detail.chapters.find((entry) => entry.number === number);
      if (!chapter) throw new UniverseError('NOT_FOUND', `Chapter ${number} does not exist.`, 404);

      const laterChapters = detail.chapters.filter((entry) => entry.number > number).map((entry) => entry.number);
      if (laterChapters.length > 0 && body.dropLater !== true) {
        const error = new UniverseError(
          'LATER_CHAPTERS',
          `Rewriting chapter ${number} would drop chapters ${laterChapters.join(', ')}.`,
          409
        );
        error.laterChapters = laterChapters;
        throw error;
      }

      // The handler only validates and enqueues. Archiving the old text, dropping later chapters and
      // restoring the pre-chapter state happen inside the job, under the per-universe execution lock.
      const job = await jobs.startRewrite({
        universeId: id,
        chapterNumber: number,
        instructions,
        dropLater: laterChapters.length > 0 && body.dropLater === true,
        findings: body.findings ?? [],
        preserve: body.preserve ?? [],
        sourceVersion: typeof body.sourceVersion === 'string' ? body.sourceVersion : null
      });
      console.log(`[job] ${job.id} rewriting chapter ${number} in ${id}${laterChapters.length ? ` (dropped: ${laterChapters.join(', ')})` : ''}`);
      sendJson(res, 202, { job, droppedChapters: laterChapters });
      return true;
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  if (sub === 'assessments') {
    // The separate design and review phases: a frozen packet of one accepted version, run outside the
    // book. They never write into `universes/`, so a report can never roll back a chapter.
    if (extra === undefined) {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          runs: await listAssessments(id),
          arcEvents: await listArcEvents(id),
          workspace: 'assessments'
        });
        return true;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req, config.maxBodyBytes);
        const run = await startAssessment({
          universeId: id,
          phase: body.phase ?? 'metrics',
          profile: body.profile ?? null,
          annotations: body.annotations ?? null,
          corpus: body.corpus ?? null,
          fromTurn: Number.isInteger(body.fromTurn) ? body.fromTurn : null,
          trigger: 'requested',
          force: body.force === true,
          scope: body.scope ?? null,
          chapters: Array.isArray(body.chapters) ? body.chapters : null,
          aggregate: body.aggregate === true,
          intention: body.intention ?? null,
          weights: body.weights ?? null,
          // Who produces the semantic observations: the caller's document, the configured evaluator, or
          // nobody. The operator default is `ASSESSMENT_MODE`, so the interface sends nothing at all.
          mode: body.mode ?? null
        });
        console.log(`[assess] ${run.run_id} ${run.phase} ${run.status} for ${id}${run.deduplicated ? ' (deduplicated)' : ''}`);
        sendJson(res, 202, { run });
        return true;
      }
      throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    }
    if (segments[5] === 'report') {
      // The files one run published, served from its own result directory: the bundle and the views the
      // interface renders. Only names the run itself lists are readable, so a path cannot escape it.
      if (req.method !== 'GET') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      await serveFile(res, await runOutputPath(id, extra, segments[6]), { download: false });
      return true;
    }
    if (req.method === 'GET') {
      // `/assessments` on an existing book: `GET /api/universes/:id/assessments` is the list above.
      sendJson(res, 200, { run: await readAssessment(id, extra) });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req, config.maxBodyBytes).catch(() => ({}));
      if (body.action === 'cancel') {
        sendJson(res, 200, { run: await cancelAssessment(id, extra) });
        return true;
      }
      if (body.action === 'retry') {
        sendJson(res, 202, { run: await retryAssessment(id, extra) });
        return true;
      }
      throw new UniverseError('BAD_ACTION', 'Unknown assessment action (cancel|retry).', 400);
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  if (sub === 'approvals') {
    // The human decision that lets a design or craft proposal reach a later writing request (§8.4).
    if (extra === undefined && req.method === 'GET') {
      sendJson(res, 200, { approvals: await listApprovals(id) });
      return true;
    }
    if (extra === undefined && req.method === 'POST') {
      const body = await readJsonBody(req, config.maxBodyBytes);
      const approval = await recordApproval({
        universeId: id,
        proposal: body.proposal ?? null,
        decision: body.decision,
        reviewer: body.reviewer ?? null,
        directions: body.directions ?? [],
        version: typeof body.version === 'string' ? body.version : null
      });
      console.log(`[assess] approval ${approval.decision} for ${id} at ${String(approval.version).slice(0, 18)}… (${approval.directions.length} directions)`);
      sendJson(res, 201, { approval });
      return true;
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  if (sub === 'arc-events') {
    if (extra === undefined && req.method === 'GET') {
      sendJson(res, 200, { events: await listArcEvents(id) });
      return true;
    }
    if (extra === undefined && req.method === 'POST') {
      const body = await readJsonBody(req, config.maxBodyBytes);
      const declared = await declareArcCompletion({
        universeId: id,
        arcId: body.arcId,
        note: body.note ?? null,
        phase: body.phase ?? 'metrics',
        profile: body.profile ?? null,
        aggregate: body.aggregate === true,
        intention: body.intention ?? null
      });
      console.log(`[assess] arc ${declared.event.arc_id} complete at ${declared.event.version.slice(0, 18)}… for ${id}${declared.run ? '' : ' (no profile, no run)'}`);
      sendJson(res, 202, declared);
      return true;
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  if (sub === 'turns') {
    if (extra === undefined) {
      if (req.method !== 'POST') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      const body = await readJsonBody(req, config.maxBodyBytes);
      const kind = body.kind ?? 'chapter';
      if (!['chapter', 'export'].includes(kind)) {
        throw new UniverseError('BAD_KIND', 'Unknown turn kind (chapter|export).', 400);
      }
      const format = body.format ?? 'both';
      if (!['docx', 'pdf', 'both'].includes(format)) {
        throw new UniverseError('BAD_FORMAT', 'Unknown format (docx|pdf|both).', 400);
      }
      const job = await jobs.start({
        universeId: id,
        message: body.message,
        kind,
        directions: body.directions,
        approval: body.approval,
        sourceChapter: body.sourceChapter,
        format
      });
      console.log(`[job] ${job.id} ${job.kind} queued for ${id} (position ${job.queuePosition})`);
      sendJson(res, 202, { job });
      return true;
    }
    if (segments[5] === 'retry') {
      if (req.method !== 'POST') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
      const number = parseInteger(extra, 'turn number');
      const job = await jobs.retry(id, number);
      console.log(`[job] ${job.id} retried for ${id}`);
      sendJson(res, 202, { job });
      return true;
    }
    if (req.method !== 'GET') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    const number = parseInteger(extra, 'turn number');
    sendJson(res, 200, { turn: await readTurn(id, number) });
    return true;
  }

  if (sub === 'events') {
    if (req.method !== 'GET') throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    const jobId = url.searchParams.get('job');
    if (jobId) {
      const job = jobs.get(jobId);
      if (!job || job.universeId !== id) throw new UniverseError('NOT_FOUND', 'Job not found.', 404);
      const connection = new SseConnection(req, res);
      for (const event of jobs.events(jobId)) connection.send(event);
      if (job.status === 'done' || job.status === 'error') {
        connection.close();
        return true;
      }
      const unsubscribe = jobs.subscribe(jobId, (event) => {
        connection.send(event);
        if (event.type === 'done' || event.type === 'error') {
          unsubscribe();
          connection.close();
        }
      });
      return true;
    }
    // Stream for the whole universe: all turns, the ones running and the ones started later.
    const connection = new SseConnection(req, res);
    const active = jobs.activeForUniverse(id);
    if (active) for (const event of jobs.events(active.id)) connection.send(event);
    const unsubscribe = jobs.subscribeUniverse(id, (event) => {
      connection.send(event);
      if (event.type === 'done' || event.type === 'error') {
        const job = event.job;
        if (job?.universeId === id) connection.send({ type: 'refresh', universeId: id, jobId: event.jobId ?? job.id });
      }
    });
    req.on('close', unsubscribe);
    return true;
  }
  // The reader-feedback surface of §8.7 lives in its own module, so this router stays a readable
  // sequence of routes inside its size gate; it answers every feedback and reader route itself.
  if (await handleFeedbackRoutes({ req, res, segments, id, sub, extra, url })) return true;

  throw new UniverseError('NOT_FOUND', 'Unknown route.', 404);
}

/**
 * The book import: an uploaded PDF or DOCX becomes a universe the team can review, analyse and rewrite
 * like any other book. The bytes are streamed to the workspace outside `universes/`, the extraction is
 * deterministic, and the universe itself is written by an import turn under `scripta-import`.
 */
async function handleImports(req, res, segments, url) {
  const importId = segments[2] ? decodeURIComponent(segments[2]) : null;
  const action = segments[3] ?? null;

  if (importId === null) {
    if (req.method === 'GET') {
      // The turn limits belong to the import skill, so the list reports the published ones rather than a
      // number the server keeps for itself.
      const contract = await loadImportContract(skillsDir).catch(() => null);
      sendJson(res, 200, {
        imports: await listImports(),
        maxBytes: config.importMaxBytes,
        turnLimits: contract ? contract.limits : null
      });
      return;
    }
    if (req.method === 'POST') {
      const record = await receiveImport({
        stream: req,
        filename: req.headers['x-filename'] ?? url.searchParams.get('filename'),
        format: req.headers['x-format'] ?? null
      });
      console.log(`[import] ${record.import_id} ${record.filename} ${Math.round(record.bytes / 1024)} KiB`);
      sendJson(res, 202, { import: record });
      return;
    }
    throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  if (req.method === 'GET' && action === null) {
    // The record carries how far the import has come: an imported book is written into the store one
    // bounded turn at a time, so the reader needs both what arrived and what is left.
    sendJson(res, 200, await readImportStatus(importId));
    return;
  }

  if (req.method === 'POST' && action === 'universe') {
    const body = await readJsonBody(req, config.maxBodyBytes).catch(() => ({}));
    const created = await createUniverseFromImport({
      importId,
      title: typeof body.title === 'string' ? body.title : null,
      language: typeof body.language === 'string' ? body.language : null
    });
    console.log(`[import] ${importId} → ${created.universe.id}${created.turn ? ` turn ${created.turn.turnNumber} chapters ${created.range.from}-${created.range.to}` : ' (complete)'}`);
    sendJson(res, 202, { universe: created.universe, turn: created.turn, range: created.range, progress: created.progress });
    return;
  }

  if (req.method === 'POST' && action === 'extract') {
    const record = await readImport(importId);
    if (record.state === 'received' || record.state === 'error') {
      // Extraction runs in the background: a long book must not hold an HTTP request open, and the
      // reader watches the record's state instead.
      void extractImport(importId).catch((error) => {
        console.log(`[import] ${importId} extraction failed: ${error?.code ?? error?.message}`);
      });
    }
    sendJson(res, 202, { import: await readImport(importId) });
    return;
  }

  throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
}

async function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] !== 'api') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new UniverseError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
    }
    await serveStatic(res, publicDir, url.pathname);
    return;
  }

  if (segments[1] === 'health') {
    sendJson(res, 200, {
      ok: true,
      omp: ompInfo.command,
      ompVersion: ompInfo.version,
      model: config.model,
      maxConcurrentJobs: config.maxConcurrentJobs === 0 ? null : config.maxConcurrentJobs,
      uptimeMs: Date.now() - startedAt
    });
    return;
  }

  if (segments[1] === 'config') {
    sendJson(res, 200, {
      model: config.model,
      languages: LANGUAGES,
      formats: ['docx', 'pdf', 'both'],
      maxConcurrentJobs: config.maxConcurrentJobs === 0 ? null : config.maxConcurrentJobs,
      chapterWords: { min: config.chapterMinWords, max: config.chapterMaxWords }
    });
    return;
  }

  // The design instrument of the project: families, operators and the 180 abstract cells the
  // reader composes a new universe from.
  if (segments[1] === 'table') {
    // `/api/table` is the grid; `/api/table/cells/<symbol>` is everything the book says about one
    // cell, read only when a reader opens it.
    if (segments[2] === 'cells' && segments[3]) {
      sendJson(res, 200, { cell: await cellDetail(decodeURIComponent(segments[3])) });
      return;
    }
    sendJson(res, 200, await tableForClient());
    return;
  }

  // The start templates read from the book: the index for the list, one template for the request
  // field when the reader picks it.
  if (segments[1] === 'library') {
    if (segments[2]) {
      sendJson(res, 200, { template: await readTemplate(decodeURIComponent(segments[2])) });
      return;
    }
    sendJson(res, 200, await readLibraryIndex());
    return;
  }

  if (segments[1] === 'templates') {
    const language = String(url.searchParams.get('language') ?? 'ro').slice(0, 2).toLowerCase();
    const templates = await listTemplates(language);
    sendJson(res, 200, { templates, count: templates.length });
    return;
  }

  if (segments[1] === 'imports') {
    await handleImports(req, res, segments, url);
    return;
  }

  if (segments[1] === 'universes') {
    await handleUniverses(req, res, segments, url);
    return;
  }

  if (segments[1] === 'jobs' && segments[2]) {
    const job = jobs.get(segments[2]);
    if (!job) throw new UniverseError('NOT_FOUND', 'Job not found.', 404);
    sendJson(res, 200, { job });
    return;
  }

  if (segments[1] === 'files' && segments[2] && segments[3]) {
    const id = segments[2];
    const name = decodeURIComponent(segments[3]);
    if (!/^[A-Za-z0-9._-]+\.(pdf|docx)$/i.test(name)) {
      throw new UniverseError('BAD_NAME', 'Invalid file name.', 400);
    }
    await readUniverseMeta(id);
    await serveFile(res, join(universesDir, id, 'exports', name), { download: true });
    return;
  }

  throw new UniverseError('NOT_FOUND', 'Unknown route.', 404);
}

function lanAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

async function main() {
  await mkdir(universesDir, { recursive: true });
  // Before anything touches the store: only one server may recover turns and resume the queue,
  // otherwise each instance marks the other's running turns as interrupted.
  const lock = await acquireStoreLock(universesDir).catch((error) => {
    console.error(`[start] ${error.message}`);
    process.exit(1);
  });
  ompInfo = await requireOmp().catch((error) => {
    console.error(`[start] ${error.message}`);
    process.exit(1);
  });

  const recovered = await recoverAllUniverses();
  const recoveredRuns = await recoverAssessments();
  if (recoveredRuns.interrupted.length > 0 || recoveredRuns.resumed.length > 0) {
    console.log(`[start] assessments: ${recoveredRuns.resumed.length} resumed, ${recoveredRuns.interrupted.length} interrupted (retryable)`);
  }
  const resumed = await jobs.resumeQueued(recovered.filter((entry) => entry.action === 'queued'));
  for (const entry of recovered) {
    if (entry.action === 'interrupted') {
      console.warn(`[start] interrupted turn (retryable from the interface): ${entry.universeId} #${entry.turnNumber}`);
    }
  }
  if (resumed > 0) console.log(`[start] ${resumed} queued turns resumed automatically`);
  for (const universe of await listUniverses()) {
    await syncUniverseSkills(join(universesDir, universe.id));
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (!res.headersSent) sendError(res, error);
      else res.end();
      if (!error?.status || error.status >= 500) {
        console.error(`[error] ${req.method} ${req.url}:`, error);
      }
    });
  });

  server.listen(config.port, config.host, async () => {
    const universes = await listUniverses();
    console.log(`scriptaWorlds is running on http://127.0.0.1:${config.port} (bind ${config.host}:${config.port})`);
    for (const address of lanAddresses()) {
      console.log(`  on the network: http://${address}:${config.port} — open it on your phone`);
    }
    console.log(`  agent: ${ompInfo.command} ${ompInfo.version} · model: ${config.model}`);
    const cap = config.maxConcurrentJobs === 0 ? 'unlimited' : String(config.maxConcurrentJobs);
    console.log(`  universes: ${universes.length} · concurrent turns: ${cap}`);
    console.log(`  directories: universes=${universesDir}`);
  });

  // One shutdown path, and ownership of the store is released last: a second server must not acquire
  // the store while a child process of this one is still writing into it. The handler is idempotent so
  // two signals (or a signal during a slow shutdown) cannot race the release.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[stop] shutting the server down…');
    const stopped = await jobs.stop({ timeoutMs: 15_000 });
    if (stopped.stopped > 0) {
      console.log(`[stop] stopped ${stopped.stopped} running turn(s)${stopped.killed > 0 ? `, killed ${stopped.killed}` : ''}`);
    }
    await new Promise((resolve) => server.close(resolve));
    await lock.release();
    console.log('[stop] store lock released; the server is gone');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Only `node src/server.mjs` starts a server. Importing this module (the check suite reads
// `universeInputFromBody`) must never take the store lock, run recovery or resume the queue: a
// second instance would mark the turns of the running one as interrupted.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error('[fatal]', error);
    process.exit(1);
  });
}
