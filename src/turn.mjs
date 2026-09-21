// One turn, apart from the queue machinery: which prompt family the turn needs, what the agent must
// have produced before the turn counts as done, and the repair of the store when the turn fails.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';
import { nowIso, pad, readJson, readText } from './io.mjs';
import { UniverseError } from './errors.mjs';
import { universeDir } from './paths.mjs';
import { buildChapterPrompt, buildExportPrompt, buildRewritePrompt } from './prompts.mjs';
import {
  chapterTitle,
  countWords,
  findChapterFile,
  normalizeOffer,
  recentExportFiles,
  removeChapterFiles,
  writeTurnRecord
} from './universe-chapters.mjs';
import { restoreState } from './universe-state.mjs';

// A universe whose displayed title is still a whole sentence (an old, long auto-title) is renamed by
// ALA at the next chapter: the sentence moves to `summary`.
function namesItself(meta) {
  return meta.autoTitle === true || String(meta.title ?? '').split(/\s+/).filter(Boolean).length > 7;
}

/** The prompt of this turn: a rewrite, a new chapter or the printed edition. */
export function turnPrompt({ meta, job, chapterNumber, chapterFiles }) {
  const elements = Array.isArray(meta.elements) ? meta.elements : [];
  if (job.kind === 'rewrite') {
    return buildRewritePrompt({
      title: meta.title,
      law: meta.law,
      language: meta.language,
      chapterNumber,
      previousText: job.previousText ?? '',
      instructions: job.message,
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
 * The chapter the agent should have written: its file, its title, its length against the word band
 * and the reader offer. A missing chapter file is `NO_CHAPTER`; the rest are warnings on the record.
 */
export async function verifyChapterTurn({ universeId, chapterNumber, chapterFiles, record }) {
  const file = await findChapterFile(universeId, chapterNumber);
  if (!file) {
    throw new UniverseError('NO_CHAPTER', 'The agent did not write the chapter file.', 502);
  }
  const markdown = await readText(file.path, '');
  const words = countWords(markdown);
  record.chapterFile = `chapters/${file.name}`;
  record.chapterTitle = chapterTitle(markdown);
  if (words < config.chapterMinWords) {
    record.warnings.push(`short chapter: ${words} words (minimum target ${config.chapterMinWords})`);
  }
  if (words > config.chapterMaxWords * 1.35) {
    record.warnings.push(`long chapter: ${words} words (maximum target ${config.chapterMaxWords})`);
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
  if (!offer) {
    record.warnings.push('missing chapters/NNNN-offer.json (ALA voice for the reader)');
  } else {
    record.offer = offer;
  }
}

/** The edition the agent should have rendered: at least one DOCX/PDF written during this turn. */
export async function verifyExportTurn({ universeId, startedMs, record }) {
  const exports = await recentExportFiles(universeId, startedMs);
  if (exports.length === 0) {
    throw new UniverseError('NO_EXPORT', 'The agent produced no DOCX/PDF file in exports/.', 502);
  }
  record.exports = exports;
}

/**
 * The failure path of a turn: put the canon back, drop a chapter the agent left half-written, and
 * record the error on the turn so the interface can offer a retry.
 */
export async function failTurn({ universeId, job, turnNumber, message }) {
  if (turnNumber === null) return;
  await restoreState(universeId, turnNumber).catch(() => {});
  const existing = await readText(join(universeDir(universeId), 'turns', `${pad(turnNumber)}.json`), null);
  let record = { number: turnNumber, kind: job.kind, createdAt: job.createdAt, request: job.message };
  if (existing) {
    try {
      record = JSON.parse(existing);
    } catch {
      record = { number: turnNumber, kind: job.kind, createdAt: job.createdAt, request: job.message };
    }
  }
  if (job.kind === 'chapter' && record.chapterNumber) {
    await removeChapterFiles(universeId, record.chapterNumber).catch(() => {});
  }
  record.status = 'error';
  record.error = message;
  record.finishedAt = nowIso();
  record.durationMs = record.startedAt ? Date.parse(record.finishedAt) - Date.parse(record.startedAt) : null;
  record.answer = (record.answer ?? '').trim();
  record.agentLog = (record.agentLog ?? '') || job.text.slice(-20_000);
  await writeTurnRecord(universeId, record).catch(() => {});
}
