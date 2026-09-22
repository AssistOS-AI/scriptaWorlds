/**
 * cli.test.mjs — the command-line surface of `validate-design.mjs`: its flags, its exit
 * codes and the refusals it makes before any JSON is parsed. The design brief's rules live
 * in design.test.mjs and the packet cases in context.test.mjs; the byte-identity proof that
 * nothing is written while the command runs is asserted by the input-hash checks in those
 * two suites.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { envelope, run, useWorkspace } from './helpers/fixtures.mjs';

const ws = useWorkspace('story-design-cli-');

test('reports a structured error for malformed JSON input', async () => {
  const file = ws.path('malformed.json');
  await writeFile(file, '{ not json at all');
  const result = run(['--input', file]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.equal(env.errors.length, 1);
  assert.ok(env.errors[0].includes('not valid JSON'));
});

test('rejects a directory passed as --input with a clear message', async () => {
  const dir = ws.path('a-directory');
  await mkdir(dir);
  const result = run(['--input', dir]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e) => e.includes('directory')));
});

test('rejects a nonexistent input path', async () => {
  const result = run(['--input', ws.path('does-not-exist.json')]);
  assert.equal(result.status, 2);
  const env = envelope(result);
  assert.equal(env.ok, false);
  assert.ok(env.errors.some((e) => e.includes('does not exist')));
});
