// C14 — continuity checks that understand time and valid UTF-8 evidence.
//
// Chapter references are field-specific: accepted material must exist, while a
// deadline or a blueprint destination may point forward inside its own contract.
// Evidence is built from the span tree, so a key that repeats across objects
// cites the object that actually offends, and every window ends on a code-point
// boundary.

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDeterministicChecks } from '../scripts/lib/checks.mjs';
import {
  byteLength,
  checkEvidenceBoundary,
  makePacket,
  parseEnvelope,
  romanianBoundaryChapter,
  runReview,
  sha256,
} from './helpers.mjs';

const root = await mkdtemp(join(tmpdir(), 'continuity-checks-'));
after(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;
async function review(name, opts = {}) {
  counter += 1;
  const { packetDir, version } = await makePacket(join(root, `${name}-${counter}`), opts);
  const out = join(root, `${name}-${counter}-out`);
  const result = await runReview(['--input', packetDir, '--out', out]);
  const envelope = parseEnvelope(result);
  assert.equal(result.code, 0, `${name}: exit code ${result.code}: ${JSON.stringify(envelope.errors)}`);
  return { packetDir, out, version, envelope };
}

function findingsOfKind(envelope, kind) {
  return envelope.findings.filter((finding) => finding.kind === kind);
}

const threadsWith = (...open) => ({ open, closed: [], promises: [], deferred_answers: [] });

describe('chapter references are read field by field', () => {
  test('a chapter-3 deadline in a two-chapter book is not a future event', async () => {
    const { envelope } = await review('deadline-forward', {
      threads: threadsWith(
        { id: 'thread-0001', kind: 'promise', question: 'Cine plătește?', created_chapter: 2, due_chapter: 3, status: 'open' },
      ),
    });
    assert.deepEqual(envelope.findings, [], 'an open deadline is a plan, not an accepted event');
  });

  test('a deadline that is not a chapter number is still malformed', async () => {
    const { envelope } = await review('deadline-shape', {
      threads: threadsWith(
        { id: 'thread-0001', kind: 'promise', question: 'Cine plătește?', created_chapter: 2, due_chapter: 0, status: 'open' },
      ),
    });
    const [finding] = findingsOfKind(envelope, 'integrity');
    assert.ok(finding, 'a non-number deadline is an integrity finding');
    assert.match(finding.description, /due_chapter/);
    assert.equal(finding.evidence[0].file, 'threads.json');
  });

  test('an accepted occurrence in a nonexistent chapter 3 is a future reference', async () => {
    const { envelope } = await review('occurrence-future', {
      threads: threadsWith({
        id: 'thread-0001',
        kind: 'mystery',
        question: 'Ce s-a întâmplat?',
        occurrence_chapter: 3,
        status: 'open',
      }),
    });
    const [finding] = findingsOfKind(envelope, 'future_reference');
    assert.ok(finding);
    assert.match(finding.description, /occurrence_chapter/);
    assert.match(finding.description, /chapter 3/);
  });

  test('an atlas occurrence in a nonexistent chapter is a future reference', async () => {
    const { envelope } = await review('atlas-future', {
      atlas: {
        version: 1,
        axes: [
          {
            id: 'mind-identity',
            name: 'Mind and identity',
            nodes: [{ id: 'memory-editing', label: 'Editable memory', state: 'dramatized', chapters: [1, 3] }],
          },
        ],
      },
    });
    const [finding] = findingsOfKind(envelope, 'future_reference');
    assert.ok(finding);
    assert.equal(finding.evidence[0].file, 'atlas.json');
    assert.match(finding.evidence[0].quote, /"chapters"/);
  });

  test('a reference to an interior chapter the packet neither carries nor declares is a missing reference', () => {
    // Through the CLI this case is refused earlier: a scope that leaves an
    // interior chapter undeclared is SCOPE_INCONSISTENT, so the check is
    // exercised here directly with the packet shape the loader guarantees.
    const text = `${JSON.stringify(
      threadsWith({ id: 'thread-0001', kind: 'mystery', question: 'x', asked_chapter: 2, status: 'open' }),
      null,
      2,
    )}\n`;
    const entry = {
      path: 'threads.json',
      role: 'threads',
      artifactId: 'threads',
      chapter: null,
      sha256: sha256(text),
      bytes: byteLength(text),
      data: Buffer.from(text, 'utf8'),
      text,
    };
    const packet = {
      files: new Map([[entry.path, entry]]),
      entries: [entry],
      chapterNumbers: [1, 3],
      omitted: [],
      lastAcceptedChapter: 3,
      scope: { kind: 'partial' },
    };
    const { findings } = runDeterministicChecks(packet);
    const [finding] = findings.filter((item) => item.kind === 'missing_reference');
    assert.ok(finding, 'an interior reference the packet cannot resolve is reported');
    assert.match(finding.description, /references chapter 2/);
    assert.equal(finding.evidence[0].file, 'threads.json');
  });

  test('a declared partial omission is not a missing reference', async () => {
    const { envelope, packetDir } = await review('declared-omission', {
      chapters: ['0001-a.md', '0003-c.md'],
      lastAccepted: 3,
      kind: 'partial',
      omitted: [2],
      threads: threadsWith(
        { id: 'thread-0001', kind: 'mystery', question: 'Ce s-a întâmplat?', asked_chapter: 2, due_chapter: 4, status: 'open' },
      ),
    });
    assert.deepEqual(envelope.findings, [], 'chapter 2 is a declared omission, not a missing reference');
    assert.deepEqual(envelope.scope.omitted, [2]);
    assert.ok((await readFile(join(packetDir, 'threads.json'), 'utf8')).includes('asked_chapter'));
  });

  test('duplicate active chapter numbers are one finding, not a rejection', async () => {
    const stale = '# Capitolul 1\n\nO versiune veche a capitolului.\n';
    const { envelope } = await review('duplicate-chapter', {
      chapters: ['0001-scene.md'],
      lastAccepted: 1,
      extraFiles: [
        { path: 'chapters/0001-copy.md', text: stale, role: 'design', artifact_id: 'chapter-0001-copy' },
      ],
    });
    const [finding] = findingsOfKind(envelope, 'integrity');
    assert.ok(finding, 'two live files for chapter 1 are a defect');
    assert.match(finding.description, /Duplicate active chapter number 0001/);
    assert.match(finding.description, /0001-copy\.md/);
    assert.equal(finding.evidence.length, 2);
  });

  test('a chapter file numbered beyond the last accepted chapter is a future reference', async () => {
    const { envelope } = await review('chapter-file-future', {
      chapters: ['0001-scene.md'],
      lastAccepted: 1,
      extraFiles: [
        { path: 'chapters/0002-planned.md', text: '# Capitolul 2\n\nNu e acceptat.\n', role: 'design', artifact_id: 'chapter-0002-planned' },
      ],
    });
    const [finding] = findingsOfKind(envelope, 'future_reference');
    assert.ok(finding);
    assert.match(finding.description, /0002-planned\.md is numbered 2/);
  });
});

describe('the offending value is cited, not the first key with that name', () => {
  test('a repeated key in a different object cites the object that offends', async () => {
    const { packetDir, envelope } = await review('repeated-keys', {
      threads: threadsWith(
        { id: 'thread-0001', kind: 'mystery', question: 'Ce ascunde pivnița?', created_chapter: 1, due_chapter: 5, status: 'open' },
        { id: 'thread-0002', kind: 'mystery', question: 'Cine a închis robinetul?', created_chapter: 3, status: 'open' },
      ),
    });
    const [finding] = findingsOfKind(envelope, 'future_reference');
    assert.ok(finding);
    const [evidence] = finding.evidence;
    const text = await readFile(join(packetDir, evidence.file), 'utf8');
    const bytes = Buffer.from(text, 'utf8');
    const first = bytes.indexOf(Buffer.from('"created_chapter"', 'utf8'));
    const second = bytes.indexOf(Buffer.from('"created_chapter"', 'utf8'), first + 1);
    assert.notEqual(first, second, 'the fixture must repeat the key');
    assert.equal(evidence.start, second, 'the citation starts at the offending member, not the first one');
    assert.deepEqual(checkEvidenceBoundary(evidence, text), [], 'the cited bytes verify');
    assert.match(evidence.quote, /"created_chapter": 3/);
  });
});

describe('blueprints may point forward, malformed state may not', () => {
  test('a story design may plan chapters that do not exist yet', async () => {
    const design = {
      arcs: [
        { id: 'arc-0001', title: 'The archive', chapter_memberships: [1, 3] },
        { id: 'arc-0002', title: 'Debt', chapter_memberships: [4] },
      ],
    };
    const { envelope } = await review('blueprint-forward', {
      extraFiles: [
        { path: 'design/story-design.json', text: `${JSON.stringify(design, null, 2)}\n`, role: 'design', artifact_id: 'story-design' },
      ],
    });
    assert.deepEqual(envelope.findings, [], 'a planned membership is not an accepted occurrence');
  });

  test('a planned membership that is not a chapter number is reported', async () => {
    const design = { arcs: [{ id: 'arc-0001', chapter_memberships: [0, 2] }] };
    const { envelope } = await review('blueprint-shape', {
      extraFiles: [
        { path: 'design/story-design.json', text: `${JSON.stringify(design, null, 2)}\n`, role: 'design', artifact_id: 'story-design' },
      ],
    });
    const [finding] = findingsOfKind(envelope, 'integrity');
    assert.ok(finding);
    assert.match(finding.description, /chapter_memberships\[0\]/);
  });

  test('a malformed state container is a structured finding, never a crash', async () => {
    const { envelope } = await review('malformed-threads', {
      threads: '{"open": {"not": "an array"}, "closed": [], "promises": [], "deferred_answers": []}\n',
    });
    const codes = envelope.findings.map((finding) => finding.id);
    assert.ok(envelope.findings.length > 0, 'a non-array collection is reported');
    assert.ok(codes.every((id) => /^continuity\./.test(id)));
    assert.ok(envelope.findings.some((finding) => /open must be an array/.test(finding.description)));
  });

  test('a state file that is not valid JSON is a structured finding', async () => {
    const { envelope } = await review('broken-json', { threads: '{"open": [}\n' });
    const [finding] = findingsOfKind(envelope, 'integrity');
    assert.ok(finding);
    assert.match(finding.description, /not valid JSON/);
    assert.equal(finding.evidence[0].file, 'threads.json');
  });
});

describe('evidence is built on code-point boundaries (C14 bytes)', () => {
  test('a window near byte 160 of Romanian text is a valid quoted span', async () => {
    const romanian = romanianBoundaryChapter();
    const bytes = Buffer.from(romanian, 'utf8');
    // Fixture sanity: byte 160 really falls inside a multi-byte character, so a
    // naive 160-byte window would split it.
    assert.ok(bytes.length > 200, 'the fixture must be longer than the evidence window');
    assert.equal(bytes[159] & 0xc0, 0xc0, 'byte 159 starts a multi-byte character');
    assert.equal(bytes[160] & 0xc0, 0x80, 'byte 160 continues it');

    const { packetDir, envelope } = await review('romanian-boundary', {
      chapters: ['0001-scene.md'],
      lastAccepted: 1,
      chapterTexts: { '0001-scene.md': romanian },
      extraFiles: [
        { path: 'chapters/0001-copy.md', text: romanian, role: 'design', artifact_id: 'chapter-0001-copy' },
      ],
    });
    const [finding] = findingsOfKind(envelope, 'integrity');
    assert.ok(finding, 'the duplicate chapter is reported');
    const [evidence] = finding.evidence;
    const text = await readFile(join(packetDir, evidence.file), 'utf8');
    assert.equal(evidence.end, 159, 'the window ends before the multi-byte character it would have split');
    assert.ok(evidence.end > 140, 'the window is a 160-byte window, not a truncated one');
    assert.deepEqual(checkEvidenceBoundary(evidence, text), []);
    assert.equal(Buffer.from(text, 'utf8').subarray(evidence.start, evidence.end).toString('utf8'), evidence.quote);
    assert.equal(evidence.sha256, sha256(text));
  });
});
