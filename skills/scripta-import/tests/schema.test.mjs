import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  ATLAS_AXIS_IDS,
  ATLAS_STATES,
  CANON_SECTIONS,
  CODE_ORDER,
  EXTRACTION_PATH,
  EXTRACTION_TEXT_PATH,
  IMPORT_SCHEMA_VERSION,
  PROSE_COVERAGE_MIN,
  PROSE_RUN,
  RECORD_PATH,
  SEGMENTATIONS,
  SEGMENT_MAX_WORDS,
  SEGMENT_MIN_WORDS,
  SEGMENT_TARGET_WORDS,
  THREAD_COLLECTIONS,
  THREAD_KINDS,
  THREAD_STATUSES,
  TURN_MAX_CHAPTERS,
  TURN_MAX_WORDS,
  VALIDATION_SCHEMA_VERSION,
  WORD_RATIO_MAX,
  WORD_RATIO_MIN,
  WORD_SLACK,
} from '../scripts/lib/limits.mjs';
import { buildFixture, cleanup, pad4, prose, runCli, tempDir, writeFile, writeJson } from './helpers.mjs';

const SCHEMA = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'schema', 'import.v1.json'), 'utf8'));
const EXAMPLE = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'schema', 'import-progress.v1.example.json'), 'utf8'));

test('the published vocabulary and the code name the same numbers, lists and paths', () => {
  assert.equal(SCHEMA.schema_version, IMPORT_SCHEMA_VERSION);
  assert.equal(SCHEMA.extraction.path, EXTRACTION_PATH);
  assert.equal(SCHEMA.extraction.text_path, EXTRACTION_TEXT_PATH);
  assert.equal(SCHEMA.record.path, RECORD_PATH);
  assert.equal(SCHEMA.record.schema_version, IMPORT_SCHEMA_VERSION);
  assert.equal(SCHEMA.record.complete_example, 'schema/import-progress.v1.example.json');
  assert.equal(SCHEMA.turn_limits.max_chapters, TURN_MAX_CHAPTERS);
  assert.equal(SCHEMA.turn_limits.max_words, TURN_MAX_WORDS);
  assert.equal(SCHEMA.turn_limits.minimum_chapters, 1);
  assert.deepEqual(SCHEMA.segmentations, SEGMENTATIONS);
  assert.equal(SCHEMA.segment_words.target, SEGMENT_TARGET_WORDS);
  assert.equal(SCHEMA.segment_words.min, SEGMENT_MIN_WORDS);
  assert.equal(SCHEMA.segment_words.max, SEGMENT_MAX_WORDS);
  assert.equal(SCHEMA.word_band.ratio_min, WORD_RATIO_MIN);
  assert.equal(SCHEMA.word_band.ratio_max, WORD_RATIO_MAX);
  assert.equal(SCHEMA.word_band.slack, WORD_SLACK);
  assert.equal(SCHEMA.prose_overlap.run, PROSE_RUN);
  assert.equal(SCHEMA.prose_overlap.min, PROSE_COVERAGE_MIN);
  assert.deepEqual(SCHEMA.canon_sections, CANON_SECTIONS);
  assert.deepEqual(SCHEMA.thread_collections, THREAD_COLLECTIONS);
  assert.deepEqual(SCHEMA.thread_kinds, THREAD_KINDS);
  assert.deepEqual(SCHEMA.thread_statuses, THREAD_STATUSES);
  assert.deepEqual(SCHEMA.atlas_axes, ATLAS_AXIS_IDS);
  assert.deepEqual(SCHEMA.atlas_states, ATLAS_STATES);
  assert.equal(SCHEMA.validator.schema_version, VALIDATION_SCHEMA_VERSION);
  assert.deepEqual(SCHEMA.validator.codes, CODE_ORDER);
  assert.equal(SCHEMA.validator.exit_ok, 0);
  assert.equal(SCHEMA.validator.exit_failed, 2);
});

test('the record fields the schema publishes are the ones the record of an import carries', () => {
  const fixture = buildFixture();
  try {
    const record = JSON.parse(readFileSync(join(fixture.universe, RECORD_PATH), 'utf8'));
    for (const field of SCHEMA.record.required_fields) {
      assert.ok(Object.hasOwn(record, field), `the record must carry ${field}`);
    }
    for (const field of SCHEMA.record.chapter_entry_fields) {
      assert.ok(Object.hasOwn(record.chapters[0], field), `a chapter entry must carry ${field}`);
    }
    for (const field of SCHEMA.record.turn_entry_fields) {
      assert.ok(Object.hasOwn(record.turns[0], field), `a turn entry must carry ${field}`);
    }
    for (const field of SCHEMA.record.language_fields) {
      assert.ok(Object.hasOwn(record.language, field), `the language block must carry ${field}`);
    }
    const extracted = JSON.parse(readFileSync(fixture.extractionFile, 'utf8'));
    for (const field of SCHEMA.extraction.required_fields) {
      assert.ok(Object.hasOwn(extracted, field), `the extraction must carry ${field}`);
    }
    for (const field of SCHEMA.extraction.chapter_fields) {
      assert.ok(Object.hasOwn(extracted.chapters[0], field), `an extraction chapter must carry ${field}`);
    }
  } finally {
    cleanup([fixture.root]);
  }
});

test('the published example record is accepted by the validator on the universe it describes', () => {
  const root = tempDir('scripta-import-example-');
  try {
    const universe = join(root, 'universe');
    const first = prose(120, 'c1');
    const second = prose(140, 'c2');
    const third = prose(140, 'c3');
    writeFile(universe, `chapters/${pad4(1)}-the-ash-archive.md`, `# The Ash Archive\n\n${first.text}\n`);
    writeFile(universe, `chapters/${pad4(2)}-the-blind-librarian.md`, `# The Blind Librarian\n\n${second.text}\n`);
    writeJson(universe, EXTRACTION_PATH, {
      schema_version: 'book-import.v1',
      import_id: EXAMPLE.import_id,
      source: EXAMPLE.source,
      detected: EXAMPLE.detected,
      chapters: [
        { number: 1, title: 'The Ash Archive', words: 120, text: first.text },
        { number: 2, title: 'The Blind Librarian', words: 140, text: second.text },
        { number: 3, title: 'Chapter 3', words: 140, text: third.text },
      ],
      warnings: ['the source has no detectable chapter boundaries'],
    });
    writeJson(universe, RECORD_PATH, EXAMPLE);
    writeFile(
      universe,
      'canon.md',
      ['# Canon — The Ash Archive', '', '## Fundamental laws', '- Every book borrows the light of the one read before it.', '', '## World', '- The archive admits one reader at a time (ch. 1).', '', '## Recurring characters', '- **The keeper** — reads the shelves (ch. 1).', '', '## Timeline', '- Year 12 — the first living author is registered (ch. 1).', '', '## Stable facts', '- The registry never deletes an entry (ch. 2).', '', '## Mysteries with a fixed cause', ''].join('\n'),
    );
    writeJson(universe, 'threads.json', {
      open: [{ id: 'thread-0001', kind: 'mystery', question: 'Who lit the lamps?', created_chapter: 1, due_chapter: 4, status: 'open' }],
      closed: [],
      promises: [],
      deferred_answers: [],
    });
    writeJson(universe, 'atlas.json', { version: 1, axes: [{ id: 'knowledge-truth', name: 'Knowledge & truth', nodes: [{ id: 'catalogue-of-the-dead', label: 'A catalogue of the dead', state: 'dramatized', chapters: [1, 2] }] }] });
    writeJson(universe, 'universe.json', { id: 'the-ash-archive', title: 'The Ash Archive', language: 'ro', law: 'Every book borrows the light of the one read before it.' });

    const scoped = runCli(['--universe', universe, '--import', join(universe, EXTRACTION_PATH), '--chapters', '1-2']);
    assert.equal(scoped.status, 0, scoped.stdout);
    assert.equal(scoped.envelope.ok, true);
    assert.equal(scoped.envelope.next_source_chapter, 3);
    assert.deepEqual(scoped.envelope.errors, []);

    const whole = runCli(['--universe', universe, '--import', join(universe, EXTRACTION_PATH)]);
    assert.equal(whole.status, 0, whole.stdout);
    assert.equal(whole.envelope.chapters_checked, 2);
  } finally {
    cleanup([root]);
  }
});
