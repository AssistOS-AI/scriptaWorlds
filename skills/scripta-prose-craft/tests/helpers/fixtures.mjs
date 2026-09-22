/**
 * Shared fixtures for the prose-craft tests: temporary directories, a profile writer, an
 * `assessment-input.v2` packet builder, the CLI runner and a whole-tree inventory used to
 * prove that a run wrote nothing. Test-only local code; it imports nothing from the skill
 * under test beyond the script path.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/validate-profile.mjs', import.meta.url));
export const SKILL_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const VERSION_ROLES = new Set(['chapter', 'offer', 'canon', 'threads', 'atlas']);

/** A well-formed observed component whose quote occurs in the default first chapter. */
export const OBSERVED_COMPONENT = {
  component_id: 'ec-0001',
  component: 'dialogue',
  anchor: 'chapters/0001-chapter.md, the first paragraph',
  status: 'observed',
  evaluator: 'human:reviewer-a',
  method: 'prose-craft-inspection-v1',
  rationale: 'The reply resists the question because the speaker protects status.',
  evidence: [{ source: 'chapters/0001-chapter.md', quote: 'First accepted chapter.' }],
};

export const MINIMAL_PROFILE = {
  schema_version: 'profile.v1',
  profile_id: 'p-min',
  language: 'en',
  reader_experience: 'A calm, quiet unease that resolves into resolve.',
  narrator: 'Third-person limited, past tense.',
};

export function sha256Hex(text) {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

export function runValidator(inputPath, contextPath) {
  const args = [SCRIPT_PATH, '--input', inputPath];
  if (contextPath) {
    args.push('--context', contextPath);
  }
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

export function runRaw(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', ...options });
}

export function parseEnvelope(res) {
  return JSON.parse(res.stdout.trim());
}

export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'prose-craft-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function writeJson(dir, name, value) {
  const path = join(dir, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
}

/**
 * Every file below `root` with its hash, or the link target for a symlink, sorted. Used to
 * prove that a run left the tree byte-identical and created nothing.
 */
export async function inventory(root) {
  const entries = [];
  const walk = async (dir) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      const name = relative(root, full);
      if (item.isSymbolicLink()) {
        entries.push(`${name} -> ${await readlink(full)}`);
      } else if (item.isDirectory()) {
        await walk(full);
      } else {
        entries.push(`${name} ${sha256Hex(await readFile(full, 'utf8'))}`);
      }
    }
  };
  await walk(root);
  return entries.sort();
}

/**
 * Builds an `assessment-input.v2` packet and returns the accepted version identity it
 * declares, so a test can write a profile either for that version or for another one.
 */
export async function writePacket(root, options = {}) {
  const {
    universeId = 'uni-1',
    chapters = ['# One\n\nFirst accepted chapter.\n', '# Two\n\nSecond accepted chapter.\n'],
    chapterNumbers = null,
    lastAcceptedChapter = null,
    stateRoles = ['canon', 'threads', 'atlas'],
    kind = 'complete',
    omitted = [],
    extraFiles = [],
    manifestOverride = null,
  } = options;

  await mkdir(root, { recursive: true });
  const declared = [];

  const addFile = async (rel, text, role, artifactId, chapter) => {
    const absolute = join(root, rel);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    const entry = {
      path: rel,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
      role,
      artifact_id: artifactId,
    };
    if (chapter !== undefined) {
      entry.chapter = chapter;
    }
    declared.push(entry);
  };

  const numbers = chapterNumbers ?? chapters.map((_, index) => index + 1);
  for (let index = 0; index < chapters.length; index += 1) {
    const number = numbers[index];
    const padded = String(number).padStart(4, '0');
    await addFile(`chapters/${padded}-chapter.md`, chapters[index], 'chapter', `chapter-${padded}`, number);
  }

  const stateFiles = {
    canon: ['canon.md', '# Canon\n'],
    threads: ['threads.json', '{"open":[],"closed":[]}\n'],
    atlas: ['atlas.json', '{"version":1,"axes":[]}\n'],
  };
  for (const role of stateRoles) {
    const [rel, text] = stateFiles[role];
    await addFile(rel, text, role, role);
  }

  for (const extra of extraFiles) {
    await addFile(extra.path, extra.text, extra.role, extra.artifact_id, extra.chapter);
  }

  const lines = declared
    .filter((entry) => VERSION_ROLES.has(entry.role))
    .map((entry) => `${entry.path}\t${entry.sha256}\t${entry.bytes}\n`)
    .sort();
  const version = `sha256:${sha256Hex(lines.join(''))}`;
  const lastChapter = lastAcceptedChapter ?? (numbers.length > 0 ? Math.max(...numbers) : 0);

  const manifest = {
    schema_version: 'assessment-input.v2',
    universe_id: universeId,
    version,
    captured_at: '2026-09-22T16:40:00.000Z',
    book: { title: 'The Ash Archive', language: 'en', last_accepted_chapter: lastChapter },
    scope: { kind, chapters: numbers, omitted, note: 'test fixture' },
    files: declared,
    ...(manifestOverride ?? {}),
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir: root, manifest, version };
}
