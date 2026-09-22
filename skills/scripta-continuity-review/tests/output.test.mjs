// C09 + C10 — input/output separation on real paths, and atomic publication.
//
// A refusal must happen before a single byte is written, must be decided on real
// paths (so a symlink alias cannot smuggle the result into an input), and must
// leave every input byte-identical. Publication writes one complete directory or
// nothing: a reader never sees a mixture of an old result and a new one.

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  annotationsDocument,
  errorCodes,
  exists,
  makePacket,
  parseEnvelope,
  runReview,
  snapshotTree,
  writeAnnotations,
} from './helpers.mjs';

const root = await mkdtemp(join(tmpdir(), 'continuity-output-'));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const RESULT_FILE = 'continuity-result.json';

async function fixture(name, opts = {}) {
  return makePacket(join(root, name), opts);
}


function stagingSiblings(directory, base) {
  return readdir(directory).then((names) => names.filter((name) => name.startsWith(`${base}.staging-`)));
}

describe('the destination must be separate from every input (real paths)', () => {
  test('--out equal to the packet is refused before any write', async () => {
    const { packetDir } = await fixture('equal');
    const before = await snapshotTree(packetDir);
    const result = await runReview(['--input', packetDir, '--out', packetDir]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 2);
    assert.deepEqual(errorCodes(envelope), ['OUTPUT_INSIDE_INPUT']);
    assert.deepEqual(await snapshotTree(packetDir), before);
    assert.deepEqual(envelope.outputs, []);
  });

  test('--out nested under the packet is refused', async () => {
    const { packetDir } = await fixture('nested');
    const result = await runReview(['--input', packetDir, '--out', join(packetDir, 'result')]);
    assert.equal(result.code, 2);
    assert.deepEqual(errorCodes(parseEnvelope(result)), ['OUTPUT_INSIDE_INPUT']);
    assert.equal(await exists(join(packetDir, 'result')), false);
  });

  test('an external symlink alias back into the packet is refused, including a new child beneath it', async () => {
    const { packetDir } = await fixture('alias');
    const alias = join(root, 'packet-alias');
    await symlink(packetDir, alias);
    const result = await runReview(['--input', packetDir, '--out', join(alias, 'deep', 'result')]);
    assert.equal(result.code, 2);
    assert.deepEqual(errorCodes(parseEnvelope(result)), ['OUTPUT_INSIDE_INPUT']);
    assert.equal(await exists(join(packetDir, 'deep')), false);
  });

  test('a destination that contains the packet is refused, also through an alias', async () => {
    const holder = join(root, 'contains');
    await mkdir(holder, { recursive: true });
    const { packetDir } = await makePacket(holder, {});
    const alias = join(root, 'contains-alias');
    await symlink(packetDir, alias);

    const direct = await runReview(['--input', packetDir, '--out', holder]);
    assert.equal(direct.code, 2);
    assert.deepEqual(errorCodes(parseEnvelope(direct)), ['OUTPUT_CONTAINS_INPUT']);

    const throughAlias = await runReview(['--input', alias, '--out', holder]);
    assert.equal(throughAlias.code, 2);
    assert.deepEqual(errorCodes(parseEnvelope(throughAlias)), ['OUTPUT_CONTAINS_INPUT']);
  });

  test('a supplied annotations file is protected as well', async () => {
    const { packetDir, version } = await fixture('annotations-protected');
    const annotations = await writeAnnotations(root, 'collide.json', annotationsDocument([], {}));
    assert.ok(version);

    const equal = await runReview(['--input', packetDir, '--out', annotations, '--annotations', annotations]);
    assert.equal(equal.code, 2);
    assert.deepEqual(errorCodes(parseEnvelope(equal)), ['OUTPUT_INSIDE_INPUT']);

    const holder = join(root, 'annotations-holder');
    await mkdir(holder, { recursive: true });
    const inside = await writeAnnotations(holder, 'annotations.json', annotationsDocument([]));
    const contains = await runReview(['--input', packetDir, '--out', holder, '--annotations', inside]);
    assert.equal(contains.code, 2);
    assert.deepEqual(errorCodes(parseEnvelope(contains)), ['OUTPUT_CONTAINS_INPUT']);
  });

  test('a separate destination that does not exist yet is accepted and publishes one bundle', async () => {
    const { packetDir } = await fixture('fresh-nested');
    const out = join(root, 'fresh', 'run', 'result');
    const result = await runReview(['--input', packetDir, '--out', out]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 0, JSON.stringify(envelope.errors));
    assert.deepEqual(await readdir(out), [RESULT_FILE]);
    assert.deepEqual(envelope.outputs, [join(out, RESULT_FILE)]);
    // The success envelope names only the published bundle, and the published
    // file is the same object the envelope reported on stdout.
    assert.deepEqual(JSON.parse(await readFile(join(out, RESULT_FILE), 'utf8')), envelope);
    assert.deepEqual(await stagingSiblings(join(root, 'fresh', 'run'), 'result'), []);
  });
});

describe('publication is one complete directory or nothing (C10)', () => {
  test('an existing accepted result is never overwritten file by file', async () => {
    const { packetDir } = await fixture('accepted-result');
    const out = join(root, 'accepted', 'result');
    await mkdir(out, { recursive: true });
    const prior = '{"schema_version":"continuity-result.v1","ok":true,"marker":"previous complete result"}\n';
    await writeFile(join(out, RESULT_FILE), prior, 'utf8');
    const result = await runReview(['--input', packetDir, '--out', out]);
    assert.equal(result.code, 2);
    assert.deepEqual(errorCodes(parseEnvelope(result)), ['OUTPUT_NOT_EMPTY']);
    assert.equal(await readFile(join(out, RESULT_FILE), 'utf8'), prior, 'the previous result is untouched');
    assert.deepEqual(await readdir(out), [RESULT_FILE], 'no file was added to the published directory');
  });

  test('an existing empty destination directory is filled by one rename', async () => {
    const { packetDir } = await fixture('empty-dir');
    const out = join(root, 'empty', 'result');
    await mkdir(out, { recursive: true });
    const result = await runReview(['--input', packetDir, '--out', out]);
    assert.equal(result.code, 0);
    assert.deepEqual(await readdir(out), [RESULT_FILE]);
  });

  test('a destination that is an existing file is refused', async () => {
    const { packetDir } = await fixture('file-destination');
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'x\n', 'utf8');
    const result = await runReview(['--input', packetDir, '--out', file]);
    assert.equal(result.code, 2);
    assert.deepEqual(errorCodes(parseEnvelope(result)), ['OUTPUT_NOT_DIRECTORY']);
    assert.equal(await readFile(file, 'utf8'), 'x\n');
  });

  test('a failed publication reports the error, publishes nothing and leaves no staging directory', async () => {
    const { packetDir } = await fixture('publish-failure');
    const blocker = join(root, 'blocker');
    await writeFile(blocker, 'a regular file where a directory is needed\n', 'utf8');
    const out = join(blocker, 'result');
    const result = await runReview(['--input', packetDir, '--out', out]);
    const envelope = parseEnvelope(result);
    assert.equal(result.code, 1, JSON.stringify(envelope));
    assert.equal(envelope.ok, false);
    assert.deepEqual(envelope.outputs, [], 'a run that published nothing names no bundle');
    assert.deepEqual(errorCodes(envelope), ['IO_ERROR']);
    assert.deepEqual(await stagingSiblings(root, 'blocker'), []);
    assert.equal(await readFile(blocker, 'utf8'), 'a regular file where a directory is needed\n');
  });

  test('an unwritable parent fails as an execution error without touching the inputs', async () => {
    const { packetDir } = await fixture('readonly-parent');
    const frozen = join(root, 'read-only');
    await mkdir(frozen, { recursive: true });
    await chmod(frozen, 0o500);
    try {
      const before = await snapshotTree(packetDir);
      const result = await runReview(['--input', packetDir, '--out', join(frozen, 'result')]);
      const envelope = parseEnvelope(result);
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        assert.equal(result.code, 0, 'root bypasses the permission bit');
      } else {
        assert.equal(result.code, 1, JSON.stringify(envelope));
        assert.deepEqual(errorCodes(envelope), ['IO_ERROR']);
        assert.deepEqual(envelope.outputs, []);
      }
      assert.equal(await exists(join(frozen, 'result')), false);
      assert.deepEqual(await snapshotTree(packetDir), before);
    } finally {
      await chmod(frozen, 0o700);
    }
  });

  test('an interrupted run leaves no artifact that a reader could mistake for a result, and the retry cleans it', async () => {
    const { packetDir } = await fixture('interrupted');
    const out = join(root, 'interrupted', 'result');
    const parent = join(root, 'interrupted');
    await mkdir(parent, { recursive: true });
    // Simulate a process killed between staging and publication: the staging
    // directory of the same naming scheme is still there.
    const abandoned = join(parent, 'result.staging-0123456789ab');
    await mkdir(abandoned, { recursive: true });
    await writeFile(join(abandoned, RESULT_FILE), '{"ok":false}\n', 'utf8');

    const result = await runReview(['--input', packetDir, '--out', out]);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(await readdir(out), [RESULT_FILE]);
    assert.deepEqual(await stagingSiblings(parent, 'result'), [], 'the retry removes the abandoned staging');
    const envelope = parseEnvelope(result);
    assert.equal(envelope.ok, true);
  });
});

describe('the inputs stay byte-identical', () => {
  test('a completed review leaves the packet and the annotations byte for byte', async () => {
    const { packetDir, version } = await fixture('inputs-intact');
    const annotations = await writeAnnotations(root, 'intact.json', annotationsDocument([]));
    const beforePacket = await snapshotTree(packetDir);
    const beforeAnnotations = await readFile(annotations, 'utf8');

    const result = await runReview([
      '--input',
      packetDir,
      '--out',
      join(root, 'inputs-intact-out'),
      '--annotations',
      annotations,
    ]);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(parseEnvelope(result).version, version);
    assert.deepEqual(await snapshotTree(packetDir), beforePacket);
    assert.equal(await readFile(annotations, 'utf8'), beforeAnnotations);
  });
});
