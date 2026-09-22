import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const CONTENT_TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
}));

export function contentTypeFor(path) {
  return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream';
}

export function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * Sends a document the client keeps instead of rendering: a body that was built in memory, so there is
 * no file to stream (an export of the feedback store is never written to disk).
 */
export function sendDownload(res, filename, body) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(200, {
    'Content-Type': contentTypeFor(filename),
    'Content-Length': bytes.length,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    'Cache-Control': 'no-store'
  });
  res.end(bytes);
}

export function sendError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = error?.code ?? 'INTERNAL';
  const message = status === 500 ? `internal error: ${error?.message ?? error}` : String(error?.message ?? error);
  const payload = { error: { code, message } };
  // Extra, machine-readable fields travel with the error so the client can act on them
  // (for example `laterChapters` on LATER_CHAPTERS, used to confirm a destructive rewrite).
  for (const key of ['laterChapters', 'details']) {
    if (error?.[key] !== undefined) payload.error[key] = error[key];
  }
  sendJson(res, status, payload);
}

export async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      error.code = 'TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected object');
    }
    return parsed;
  } catch {
    const error = new Error('Invalid JSON body.');
    error.status = 400;
    error.code = 'BAD_JSON';
    throw error;
  }
}

export async function serveFile(res, absolutePath, { download = false, cache = 'no-store' } = {}) {
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'File not found.' } });
    return;
  }
  if (!info.isFile()) {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'File not found.' } });
    return;
  }
  const headers = {
    'Content-Type': contentTypeFor(absolutePath),
    'Content-Length': info.size,
    'Cache-Control': cache
  };
  if (download) {
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(absolutePath.split('/').pop())}"`;
  }
  res.writeHead(200, headers);
  if (res.req?.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(absolutePath).pipe(res);
}

export async function serveStatic(res, rootDir, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = clean === '/' ? '/index.html' : clean;
  const normalized = normalize(target).replace(/^([/\\])+/, '');
  if (normalized.split(sep).includes('..')) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Forbidden path.' } });
    return;
  }
  await serveFile(res, join(rootDir, normalized), { cache: 'no-cache' });
}

export class SseConnection {
  constructor(req, res) {
    this.closed = false;
    this.#res = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': conectat\n\n');
    this.#heartbeat = setInterval(() => {
      if (!this.closed) res.write(': ping\n\n');
    }, 15_000);
    this.#heartbeat.unref?.();
    req.on('close', () => this.close());
    req.on('error', () => this.close());
  }

  #res;
  #heartbeat;

  send(event) {
    if (this.closed) return;
    this.#res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.#heartbeat);
    this.#res.end();
  }
}
