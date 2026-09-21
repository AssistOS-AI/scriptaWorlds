import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LANGUAGES, config, requireOmp } from './config.mjs';
import { SseConnection, readJsonBody, sendError, sendJson, serveFile, serveStatic } from './http.mjs';
import { jobs } from './jobs.mjs';
import { publicDir, syncUniverseSkills, universesDir } from './paths.mjs';
import { findTemplate, listTemplates } from './templates.mjs';
import { cellDetail, tableForClient } from './periodic.mjs';
import { acquireStoreLock } from './lock.mjs';
import { creationFromTemplate, readLibraryIndex, readTemplate } from './library.mjs';
import { archiveChapter, dropChaptersFrom } from './universe-chapters.mjs';
import { firstChapterRequest } from './universe-prompts.mjs';
import { recoverAllUniverses, restoreState } from './universe-state.mjs';
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
 * request body itself.
 */
export function universeInputFromRequest({ body = {}, template = null, libraryTemplate = null } = {}) {
  if (libraryTemplate) {
    return creationFromTemplate(libraryTemplate, {
      language: body.language,
      prompt: body.prompt,
      elements: Array.isArray(body.elements) ? body.elements : []
    });
  }
  return universeInputFromBody(body, template);
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

      const turnNumber = chapter.turnNumber;
      const previous = await archiveChapter(id, number);
      const droppedChapters = body.dropLater === true ? await dropChaptersFrom(id, number + 1) : [];
      for (const dropped of droppedChapters) await archiveChapter(id, dropped).catch(() => {});
      if (turnNumber !== null) await restoreState(id, turnNumber);

      const job = await jobs.startRewrite({
        universeId: id,
        chapterNumber: number,
        instructions,
        previousText: previous?.text ?? ''
      });
      console.log(`[job] ${job.id} rewriting chapter ${number} in ${id}${droppedChapters.length ? ` (dropped: ${droppedChapters.join(', ')})` : ''}`);
      sendJson(res, 202, { job, droppedChapters });
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

  throw new UniverseError('NOT_FOUND', 'Unknown route.', 404);
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

  const shutdown = async () => {
    console.log('\n[stop] shutting the server down…');
    await lock.release();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
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
