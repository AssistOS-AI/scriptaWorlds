import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildFixture, cleanup, runCli, writeJson } from './helpers.mjs';

function run(fixture, extra = []) {
  return runCli(['--universe', fixture.universe, '--import', fixture.extractionFile, ...extra]);
}

/** Rewrite the import record of a built universe. */
function patchRecord(fixture, change) {
  const file = join(fixture.universe, 'drafts', 'import-progress.json');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  change(record);
  writeJson(fixture.universe, 'drafts/import-progress.json', record);
  return record;
}

test('the record is the marker of an import, and it names the extraction it came from', () => {
  const fixture = buildFixture();
  try {
    const record = JSON.parse(readFileSync(join(fixture.universe, 'drafts', 'import-progress.json'), 'utf8'));
    assert.equal(record.schema_version, 'book-import.v1');
    assert.equal(record.import_id, '20260922T155732-ab12');
    assert.equal(record.source.sha256, 'a'.repeat(64));
    assert.equal(record.start_chapter, 1);
    assert.equal(record.segmentation, 'host');
    assert.equal(record.complete, true);
    assert.equal(record.next_source_chapter, null);
    assert.deepEqual(record.chapters.map((entry) => [entry.chapter, entry.source_chapter]), [[1, 1], [2, 2]]);
    assert.deepEqual(record.chapters.map((entry) => entry.segment), [null, null]);
    assert.deepEqual(record.skipped, []);
    assert.equal(record.turns.length, 1);
    assert.deepEqual(record.turns[0].chapters, [1, 2]);
    assert.ok(record.language.match === true);
  } finally {
    cleanup([fixture.root]);
  }
});

test('a heading-only source chapter is recorded as skipped, and a skippable chapter never carries prose', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 300 }, 2: { words: 0 }, 3: { words: 300 } } });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.chapters_checked, 2);
    const record = JSON.parse(readFileSync(join(fixture.universe, 'drafts', 'import-progress.json'), 'utf8'));
    assert.deepEqual(record.skipped.map((entry) => entry.source_chapter), [2]);
    assert.equal(record.chapters.length, 2);
  } finally {
    cleanup([fixture.root]);
  }
});

test('skipping a chapter that carries prose is refused, so no readable chapter is dropped in silence', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 300 }, 2: { words: 300 } } });
  try {
    patchRecord(fixture, (record) => {
      const dropped = record.chapters.pop();
      record.skipped.push({ source_chapter: dropped.source_chapter, reason: 'not interesting' });
      record.turns[0].chapters = record.chapters.map((entry) => entry.chapter);
      record.turns[0].to_source_chapter = record.chapters[record.chapters.length - 1].source_chapter;
    });
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('which carries 300 words of prose')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('a source chapter passed over without a note is refused', () => {
  const fixture = buildFixture({
    chapters: { 1: { words: 200 }, 3: { words: 200 } },
    pending: { 2: 200, 4: 200 },
    complete: false,
    nextSourceChapter: 4,
  });
  try {
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(
      result.envelope.errors.some((error) => error.includes('passed extraction chapter 2 over without importing it or recording it in `skipped`')),
      result.envelope.errors.join(' | '),
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('a turn that covers more than the bound is reported as TURN_OVERSIZE without refusing the import', () => {
  const fixture = buildFixture({
    chapters: { 1: { words: 300 }, 2: { words: 300 }, 3: { words: 300 }, 4: { words: 300 } },
  });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.deepEqual(result.envelope.warnings, [
      'TURN_OVERSIZE: import turn 1 covered 4 extraction chapters and 1200 words, above the bound of 3 chapters and 6000 words',
    ]);
  } finally {
    cleanup([fixture.root]);
  }
});

test('a turn whose window does not match the chapters it claims is INVALID_IMPORT', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 200 }, 2: { words: 200 } } });
  try {
    patchRecord(fixture, (record) => {
      record.turns[0].to_source_chapter = 1;
    });
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(
      result.envelope.errors.some((error) => error.includes('outside the range 1–1 it says it covered')),
      result.envelope.errors.join(' | '),
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('a turn whose window ends on a chapter with no prose still covers it, and only writes one chapter', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 300 }, 2: { words: 0 } } });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.chapters_checked, 1);
    const record = JSON.parse(readFileSync(join(fixture.universe, 'drafts', 'import-progress.json'), 'utf8'));
    assert.deepEqual(record.turns[0].chapters, [1], 'one chapter file came out of the window');
    assert.equal(record.turns[0].to_source_chapter, 2, 'the window covers the chapter it passed over');
    assert.equal(record.next_source_chapter, null);
    assert.equal(record.complete, true);
  } finally {
    cleanup([fixture.root]);
  }
});

test('a continuation pointer that does not follow from the turns is INVALID_IMPORT', () => {
  const fixture = buildFixture({
    chapters: { 1: { words: 200 }, 2: { words: 200 } },
    pending: { 3: 200 },
    complete: false,
    nextSourceChapter: 8,
  });
  try {
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('continues at 8 while the turns end at 3')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('an import that stops in the middle may not claim to be complete', () => {
  const fixture = buildFixture({
    chapters: { 1: { words: 200 } },
    pending: { 2: 200 },
    complete: true,
    nextSourceChapter: 2,
  });
  try {
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('says the import is complete')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('a hole in the chapter numbering, or a segment that is not 1..k, is INVALID_IMPORT', () => {
  const gap = buildFixture({ chapters: { 1: { words: 200 }, 2: { words: 200 } } });
  const segments = buildFixture({ chapters: { 1: { words: 600, split: 2 } }, segmentation: 'scene' });
  try {
    patchRecord(gap, (record) => {
      record.chapters[1].chapter = 3;
      record.chapters[1].file = 'chapters/0003-chapter-2.md';
      record.turns[0].chapters = [1, 3];
    });
    const gapResult = run(gap);
    assert.equal(gapResult.status, 2);
    assert.equal(gapResult.envelope.code, 'INVALID_IMPORT');
    assert.ok(gapResult.envelope.errors.some((error) => error.includes('skips chapter 2')));

    patchRecord(segments, (record) => {
      record.chapters[1].segment = 3;
    });
    const segmentResult = run(segments);
    assert.equal(segmentResult.status, 2);
    assert.equal(segmentResult.envelope.code, 'INVALID_IMPORT');
    assert.ok(segmentResult.envelope.errors.some((error) => error.includes('instead of 2')));
  } finally {
    cleanup([gap.root, segments.root]);
  }
});

test('a record entry that does not match the file it names is INVALID_IMPORT', () => {
  const fixture = buildFixture();
  try {
    patchRecord(fixture, (record) => {
      record.chapters[0].title = 'A title the file does not carry';
    });
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('but its file says')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('an import that starts in a universe which already has chapters numbers itself after them', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 200 } }, startChapter: 4, record: { start_chapter: 4 } });
  try {
    const result = run(fixture, ['--chapters', '1-1']);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.start_chapter, 4);
    assert.equal(result.envelope.chapters_checked, 1);
  } finally {
    cleanup([fixture.root]);
  }
});
