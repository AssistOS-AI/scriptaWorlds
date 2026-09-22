/**
 * fixtures.mjs — shared fixtures for the story-design suites.
 *
 * It provides one temporary workspace per test file, the validator invocation, the JSON
 * envelope reader and an `assessment-input.v2` packet builder whose declared `version` is
 * computed by the same §8.2 rule the loader implements, so a test can write a brief for
 * that version or for another one. Test files that call `useWorkspace` get their hooks
 * registered on their own file, and each file keeps its own temporary directory.
 */

import { before, after } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const VALIDATOR = fileURLToPath(new URL('../../scripts/validate-design.mjs', import.meta.url));

const VERSION_ROLES = new Set(['chapter', 'offer', 'canon', 'threads', 'atlas']);

export function run(args) {
  return spawnSync(process.execPath, [VALIDATOR, ...args], { encoding: 'utf8' });
}

export function envelope(result) {
  return JSON.parse(result.stdout);
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Hex(text) {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

/**
 * A workspace with the helpers a suite needs: `path(name)`, `design(name, obj)` writing a
 * brief into it, and `packet(name, options)` building an `assessment-input.v2` directory.
 */
export function useWorkspace(label) {
  const state = { dir: null };
  before(async () => {
    state.dir = await mkdtemp(join(tmpdir(), label));
  });
  after(async () => {
    await rm(state.dir, { recursive: true, force: true });
  });
  return {
    path(name) {
      return join(state.dir, name);
    },
    async design(name, obj) {
      const file = join(state.dir, name);
      await writeFile(file, JSON.stringify(obj, null, 2));
      return file;
    },
    packet(name, options = {}) {
      return writePacket(join(state.dir, name), options);
    },
  };
}

/**
 * Builds an `assessment-input.v2` packet and returns the accepted version identity it
 * declares, so a test can write a brief either for that version or for another one.
 */
export async function writePacket(root, options = {}) {
  const {
    universeId = 'arhiva-cenusii',
    chapters = ['# One\n\nFirst accepted chapter.\n', '# Two\n\nSecond accepted chapter.\n'],
    chapterNumbers = null,
    lastAcceptedChapter = null,
    stateRoles = ['canon', 'threads', 'atlas'],
    kind = 'complete',
    omitted = [],
    scopeChapters = null,
    extraFiles = [],
    manifestOverride = null,
  } = options;

  await mkdir(root, { recursive: true });
  const declared = [];

  const addFile = async (relative, text, role, artifactId, chapter) => {
    const absolute = join(root, relative);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    const entry = {
      path: relative,
      sha256: sha256Hex(text),
      bytes: Buffer.byteLength(text, 'utf8'),
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
    const [relative, text] = stateFiles[role];
    await addFile(relative, text, role, role);
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
    scope: { kind, chapters: scopeChapters ?? numbers, omitted, note: 'test fixture' },
    files: declared,
    ...(manifestOverride ?? {}),
  };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir: root, manifest, version };
}

export function minimalBrief(overrides = {}) {
  return {
    schema_version: 'design.v1',
    design_id: 'brief-1',
    language: 'en',
    central_idea: 'A plant demands sacrifices.',
    premise: 'A caregiver must choose whose treatment to interrupt.',
    thematic_question: 'Does care remain care when it is imposed?',
    reader_promise: 'Wonder and dread in equal measure.',
    ...overrides,
  };
}
