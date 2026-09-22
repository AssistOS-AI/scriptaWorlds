import test from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CASES_PER_LANGUAGE,
  DISTINCTIONS,
  LIBRARY_LANGUAGES,
  MIN_REGRESSION_CASES,
  anchorQuote,
  checkCase,
} from '../scripts/lib/cases.mjs';
import { checkAgreement, checkLibrary, loadCaseLibrary } from '../scripts/lib/case-library.mjs';
import { cleanup, tempDir } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'fixtures', 'literary-cases');
const VALIDATOR = resolve(HERE, '..', 'scripts', 'validate-cases.mjs');

const library = loadCaseLibrary(FIXTURES);

function caseDocument(id) {
  return JSON.parse(JSON.stringify(library.cases.get(id)));
}

function messages(problems) {
  return problems.map((problem) => problem.message).join(' | ');
}

/** Run the validator CLI without throwing. */
function runValidator(fixturesDir) {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, '--fixtures', fixturesDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString('utf8');
    return { status: 0, envelope: JSON.parse(stdout) };
  } catch (error) {
    const stdout = error.stdout ? error.stdout.toString('utf8') : '';
    let envelope = null;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      envelope = null;
    }
    return { status: error.status, envelope };
  }
}

/** Copy the library, break one case, and return the broken copy's directory. */
function withBrokenCase(root, id, mutate) {
  const copy = join(root, 'literary-cases');
  cpSync(FIXTURES, copy, { recursive: true });
  const file = join(copy, 'cases', `${id}.json`);
  const document = JSON.parse(readFileSync(file, 'utf8'));
  mutate(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return copy;
}

test('every case in the library is a valid synthetic pair', () => {
  assert.deepEqual(library.cases.size, 24);
  const result = checkLibrary(library);
  assert.deepEqual(result.errors, [], messages(result.errors));
  assert.equal(result.ok, true);
  for (const [id, document] of library.cases) {
    assert.equal(document.synthetic, true, `${id} is labelled synthetic`);
    assert.equal(document.label, 'synthetic_teaching_and_regression', `${id} carries the teaching/regression label`);
    assert.equal(document.weaker_side, 'after', `${id} names the weaker side`);
    assert.equal(document.provenance.model_calls, 'none', `${id} was authored without a model`);
  }
  assert.equal(library.index.human_benchmark, false, 'the library is never declared a human benchmark');
});

test('every pair changes exactly one declared feature and keeps the rest of its text', () => {
  for (const [id, document] of library.cases) {
    const paragraphs = { before: document.before.text.split(/\n{2,}/), after: document.after.text.split(/\n{2,}/) };
    assert.equal(paragraphs.before.length, paragraphs.after.length, `${id} keeps the paragraph structure`);
    const differing = [];
    paragraphs.before.forEach((text, index) => {
      if (text !== paragraphs.after[index]) differing.push(index + 1);
    });
    assert.deepEqual(differing, document.change.changed_paragraphs, `${id} declares the paragraphs that really changed`);
    assert.ok(differing.length < paragraphs.before.length, `${id} retains unchanged text`);
    assert.equal(document.change.feature, DISTINCTIONS.find((entry) => entry.id === document.target_distinction).feature);

    const twoFeatures = caseDocument(id);
    twoFeatures.change.feature = DISTINCTIONS.find((entry) => entry.feature !== twoFeatures.change.feature).feature;
    assert.match(messages(checkCase(twoFeatures)), /does not match target_distinction/, `${id} refuses a second feature`);

    const wrongParagraphs = caseDocument(id);
    wrongParagraphs.change.changed_paragraphs = [1, paragraphs.before.length];
    assert.match(messages(checkCase(wrongParagraphs)), /does not match the paragraphs that actually differ/);
  }
});

test('the library carries twelve Romanian and twelve English pairs covering every distinction', () => {
  const result = checkLibrary(library);
  assert.deepEqual(result.stats.by_language, { ro: 12, en: 12 });
  assert.equal(CASES_PER_LANGUAGE, 12);
  assert.ok(result.stats.cases >= 24);
  assert.equal(result.stats.distinctions, DISTINCTIONS.length);
  for (const language of LIBRARY_LANGUAGES) {
    const covered = new Set();
    for (const document of library.cases.values()) {
      if (document.language === language) covered.add(document.target_distinction);
    }
    assert.deepEqual(
      [...covered].sort(),
      DISTINCTIONS.map((entry) => entry.id).sort(),
      `${language} covers every target distinction exactly once`,
    );
  }
  const counterexamples = [...library.cases.values()].filter((document) => document.kind === 'counterexample');
  assert.equal(counterexamples.length, 4, 'the two counterexample distinctions are covered in both languages');
  for (const document of counterexamples) {
    assert.ok(
      Buffer.byteLength(document.after.text, 'utf8') > Buffer.byteLength(document.before.text, 'utf8'),
      `${document.id} adds material in its weaker half`,
    );
  }
});

test('a malformed case is rejected by the schema and by the command', () => {
  const missingIntention = caseDocument('ro-01-flat-versus-specific-emotion');
  delete missingIntention.intention;
  assert.match(messages(checkCase(missingIntention, 'cases/x.json')), /intention must be a non-empty string/);

  const wrongLanguage = caseDocument('ro-02-interchangeable-versus-distinct-voices');
  wrongLanguage.language = 'fr';
  assert.match(messages(checkCase(wrongLanguage)), /language must be one of ro\|en/);

  const duplicateId = caseDocument('ro-03-unsupported-versus-motivated-choice');
  duplicateId.id = duplicateId.id.toUpperCase();
  assert.match(messages(checkCase(duplicateId)), /id must be a stable identifier/);

  const root = tempDir('metrics-cases-malformed-');
  try {
    const copy = withBrokenCase(root, 'ro-04-exposition-in-dialogue', (document) => {
      delete document.expected_evidence;
    });
    const run = runValidator(copy);
    assert.equal(run.status, 2, 'the command refuses a malformed case');
    assert.equal(run.envelope.ok, false);
    assert.equal(run.envelope.code, 'INVALID_CASE_LIBRARY');
    assert.match(
      run.envelope.errors.map((problem) => `${problem.file}: ${problem.message}`).join(' | '),
      /cases\/ro-04-exposition-in-dialogue\.json: expected_evidence must be a non-empty array/,
    );
  } finally {
    cleanup([root]);
  }
});

test('an evidence quote that does not sit at its declared offsets is rejected', () => {
  const shifted = caseDocument('ro-05-meaningful-versus-empty-repetition');
  shifted.expected_evidence[0].start += 1;
  shifted.expected_evidence[0].end += 1;
  assert.match(messages(checkCase(shifted)), /do not match the quote's real range/);

  const invented = caseDocument('en-05-meaningful-versus-empty-repetition');
  invented.expected_evidence[0].quote = 'this sentence was never written in the case';
  assert.match(messages(checkCase(invented)), /quote not found in the side text/);

  const repeated = caseDocument('en-01-flat-versus-specific-emotion');
  repeated.expected_evidence[0].quote = 'the';
  repeated.expected_evidence[0].start = 0;
  repeated.expected_evidence[0].end = 3;
  assert.match(messages(checkCase(repeated)), /quote is ambiguous/);

  const oneSided = caseDocument('en-06-quiet-scene');
  oneSided.expected_evidence = oneSided.expected_evidence.filter((item) => item.side === 'after');
  assert.match(messages(checkCase(oneSided)), /must quote at least one passage from the before side/);

  const root = tempDir('metrics-cases-unanchored-');
  try {
    const copy = withBrokenCase(root, 'ro-06-quiet-scene', (document) => {
      document.expected_evidence[1].start += 4;
      document.expected_evidence[1].end += 4;
    });
    const run = runValidator(copy);
    assert.equal(run.status, 2, 'the command refuses an unanchored quote');
    assert.match(run.envelope.errors.map((problem) => problem.message).join(' | '), /do not match the quote's real range/);
  } finally {
    cleanup([root]);
  }
});

test('anchored quotes are matched as UTF-8 bytes, not as character indices', () => {
  const text = 'Mărțișor și țuică, după aceea.';
  const quote = 'țuică';
  // "Mărțișor și " carries Romanian diacritics, so its byte length differs from
  // its character count: the offsets must be byte offsets.
  const start = Buffer.byteLength('Mărțișor și ', 'utf8');
  assert.notEqual(start, 'Mărțișor și '.length);
  const anchored = anchorQuote(text, quote);
  assert.equal(anchored.ok, true, anchored.errors.join(' | '));
  assert.deepEqual([anchored.start, anchored.end], [start, start + Buffer.byteLength(quote, 'utf8')]);
  assert.equal(Buffer.from(text, 'utf8').subarray(anchored.start, anchored.end).toString('utf8'), quote);

  const libraryQuote = anchorQuote(
    library.cases.get('ro-10-intentional-ambiguity').before.text,
    'Haina de pe scaun lipsea, dar papucii erau la locul lor',
  );
  assert.equal(libraryQuote.ok, true);
});

test('the reserved regression subset is declared, non-empty and matches the flagged cases', () => {
  const subset = library.index.regression_subset;
  assert.equal(subset.declared, true);
  assert.ok(Array.isArray(subset.case_ids) && subset.case_ids.length >= MIN_REGRESSION_CASES);
  assert.equal(new Set(subset.case_ids).size, subset.case_ids.length);
  const flagged = [...library.cases.entries()]
    .filter(([, document]) => document.regression === true)
    .map(([id]) => id)
    .sort();
  assert.deepEqual([...subset.case_ids].sort(), flagged);
  assert.match(subset.use, /regression/i);
  const languages = new Set(subset.case_ids.map((id) => library.cases.get(id).language));
  assert.deepEqual([...languages].sort(), [...LIBRARY_LANGUAGES].sort());

  const driftedIndex = JSON.parse(JSON.stringify(library.index));
  const droppedId = driftedIndex.regression_subset.case_ids.pop();
  const driftedCase = caseDocument(droppedId);
  const result = checkLibrary({ ...library, index: driftedIndex, cases: new Map(library.cases).set(droppedId, driftedCase) });
  assert.match(messages(result.errors), /must equal exactly the cases flagged regression: true/);

  const removedIndex = JSON.parse(JSON.stringify(library.index));
  removedIndex.regression_subset.declared = false;
  assert.match(messages(checkLibrary({ ...library, index: removedIndex }).errors), /must declare the reserved prompt-regression subset/);
});

test('model agreement is recorded as unperformed and no result is invented', () => {
  const agreement = library.agreement;
  assert.equal(agreement.status, 'unperformed');
  assert.equal(agreement.performed_at, null);
  assert.deepEqual(agreement.runs, []);
  assert.deepEqual(agreement.failures, []);
  assert.equal(agreement.human_study.status, 'not_performed');
  assert.match(agreement.honesty_note, /recorded run/);
  assert.deepEqual(library.index.model_agreement, { record: 'model-agreement.json', status: 'unperformed' });
  assert.deepEqual(checkAgreement(agreement), []);

  const fabricated = JSON.parse(JSON.stringify(agreement));
  fabricated.runs.push({ model: 'a-model', prompt_version: 'v1', rubric_version: 'v1', date: '2026-09-22', recorded_by: 'nobody' });
  fabricated.cases_agreed = 24;
  assert.match(messages(checkAgreement(fabricated)), /must not carry runs/);

  const unverifiable = JSON.parse(JSON.stringify(agreement));
  unverifiable.status = 'reported';
  unverifiable.performed_at = '2026-09-22T10:00:00.000Z';
  unverifiable.runs.push({
    model: 'a-model',
    prompt_version: 'v1',
    rubric_version: 'v1',
    date: '2026-09-22',
    recorded_by: 'a person',
    cases_attempted: 8,
    cases_agreed: 6,
    disagreements: [],
  });
  assert.match(messages(checkAgreement(unverifiable)), /must record prompt_hash or input_hashes/);
});

test('the validator command accepts the full library and prints its summary', () => {
  const run = runValidator(FIXTURES);
  assert.equal(run.status, 0, JSON.stringify(run.envelope));
  assert.equal(run.envelope.ok, true);
  assert.equal(run.envelope.schema_version, 'literary-case-validation.v1');
  assert.equal(run.envelope.cases, 24);
  assert.deepEqual(run.envelope.by_language, { ro: 12, en: 12 });
  assert.equal(run.envelope.distinctions, 12);
  assert.equal(run.envelope.regression_cases, 8);
  assert.equal(run.envelope.model_agreement_status, 'unperformed');
  assert.equal(run.envelope.human_benchmark, false);
  assert.deepEqual(run.envelope.errors, []);

  const missing = runValidator(join(FIXTURES, 'does-not-exist'));
  assert.equal(missing.status, 2);
  assert.equal(missing.envelope.ok, false);
});
