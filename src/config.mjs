import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { rootDir } from './paths.mjs';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

export const LANGUAGES = Object.freeze([
  { code: 'ro', label: 'Română' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'sv', label: 'Svenska' },
  { code: 'pl', label: 'Polski' },
  { code: 'cs', label: 'Čeština' },
  { code: 'hu', label: 'Magyar' },
  { code: 'bg', label: 'Български' },
  { code: 'el', label: 'Ελληνικά' },
  { code: 'uk', label: 'Українська' },
  { code: 'ru', label: 'Русский' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ja', label: '日本語' },
  { code: 'zh', label: '中文' }
]);

export const DEFAULT_LANGUAGE = 'ro';

export function languageLabel(code) {
  return LANGUAGES.find((entry) => entry.code === code)?.label ?? code;
}

export function isSupportedLanguage(code) {
  return LANGUAGES.some((entry) => entry.code === code);
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const config = Object.freeze({
  host: process.env.HOST ?? '0.0.0.0',
  port: positiveInt(process.env.PORT, 8787),
  ompBin: process.env.OMP_BIN ?? 'omp',
  model: process.env.SCRIPTAS_MODEL ?? DEFAULT_MODEL,
  // 0 = no global cap; each universe runs at most one turn at a time anyway.
  maxConcurrentJobs: nonNegativeInt(process.env.MAX_CONCURRENT_JOBS, 0),
  chapterTimeoutMs: positiveInt(process.env.CHAPTER_TIMEOUT_MS, 20 * 60 * 1000),
  exportTimeoutMs: positiveInt(process.env.EXPORT_TIMEOUT_MS, 20 * 60 * 1000),
  chapterMinWords: positiveInt(process.env.CHAPTER_MIN_WORDS, 900),
  chapterMaxWords: positiveInt(process.env.CHAPTER_MAX_WORDS, 2400),
  maxBodyBytes: 512 * 1024,
  // Where the separate design and review phases keep their frozen packets and published results. It is
  // deliberately outside `universes/`: a phase never writes into a book.
  assessmentWorkspace: process.env.ASSESSMENT_WORKSPACE ?? join(rootDir, 'assessments'),
  assessmentTimeoutMs: positiveInt(process.env.ASSESSMENT_TIMEOUT_MS, 5 * 60 * 1000),
  // The largest book the server accepts: the limit is enforced while the upload streams in, so a file
  // over it is refused during the transfer rather than after.
  importMaxBytes: positiveInt(process.env.IMPORT_MAX_BYTES, 64 * 1024 * 1024),
  // How much of a book one import turn carries is not configured here: the import skill publishes its
  // own turn limits in `skills/scripta-import/schema/import.v1.json` and the host plans within them.
  // Whether a review asks the configured agent for semantic observations by default. `generic` is the
  // product default, because a report with every semantic result unavailable diagnoses little;
  // `deterministic` keeps the host free of model calls for a deployment that wants only measurements.
  assessmentMode: (process.env.ASSESSMENT_MODE ?? 'generic') === 'deterministic' ? 'deterministic' : 'generic'
});

function run(command, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: String(error?.message ?? error), code: null });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(error?.message ?? error), code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

export function probeOmp() {
  return run(config.ompBin, ['--version']);
}

export async function requireOmp() {
  const probe = await probeOmp();
  if (!probe.ok) {
    const detail = (probe.stderr || probe.stdout || '').trim().split('\n').slice(0, 3).join(' ');
    const error = new Error(
      `the coding agent "${config.ompBin}" could not be started (${detail || 'command not found'}). ` +
      'Install Oh My Pi (https://oh-my-pi.dev) or point to the binary with the OMP_BIN variable.'
    );
    error.code = 'OMP_MISSING';
    throw error;
  }
  return { version: probe.stdout.trim().split('\n').pop() ?? '', command: config.ompBin };
}
