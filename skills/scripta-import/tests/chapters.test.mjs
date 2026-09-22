import test from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { checkChapters, scanChapterFiles } from '../scripts/lib/chapters.mjs';
import { loadExtraction } from '../scripts/lib/extraction.mjs';
import { PROSE_COVERAGE_MIN } from '../scripts/lib/limits.mjs';
import { loadRecord } from '../scripts/lib/record.mjs';
import { planTurnWindow, sourceWindow } from '../scripts/lib/turns.mjs';
import { chapterTitle, countWords, normalizeTokens, plausibleWordRange, proseCoverage, proseText } from '../scripts/lib/text.mjs';
import { buildFixture, cleanup, prose, writeFile } from './helpers.mjs';

function load(fixture) {
  const extraction = loadExtraction(fixture.extractionFile);
  assert.equal(extraction.ok, true, extraction.problems.map((entry) => entry.message).join(' | '));
  const recordResult = loadRecord(fixture.universe, extraction.extraction);
  assert.equal(recordResult.ok, true, recordResult.problems.map((entry) => entry.message).join(' | '));
  return { extraction: extraction.extraction, record: recordResult.record };
}

test('a chapter file is prose plus a title, and the title is the first line', () => {
  const markdown = '# The Ash Archive\n\nFirst paragraph.\n\n---\n\n> A quote.\n\nSecond paragraph.\n';
  assert.equal(chapterTitle(markdown), 'The Ash Archive');
  assert.equal(chapterTitle('The Ash Archive\n\nprose\n'), null);
  assert.equal(proseText(markdown).includes('First paragraph.'), true);
  assert.equal(proseText(markdown).includes('The Ash Archive'), false, 'the title is not prose');
  assert.equal(proseText(markdown).includes('---'), false, 'a scene separator is not prose');
  assert.deepEqual(normalizeTokens(proseText(markdown)), ['first', 'paragraph', 'a', 'quote', 'second', 'paragraph']);
  assert.equal(countWords(markdown), 12, 'words count everything a reader sees, title and quote marks included');
});

test('the word band allows cleaning and refuses a cut chapter', () => {
  const source = prose(1000, 'a').text;
  const tokens = normalizeTokens(source);
  const lowered = normalizeTokens(source.split(' ').slice(0, 700).join(' '));
  assert.ok(proseCoverage(tokens, tokens) === 1);
  assert.equal(proseCoverage(tokens, lowered), 1, 'the kept part is still the book\'s own prose');
  const band = plausibleWordRange(1000);
  assert.equal(band.lower, 800);
  assert.equal(band.upper, 1200);
  const short = plausibleWordRange(10);
  assert.equal(short.lower, 0);
  assert.equal(short.upper, 30);
});

test('prose that was written rather than copied shares no run with the extraction', () => {
  const source = normalizeTokens(prose(400, 'book').text);
  const invented = normalizeTokens(prose(400, 'invented').text);
  assert.ok(proseCoverage(source, invented) < PROSE_COVERAGE_MIN);
  assert.ok(proseCoverage(invented, source) < PROSE_COVERAGE_MIN);
  assert.equal(proseCoverage(source, []), 0);
});

test('a short chapter is compared token by token, because runs need eight tokens', () => {
  const source = normalizeTokens('one two three four');
  assert.equal(proseCoverage(source, normalizeTokens('one two')), 1);
  assert.equal(proseCoverage(source, normalizeTokens('five six')), 0);
});

test('the chapter scan groups files by number and ignores offers and other names', () => {
  const fixture = buildFixture();
  try {
    const files = scanChapterFiles(fixture.universe);
    assert.deepEqual([...files.keys()].sort(), [1, 2]);
    assert.equal(files.get(1).length, 1);
  } finally {
    cleanup([fixture.root]);
  }
});

test('one extraction chapter cut into segments is checked as one chapter', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 600, split: 3 } }, segmentation: 'scene' });
  try {
    const { extraction, record } = load(fixture);
    assert.equal(record.chapters.length, 3, 'three universe chapters come from one extraction chapter');
    assert.deepEqual(record.chapters.map((entry) => entry.segment), [1, 2, 3]);
    const result = checkChapters({ universeDir: fixture.universe, extraction, record, range: null });
    assert.equal(result.ok, true, result.problems.map((entry) => entry.message).join(' | '));
    assert.equal(result.checked.length, 3);
  } finally {
    cleanup([fixture.root]);
  }
});

test('a segment that leaves a hole in the source chapter is WORD_COVERAGE', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 900, split: 3 } }, segmentation: 'scene' });
  try {
    const { extraction, record } = load(fixture);
    const middle = record.chapters[1];
    const parts = prose(900, 'c1').cleaned.split('\n\n');
    const kept = [...parts.slice(0, 3), ...parts.slice(9)];
    writeFile(fixture.universe, middle.file, `# ${middle.title}\n\n${kept.join('\n\n')}\n`);
    const result = checkChapters({ universeDir: fixture.universe, extraction, record, range: null });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WORD_COVERAGE');
  } finally {
    cleanup([fixture.root]);
  }
});

test('a word-count segmentation outside its own band is a warning, not a refusal', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 240, split: 3 } }, segmentation: 'word_count' });
  try {
    const { extraction, record } = load(fixture);
    const result = checkChapters({ universeDir: fixture.universe, extraction, record, range: null });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings.map((entry) => entry.code), ['SEGMENT_OFF_BAND', 'SEGMENT_OFF_BAND']);

    const long = buildFixture({ chapters: { 1: { words: 5400, split: 3 } }, segmentation: 'word_count' });
    try {
      const loaded = load(long);
      const longResult = checkChapters({ universeDir: long.universe, extraction: loaded.extraction, record: loaded.record, range: null });
      assert.equal(longResult.ok, true, longResult.problems.map((entry) => entry.message).join(' | '));
      assert.deepEqual(longResult.warnings, []);
    } finally {
      cleanup([long.root]);
    }
  } finally {
    cleanup([fixture.root]);
  }
});

test('a range names the extraction chapters of one turn, so a cut chapter stays whole inside it', () => {
  const fixture = buildFixture({ chapters: { 1: { words: 500, split: 2 }, 2: { words: 500 } } });
  try {
    const { extraction, record } = load(fixture);
    const firstSource = checkChapters({ universeDir: fixture.universe, extraction, record, range: { from: 1, to: 1 } });
    assert.equal(firstSource.ok, true, firstSource.problems.map((entry) => entry.message).join(' | '));
    assert.deepEqual(firstSource.checked.map((entry) => entry.chapter), [1, 2], 'both segments of extraction chapter 1 are checked together');

    const whole = checkChapters({ universeDir: fixture.universe, extraction, record, range: { from: 1, to: 2 } });
    assert.equal(whole.ok, true);
    assert.equal(whole.checked.length, 3);
  } finally {
    cleanup([fixture.root]);
  }
});

test('the turn window is bounded by chapters and by words, and always holds one chapter', () => {
  const chapters = [1, 2, 3, 4, 5].map((number) => ({ number, words: 2000 }));
  const window = planTurnWindow(chapters, 1);
  assert.deepEqual(window.chapters.map((entry) => entry.number), [1, 2, 3]);
  assert.equal(window.words, 6000);

  const long = [{ number: 1, words: 9000 }, { number: 2, words: 100 }];
  const single = planTurnWindow(long, 1);
  assert.deepEqual(single.chapters.map((entry) => entry.number), [1], 'a chapter longer than the bound is imported alone');
  assert.equal(single.words, 9000);

  const heavy = [1, 2, 3, 4].map((number) => ({ number, words: 4000 }));
  assert.deepEqual(planTurnWindow(heavy, 1).chapters.map((entry) => entry.number), [1], 'the word bound stops the window');
  assert.equal(planTurnWindow(chapters, 9), null, 'a pointer outside the extraction has no window');
  assert.deepEqual(sourceWindow(chapters, 2, 4).map((entry) => entry.number), [2, 3, 4]);
  assert.equal(sourceWindow(chapters, 4, 2), null);
});
