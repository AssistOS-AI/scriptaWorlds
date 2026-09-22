import test from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildReportFixture } from './report-fixture.mjs';
import { cleanup, readJson, runCli, tempDir } from './helpers.mjs';

const CHAPTER_1 = 'alfa bravo charlie delta echo foxtrot golf hotel india juliett';
const CHAPTER_2 = 'kilo lima mike november oscar papa quebec romeo sierra tango';

function fixture(root) {
  return buildReportFixture(root, { chapters: { 1: CHAPTER_1, 2: CHAPTER_2 }, contextChapters: [] });
}

function run(fx, out, extra = []) {
  return runCli(['--input', fx.packetDir, '--out', out, '--profile', fx.profilePath, ...extra]);
}

test('a run without trigger flags stays a reader request', () => {
  const root = tempDir('metrics-trigger-request-');
  try {
    const fx = fixture(root);
    const out = join(root, 'out');
    const result = run(fx, out);
    assert.equal(result.status, 0, result.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.trigger, 'request');
    assert.deepEqual(bundle.trigger_ref, { kind: 'request' });
    assert.match(readFileSync(join(out, 'index.md'), 'utf8'), /- Trigger: reader request/);
  } finally {
    cleanup([root]);
  }
});

test('an arc-triggered run names the arc that caused it', () => {
  const root = tempDir('metrics-trigger-arc-');
  try {
    const fx = fixture(root);
    const out = join(root, 'out');
    const result = run(fx, out, ['--trigger', 'arc', '--arc-id', 'arc-ledger']);
    assert.equal(result.status, 0, result.stdout);
    const bundle = readJson(join(out, 'assessment.json'));
    assert.equal(bundle.trigger, 'arc');
    assert.deepEqual(bundle.trigger_ref, { kind: 'arc', arc_id: 'arc-ledger' });
    assert.match(readFileSync(join(out, 'index.md'), 'utf8'), /- Trigger: accepted arc completion `arc-ledger`/);
  } finally {
    cleanup([root]);
  }
});

test('an arc trigger without an arc id is refused before anything is written', () => {
  const root = tempDir('metrics-trigger-missing-arc-');
  try {
    const fx = fixture(root);
    const out = join(root, 'out');
    const result = run(fx, out, ['--trigger', 'arc']);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.ok, false);
    assert.equal(result.envelope.code, 'USAGE');
    assert.match(result.envelope.error, /--trigger arc requires --arc-id/);
    assert.equal(existsSync(join(out, 'assessment.json')), false);
  } finally {
    cleanup([root]);
  }
});

test('an unknown trigger word is refused', () => {
  const root = tempDir('metrics-trigger-unknown-');
  try {
    const fx = fixture(root);
    const out = join(root, 'out');
    for (const trigger of ['requested', 'arc-end', '']) {
      const result = run(fx, out, ['--trigger', trigger, '--arc-id', 'arc-ledger']);
      assert.equal(result.status, 2, `--trigger ${JSON.stringify(trigger)} is refused`);
      assert.equal(result.envelope.code, 'USAGE');
      assert.match(result.envelope.error, /--trigger must be one of request\|arc/);
    }
    assert.equal(existsSync(join(out, 'assessment.json')), false);
  } finally {
    cleanup([root]);
  }
});

test('an arc id without an arc trigger is refused', () => {
  const root = tempDir('metrics-trigger-stray-arc-');
  try {
    const fx = fixture(root);
    const out = join(root, 'out');
    const result = run(fx, out, ['--arc-id', 'arc-ledger']);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'USAGE');
    assert.match(result.envelope.error, /--arc-id is only valid with --trigger arc/);
    assert.equal(existsSync(join(out, 'assessment.json')), false);
  } finally {
    cleanup([root]);
  }
});
