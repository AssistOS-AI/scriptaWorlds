// One turn, apart from the queue machinery: which prompt family the turn needs, what the agent must
// have produced before the turn counts as done, and the repair of the store when the turn fails.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { config } from './config.mjs';
import { nowIso, pad, readJson, readText } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { skillsDir, universeDir } from './paths.mjs';
import { buildChapterPrompt, buildExportPrompt, buildRewritePrompt } from './prompts.mjs';
import {
  acceptedChapters,
  archiveChapter,
  chapterTitle,
  countWords,
  dropChaptersFrom,
  findChapterFile,
  normalizeOffer,
  removeChapterFiles,
  writeTurnRecord
} from './universe-chapters.mjs';
import { dropAncestry, readAncestry, restoreCanon, restoreState } from './universe-state.mjs';
import { sha256Hex } from './version.mjs';

// A universe whose displayed title is still a whole sentence (an old, long auto-title) is renamed by
// ALA at the next chapter: the sentence moves to `summary`.
function namesItself(meta) {
  return meta.autoTitle === true || String(meta.title ?? '').split(/\s+/).filter(Boolean).length > 7;
}

/** Run the skill's chapter validator as a child process and return its JSON report. */
function runChapterValidator(universeId, chapterNumber) {
  return new Promise((resolve) => {
    const args = [
      join(skillsDir, 'scripta-ala', 'scripts', 'validate-chapter.mjs'),
      '--universe', universeDir(universeId),
      '--chapter', pad(chapterNumber),
      '--min', String(config.chapterMinWords),
      '--max', String(config.chapterMaxWords)
    ];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ ok: false, code: null, stdout, stderr: String(error.message) }));
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').pop();
      let report = null;
      try {
        report = line ? JSON.parse(line) : null;
      } catch {
        report = null;
      }
      resolve({ ok: code === 0, code, stdout, stderr, report });
    });
  });
}

/**
 * The store side of a rewrite, run under the per-universe execution lock. The request is bound to the
 * version it was written for: when the target no longer has the hash it had when the reader asked, or
 * when later chapters appeared that the request did not authorise dropping, the rewrite is refused as
 * stale instead of being reinterpreted. Anything that is archived is archived before it is removed, and
 * an archive that fails stops the removal rather than losing text.
 *
 * The generation base is the chapter's *ancestry* — the state that preceded the chapter when it was
 * first written — which stays the same through successive rewrites. The rollback reference is the
 * snapshot of the current accepted book, taken by the caller for this turn.
 */
export async function prepareRewrite({ universeId, chapterNumber, dropLater, ancestryTurn, expectedTargetSha256, expectedLaterChapters }) {
  // Both the target and the later chapters are read from the accepted view: a candidate file left by a
  // running or failed turn is not a chapter this request may rewrite or drop.
  const accepted = await acceptedChapters(universeId);
  const current = accepted.find((chapter) => chapter.number === chapterNumber) ?? null;
  if (!current) {
    throw new UniverseError('NO_CHAPTER', `Chapter ${chapterNumber} does not exist to rewrite.`, 404);
  }
  if (expectedTargetSha256) {
    const bytes = await readText(join(universeDir(universeId), current.file), '');
    if (sha256Hex(bytes) !== expectedTargetSha256) {
      throw new UniverseError(
        'STALE_REQUEST',
        `Chapter ${chapterNumber} changed after this rewrite was requested; ask again from the current version.`,
        409
      );
    }
  }
  const later = accepted
    .filter((entry) => entry.number > chapterNumber)
    .map((entry) => entry.number);
  const unauthorised = later.filter((number) => !Array.isArray(expectedLaterChapters) || !expectedLaterChapters.includes(number));
  if (unauthorised.length > 0 && !dropLater) {
    throw new UniverseError(
      'STALE_REQUEST',
      `Chapters ${unauthorised.join(', ')} appeared after this rewrite was requested and the request did not authorise dropping them.`,
      409
    );
  }
  const previous = await archiveChapter(universeId, chapterNumber);
  if (!previous) {
    throw new UniverseError('NO_CHAPTER', `Chapter ${chapterNumber} does not exist to rewrite.`, 404);
  }
  if (later.length > 0) {
    for (const number of later) await archiveChapter(universeId, number);
  }
  if (dropLater && later.length > 0) {
    await dropChaptersFrom(universeId, chapterNumber + 1);
    for (const number of later) await dropAncestry(universeId, number);
  }
  const ancestry = ancestryTurn ?? (await readAncestry(universeId, chapterNumber))?.source_turn ?? null;
  if (!ancestry) {
    throw new UniverseError(
      'NO_ANCESTRY',
      `Chapter ${chapterNumber} has no recorded pre-chapter state; reconstruct the state that preceded it before rewriting, or rewrite the last chapter instead.`,
      409
    );
  }
  const restored = await restoreCanon(universeId, ancestry);
  if (!restored.ok) {
    throw new UniverseError(
      'NO_ANCESTRY',
      `The pre-chapter state of chapter ${chapterNumber} (turn ${ancestry}) is ${restored.reason === 'missing' ? 'missing' : `unusable (${restored.reason})`}; reconstruct it before rewriting.`,
      409
    );
  }
  await removeChapterFiles(universeId, chapterNumber);
  return previous.text;
}

/** The prompt of this turn: a rewrite, a new chapter or the printed edition. */
export function turnPrompt({ meta, job, chapterNumber, chapterFiles, contextChapters = [], omittedChapters = [], directions = [], findings = [], preserve = [] }) {
  const elements = Array.isArray(meta.elements) ? meta.elements : [];
  if (job.kind === 'rewrite') {
    return buildRewritePrompt({
      title: meta.title,
      law: meta.law,
      language: meta.language,
      chapterNumber,
      previousText: job.previousText ?? '',
      instructions: job.message,
      contextChapters,
      omittedChapters,
      directions,
      findings,
      preserve,
      minWords: config.chapterMinWords,
      maxWords: config.chapterMaxWords,
      elements,
      needsTitle: namesItself(meta)
    });
  }
  if (job.kind === 'chapter') {
    return buildChapterPrompt({
      title: meta.title,
      law: meta.law,
      language: meta.language,
      chapterNumber,
      message: job.message,
      contextChapters,
      omittedChapters,
      directions,
      minWords: config.chapterMinWords,
      maxWords: config.chapterMaxWords,
      elements,
      needsTitle: namesItself(meta)
    });
  }
  return buildExportPrompt({
    title: meta.title,
    law: meta.law,
    language: meta.language,
    chapterCount: chapterFiles.length,
    message: job.message,
    format: job.format
  });
}

/**
 * The chapter the agent should have written. Acceptance runs the skill's own validator at the server
 * boundary: a unique chapter file, a valid plan, valid canon/threads/atlas schemas and a usable offer
 * are required before the turn can become `done`. A short or long chapter remains a warning.
 */
export async function verifyChapterTurn({ universeId, chapterNumber, chapterFiles, record }) {
  const entries = (await readdir(join(universeDir(universeId), 'chapters')).catch(() => []))
    .filter((name) => name.startsWith(`${pad(chapterNumber)}-`) && name.endsWith('.md'));
  if (entries.length === 0) {
    throw new UniverseError('NO_CHAPTER', 'The agent did not write the chapter file.', 502);
  }
  if (entries.length > 1) {
    throw new UniverseError(
      'DUPLICATE_CHAPTER',
      `Chapter ${chapterNumber} has ${entries.length} files: ${entries.join(', ')}`,
      502
    );
  }

  const validation = await runChapterValidator(universeId, chapterNumber);
  const report = validation.report;
  if (!report || validation.ok !== true || report.ok !== true) {
    const errors = Array.isArray(report?.errors) && report.errors.length > 0
      ? report.errors.join('; ')
      : 'the validator produced no report';
    throw new UniverseError('INVALID_CHAPTER', `The chapter fails the skill's structural checks: ${errors}`, 502);
  }

  const file = await findChapterFile(universeId, chapterNumber);
  const markdown = await readText(file.path, '');
  record.chapterFile = `chapters/${file.name}`;
  record.chapterTitle = chapterTitle(markdown);
  record.words = countWords(markdown);
  // The validator received the configured word band, so its warnings already carry the length
  // observation: copy them verbatim instead of measuring the chapter a second time and risking a
  // duplicated or contradictory note on the durable record.
  for (const warning of report.warnings ?? []) {
    if (!record.warnings.includes(warning)) record.warnings.push(warning);
  }
  if (record.rewrite) {
    const before = new Set(chapterFiles);
    const after = (await readdir(join(universeDir(universeId), 'chapters')).catch(() => []))
      .filter((name) => /^\d{4}-.+\.md$/.test(name));
    const unexpected = after.filter((name) => !before.has(name) && Number.parseInt(name.slice(0, 4), 10) !== chapterNumber);
    if (unexpected.length > 0) {
      record.warnings.push(`unexpected files after the rewrite: ${unexpected.join(', ')}`);
    }
  }
  const offerPath = join(universeDir(universeId), 'chapters', `${pad(chapterNumber)}-offer.json`);
  const offer = normalizeOffer(await readJson(offerPath, null));
  if (offer) record.offer = offer;
}

/**
 * The edition the agent should have rendered, verified as documents rather than by sniffing headers:
 * the skill's own verifier opens the PDF structure, the DOCX archive and its Word parts, checks every
 * glyph the requested faces must cover, and cross-checks the edition manifest the renderer wrote
 * against the files on disk. A missing requested format is `NO_EXPORT`; a document that is empty,
 * truncated, wrong-format, duplicated or missing a glyph is `INVALID_EXPORT`. An edition that rendered
 * an older accepted version stays acceptable and is reported as historical instead of being refused.
 */
export async function verifyExportTurn({ universeId, startedMs, record, format = 'both' }) {
  const report = await runEditionVerifier(universeId, format, startedMs);
  if (!report) {
    throw new UniverseError(
      'INVALID_EXPORT',
      'The edition could not be verified: the print skill produced no usable verification report.',
      502
    );
  }
  const failures = Array.isArray(report.errors) ? report.errors : [];
  const missing = failures.filter((entry) => String(entry?.code) === 'NO_EXPORT');
  if (report.ok !== true) {
    if (missing.length > 0 && missing.length === failures.length) {
      throw new UniverseError('NO_EXPORT', missing.map((entry) => entry.message).join('; '), 502);
    }
    const detail = failures.map((entry) => `${entry?.code ?? 'INVALID_EXPORT'}: ${entry?.message ?? 'unknown'}`).join('; ');
    throw new UniverseError('INVALID_EXPORT', `The requested edition is not a valid document: ${detail}`, 502);
  }
  record.exports = (report.documents ?? []).map((document) => ({
    format: document.format,
    name: String(document.path ?? '').split('/').pop(),
    bytes: document.bytes,
    pages: document.pages ?? null,
    sha256: document.sha256 ?? null,
    historical: document.historical === true
  }));
  for (const warning of report.warnings ?? []) {
    const text = warning?.message ?? String(warning);
    if (!record.warnings.includes(text)) record.warnings.push(text);
  }
}

/** Run the print skill's edition verifier and parse its single JSON line, or `null`. */
function runEditionVerifier(universeId, format, startedMs) {
  return new Promise((resolve) => {
    const args = [
      join(skillsDir, 'scripta-book-export', 'scripts', 'verify-edition.mjs'),
      '--universe', universeDir(universeId),
      '--format', format,
      '--since', String(startedMs)
    ];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const line = stdout.trim().split('\n').pop();
      try {
        resolve(line ? JSON.parse(line) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * The failure path of a turn: restore the accepted book from the snapshot taken before the turn, and
 * record the outcome so the interface can offer a retry. The restore is what puts the bytes *and* the
 * membership back, so a chapter the agent invented, a renamed target or an extra plan disappears with
 * the state. When the snapshot cannot be used, the turn becomes `recovery_required` and the universe
 * refuses further work: the honest state of the book is then unknown, and pretending otherwise would
 * be worse than a stopped book.
 */
export async function failTurn({ universeId, job, turnNumber, message, interrupted = false }) {
  if (turnNumber === null) return;
  const existing = await readText(join(universeDir(universeId), 'turns', `${pad(turnNumber)}.json`), null);
  let record = { number: turnNumber, kind: job.kind, createdAt: job.createdAt, request: job.message };
  if (existing) {
    try {
      record = JSON.parse(existing);
    } catch {
      record = { number: turnNumber, kind: job.kind, createdAt: job.createdAt, request: job.message };
    }
  }
  const restored = await restoreState(universeId, turnNumber)
    .catch((error) => ({ ok: false, reason: `restore failed: ${error?.message ?? error}` }));
  record.status = restored.ok ? (interrupted ? 'interrupted' : 'error') : 'recovery_required';
  record.error = restored.ok
    ? message
    : `${message} — the accepted state could not be restored (${restored.reason}); establish the accepted version of this book by hand before writing again`;
  record.finishedAt = nowIso();
  record.durationMs = record.startedAt ? Date.parse(record.finishedAt) - Date.parse(record.startedAt) : null;
  record.answer = (record.answer ?? '').trim();
  record.agentLog = (record.agentLog ?? '') || job.text.slice(-20_000);
  await writeTurnRecord(universeId, record).catch(() => {});
  return restored;
}
