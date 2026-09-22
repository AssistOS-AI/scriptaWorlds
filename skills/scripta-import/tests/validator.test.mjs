import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildFixture, cleanup, pad4, prose, runCli, tempDir, writeJson } from './helpers.mjs';

function run(fixture, extra = []) {
  return runCli(['--universe', fixture.universe, '--import', fixture.extractionFile, ...extra]);
}

test('a faithful import of two chapters is accepted and reports what it checked', () => {
  const fixture = buildFixture();
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.code, null);
    assert.deepEqual(result.envelope.errors, []);
    assert.deepEqual(result.envelope.warnings, []);
    assert.equal(result.envelope.schema_version, 'book-import-validation.v1');
    assert.equal(result.envelope.import_id, '20260922T155732-ab12');
    assert.equal(result.envelope.start_chapter, 1);
    assert.equal(result.envelope.last_imported_chapter, 2);
    assert.equal(result.envelope.complete, true);
    assert.equal(result.envelope.next_source_chapter, null);
    assert.equal(result.envelope.chapters_checked, 2);
    assert.ok(result.envelope.words_checked > 250, 'the checked words are counted');
    assert.equal(result.lines.length, 1, 'the envelope is the only line on stdout');
  } finally {
    cleanup([fixture.root]);
  }
});

test('the extraction is found at its documented path when --import is not given', () => {
  const fixture = buildFixture();
  try {
    const result = runCli(['--universe', fixture.universe]);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.extraction, fixture.extractionFile);
  } finally {
    cleanup([fixture.root]);
  }
});

test('a chapter the record names but the folder does not hold is MISSING_CHAPTER', () => {
  const fixture = buildFixture();
  try {
    unlinkSync(join(fixture.root, 'universe', fixture.record.chapters[0].file));
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.ok, false);
    assert.equal(result.envelope.code, 'MISSING_CHAPTER');
    assert.equal(result.envelope.errors.length, 1);
    assert.match(result.envelope.errors[0], /^MISSING_CHAPTER: chapter 1 is recorded as chapters\/0001-/);
  } finally {
    cleanup([fixture.root]);
  }
});

test('two chapter files for one number are refused, because a chapter is one file', () => {
  const fixture = buildFixture();
  try {
    writeFileSync(join(fixture.root, 'universe', 'chapters', '0001-second-title.md'), '# Second title\n\nother prose\n');
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'MISSING_CHAPTER');
    assert.ok(
      result.envelope.errors.some((error) => error.includes('chapter 1 has 2 files')),
      result.envelope.errors.join(' | '),
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('a truncated chapter is WORD_COVERAGE: too few words against the extraction', () => {
  const fixture = buildFixture();
  try {
    const { file, title } = fixture.record.chapters[0];
    const kept = prose(20, 'c1').cleaned;
    writeFileSync(join(fixture.root, 'universe', file), `# ${title}\n\n${kept}\n`);
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'WORD_COVERAGE');
    assert.ok(
      result.envelope.errors.some((error) => /holds 120 words and the imported chapter holds \d+, outside the plausible band 96–144/.test(error)),
      result.envelope.errors.join(' | '),
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('prose that is not the book\'s own is WORD_COVERAGE even at the right length', () => {
  const fixture = buildFixture();
  try {
    const { file, title } = fixture.record.chapters[0];
    writeFileSync(join(fixture.root, 'universe', file), `# ${title}\n\n${prose(120, 'invented').cleaned}\n`);
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'WORD_COVERAGE');
    assert.ok(
      result.envelope.errors.some((error) => /is not the book's own prose/.test(error)),
      result.envelope.errors.join(' | '),
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('cleaning page furniture off a long chapter stays inside the plausibility bound', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 3000 } }, furnitureEvery: 250 });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.chapters_checked, 1);
  } finally {
    cleanup([fixture.root]);
  }
});

test('a JSON file that does not parse is UNPARSEABLE_JSON, whichever file it is', () => {
  const broken = ['threads.json', 'atlas.json', 'drafts/import-progress.json'];
  for (const relative of broken) {
    const fixture = buildFixture();
    try {
      writeFileSync(join(fixture.root, 'universe', relative), '{"open": [}\n');
      const result = run(fixture);
      assert.equal(result.status, 2, relative);
      assert.equal(result.envelope.code, 'UNPARSEABLE_JSON', relative);
      assert.ok(
        result.envelope.errors.some((error) => error.startsWith('UNPARSEABLE_JSON:') && error.includes(relative)),
        `${relative}: ${result.envelope.errors.join(' | ')}`,
      );
    } finally {
      cleanup([fixture.root]);
    }
  }
});

test('an extraction that does not parse is UNPARSEABLE_JSON', () => {
  const fixture = buildFixture();
  try {
    writeFileSync(fixture.extractionFile, '{ not json\n');
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'UNPARSEABLE_JSON');
    assert.ok(result.envelope.errors[0].includes('.agents/import/extracted.json'));
  } finally {
    cleanup([fixture.root]);
  }
});

test('a missing or empty extraction is NO_EXTRACTION, and nothing else is checked', () => {
  const missing = buildFixture();
  const empty = buildFixture();
  try {
    unlinkSync(missing.extractionFile);
    const first = run(missing);
    assert.equal(first.status, 2);
    assert.equal(first.envelope.code, 'NO_EXTRACTION');
    assert.ok(first.envelope.errors[0].startsWith('NO_EXTRACTION:'), first.envelope.errors[0]);
    assert.ok(first.envelope.errors[0].includes('extracted.json'), first.envelope.errors[0]);

    writeFileSync(empty.extractionFile, '');
    writeFileSync(join(empty.root, 'universe', 'threads.json'), '{"open": [}\n');
    const second = run(empty);
    assert.equal(second.status, 2);
    assert.equal(second.envelope.code, 'NO_EXTRACTION', 'the extraction is refused before anything else is read');
    assert.equal(second.envelope.errors.length, 1);
  } finally {
    cleanup([missing.root, empty.root]);
  }
});

test('an extraction with no prose at all is refused rather than invented', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 0 }, 2: { words: 0 } } });
  try {
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'NO_EXTRACTION');
    assert.ok(
      result.envelope.errors.some((error) => error.includes('no prose at all')),
      result.envelope.errors.join(' | '),
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('a turn that imports chapters 1-3 of a twelve-chapter book passes for its own range only', () => {
  const fixture = buildFixture({
    chapters: { 1: { words: 400 }, 2: { words: 400 }, 3: { words: 400 } },
    pending: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [index + 4, 400])),
    complete: false,
    nextSourceChapter: 4,
  });
  try {
    const scoped = run(fixture, ['--chapters', '1-3']);
    assert.equal(scoped.status, 0, scoped.stdout);
    assert.equal(scoped.envelope.ok, true);
    assert.equal(scoped.envelope.range, '1-3');
    assert.equal(scoped.envelope.chapters_checked, 3);
    assert.equal(scoped.envelope.complete, false);
    assert.equal(scoped.envelope.next_source_chapter, 4);

    const whole = run(fixture);
    assert.equal(whole.status, 0, whole.stdout);
    assert.equal(whole.envelope.range, null);
    assert.equal(whole.envelope.chapters_checked, 3);
  } finally {
    cleanup([fixture.root]);
  }
});

test('a range that names an extraction chapter the import has not reached is MISSING_CHAPTER', () => {
  const fixture = buildFixture({
    chapters: { 1: { words: 400 }, 2: { words: 400 } },
    pending: { 3: 400 },
    complete: false,
    nextSourceChapter: 3,
  });
  try {
    const result = runCli(['--universe', fixture.universe, '--import', fixture.extractionFile, '--chapters', '1-4']);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'MISSING_CHAPTER');
    assert.ok(result.envelope.errors.some((error) => error.includes('the extraction declares no chapter 4')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('a range that reaches past the continuation pointer is MISSING_CHAPTER', () => {
  const fixture = buildFixture({
    chapters: { 1: { words: 400 }, 2: { words: 400 } },
    pending: { 3: 400 },
    complete: false,
    nextSourceChapter: 3,
  });
  try {
    const result = runCli(['--universe', fixture.universe, '--import', fixture.extractionFile, '--chapters', '1-3']);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'MISSING_CHAPTER');
    assert.ok(result.envelope.errors.some((error) => error.includes('is not imported yet: the import continues at 3')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('a record written for another extraction is INVALID_IMPORT', () => {
  const fixture = buildFixture({ record: { import_id: '20260101T000000-ffff' } });
  try {
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(
      result.envelope.errors.some((error) => error.includes('20260101T000000-ffff')),
      result.envelope.errors.join(' | '),
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('a record whose own source hash does not match the supplied extraction is INVALID_IMPORT', () => {
  const fixture = buildFixture();
  try {
    const recordFile = join(fixture.root, 'universe', 'drafts', 'import-progress.json');
    const record = JSON.parse(readFileSync(recordFile, 'utf8'));
    record.source.sha256 = 'b'.repeat(64);
    writeJson(fixture.root, 'universe/drafts/import-progress.json', record);
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('was written for another extraction')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('a universe without an import record is not an import', () => {
  const fixture = buildFixture();
  try {
    rmSync(join(fixture.root, 'universe', 'drafts'), { recursive: true, force: true });
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('carries no import record')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('a chapter that does not begin with its title is INVALID_IMPORT', () => {
  const fixture = buildFixture();
  try {
    const { file } = fixture.record.chapters[0];
    const text = readFileSync(join(fixture.root, 'universe', file), 'utf8').replace(/^# .*\n/, '');
    writeFileSync(join(fixture.root, 'universe', file), text);
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('does not begin with its title')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('the state files are required: canon sections, thread vocabulary and atlas chapters', () => {
  const canon = buildFixture({ canon: '# Canon — Imported Book\n\n## World\n- nothing yet.\n' });
  const threads = buildFixture({ threads: { open: [{ id: 'thread-1', kind: 'omen', question: 'Who?', created_chapter: 1 }], closed: [], promises: [], deferred_answers: [] } });
  const atlas = buildFixture({
    atlas: { version: 1, axes: [{ id: 'cosmos-scale', name: 'Cosmos & scale', nodes: [{ id: 'dyson-swarm', label: 'A swarm', state: 'mentioned', chapters: [9] }] }] },
  });
  try {
    for (const fixture of [canon, threads, atlas]) {
      const result = run(fixture);
      assert.equal(result.status, 2, result.stdout);
      assert.equal(result.envelope.code, 'INVALID_IMPORT');
    }
    assert.ok(run(canon).envelope.errors.some((error) => error.includes('does not contain the section "## Timeline"')));
    assert.ok(run(threads).envelope.errors.some((error) => error.includes('unknown kind "omen"')));
    assert.ok(run(atlas).envelope.errors.some((error) => error.includes('cites chapter 9')));
  } finally {
    cleanup([canon.root, threads.root, atlas.root]);
  }
});

test('a book whose language differs from the universe is imported and reported, never translated', () => {
  const fixture = buildFixture({ language: 'en', detectedLanguage: 'ro' });
  try {
    const result = run(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.ok(
      result.envelope.warnings.some((warning) => warning.startsWith('LANGUAGE_MISMATCH:') && warning.includes('the book is in ro')),
      result.envelope.warnings.join(' | '),
    );
  } finally {
    cleanup([fixture.root]);
  }
});

test('a record that claims a language match its own numbers contradict is INVALID_IMPORT', () => {
  const fixture = buildFixture({ language: 'en', detectedLanguage: 'ro', record: { language: { book: 'ro', state: 'ro', universe: 'en', match: true } } });
  try {
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('language.match')));
  } finally {
    cleanup([fixture.root]);
  }
});

test('the usage contract is refused with USAGE and exit 2', () => {
  const fixture = buildFixture();
  try {
    for (const args of [
      [],
      ['--import', fixture.extractionFile],
      ['--universe', fixture.universe, '--import', fixture.extractionFile, '--chapters', '3'],
      ['--universe', fixture.universe, '--import', fixture.extractionFile, '--chapters', '4-2'],
      ['--universe', fixture.universe, '--import', fixture.extractionFile, '--silly'],
      ['--universe', join(fixture.root, 'nowhere'), '--import', fixture.extractionFile],
    ]) {
      const result = runCli(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(result.envelope.code, 'USAGE', args.join(' '));
      assert.equal(result.envelope.ok, false);
      assert.ok(result.envelope.errors[0].includes('Usage:'), args.join(' '));
    }
  } finally {
    cleanup([fixture.root]);
  }
});

test('chapter numbers beyond a finished import are the reader continuing the book, not a defect', () => {
  const fixture = buildFixture();
  try {
    writeFileSync(join(fixture.root, 'universe', 'chapters', `${pad4(3)}-afterwards.md`), '# Afterwards\n\nnew prose\n');
    const result = run(fixture);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.chapters_checked, 2);
  } finally {
    cleanup([fixture.root]);
  }
});

test('a chapter beyond the imported range while the import is unfinished is INVALID_IMPORT', () => {
  const fixture = buildFixture({
    chapters: { 1: { words: 400 }, 2: { words: 400 } },
    pending: { 3: 400 },
    complete: false,
    nextSourceChapter: 3,
  });
  try {
    writeFileSync(join(fixture.root, 'universe', 'chapters', `${pad4(3)}-too-early.md`), '# Too early\n\nprose the import did not write\n');
    const result = run(fixture);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.code, 'INVALID_IMPORT');
    assert.ok(result.envelope.errors.some((error) => error.includes('exists beyond the imported range')));
  } finally {
    cleanup([fixture.root]);
  }
});
