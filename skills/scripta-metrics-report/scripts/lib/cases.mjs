/**
 * `literary-case.v1` validation.
 *
 * The synthesis library under `fixtures/literary-cases/` is teaching and
 * regression material: paired short texts in Romanian and English where one
 * literary feature changes between the two halves. This module owns the closed
 * vocabulary of target distinctions — one feature each — and the document-level
 * rules of a single case: both halves, the declared change, the retention of
 * unchanged text and the expected evidence anchored at real UTF-8 byte offsets.
 * The library index, the reserved regression subset and the model-agreement
 * record are validated by `scripts/lib/case-library.mjs`.
 *
 * Nothing here calls a model, reads the network or writes to disk. The quote
 * check mirrors `evidence.v1` (`scripts/lib/evidence.mjs`): zero-based half-open
 * UTF-8 byte offsets, code-point boundaries and an exact slice match.
 */

import { TextDecoder } from 'node:util';

import { isPlainObject } from './errors.mjs';

export const CASE_SCHEMA_VERSION = 'literary-case.v1';
export const INDEX_SCHEMA_VERSION = 'literary-case-index.v1';
export const AGREEMENT_SCHEMA_VERSION = 'model-agreement-record.v1';

/** The two languages the library is required to cover. */
export const LIBRARY_LANGUAGES = Object.freeze(['ro', 'en']);
/** Every language carries this many pairs, and the requirement is "at least 24". */
export const CASES_PER_LANGUAGE = 12;
/** The declared prompt-regression subset is at least this large. */
export const MIN_REGRESSION_CASES = 6;
export const VARIANT_KINDS = Object.freeze(['pair', 'counterexample']);
export const AGREEMENT_STATUSES = Object.freeze(['unperformed', 'partial', 'reported']);

/**
 * The closed vocabulary of target distinctions and the single literary feature
 * each one is allowed to change. `change.feature` must equal the feature of the
 * case's `target_distinction`, which is what makes "one changed feature per
 * pair" a machine-checkable property rather than an author's promise.
 */
export const DISTINCTIONS = Object.freeze([
  {
    id: 'flat_versus_specific_emotion',
    feature: 'emotional_specificity',
    statement: 'A declared emotion ("she was sad") against a situated action that makes the feeling recoverable.',
  },
  {
    id: 'interchangeable_versus_distinct_voices',
    feature: 'voice_distinctness',
    statement: 'Speakers whose sentences could be swapped without loss against speakers whose syntax, vocabulary and tactics identify them.',
  },
  {
    id: 'unsupported_versus_motivated_choice',
    feature: 'choice_motivation',
    statement: 'A decision asserted as right against a decision whose cost and motive are visible in the scene.',
  },
  {
    id: 'exposition_in_dialogue',
    feature: 'dialogue_exposition',
    statement: 'Background recited to someone who already knows it against background that surfaces from a present dispute.',
  },
  {
    id: 'meaningful_versus_empty_repetition',
    feature: 'repetition_function',
    statement: 'A repeated phrase that stays on one meaning against a repeated phrase whose meaning changes with what it now costs.',
  },
  {
    id: 'quiet_scene',
    feature: 'quiet_scene_pressure',
    statement: 'A quiet scene whose pressure lives in small acts against the same scene with the pressure declared aloud.',
  },
  {
    id: 'nonlinear_chronology',
    feature: 'chronology_order',
    statement: 'A time jump the reader can re-anchor against a jump with no recoverable order.',
  },
  {
    id: 'static_character',
    feature: 'character_stasis_function',
    statement: 'A character who does not change while the scenes around the same habit keep revealing more, against a repeated label that replaces the character.',
  },
  {
    id: 'unreliable_narration',
    feature: 'narrator_reliability_signal',
    statement: 'A narrator contradicted by recoverable evidence in a consistent direction against contradictions with no pattern.',
  },
  {
    id: 'intentional_ambiguity',
    feature: 'interpretive_openness',
    statement: 'An open ending that two evidenced readings can support against an open ending that rests on facts that cannot both hold.',
  },
  {
    id: 'counterexample_added_conflict',
    feature: 'conflict_addition',
    statement: 'A scene whose withheld pressure is its effect, against the same scene with an open quarrel added; the addition weakens the intended quiet.',
  },
  {
    id: 'counterexample_added_explanation',
    feature: 'explanation_addition',
    statement: 'A gesture left for the reader, against the same gesture explained by the narrator; the explanation weakens the intended restraint.',
  },
]);

const DISTINCTION_BY_ID = new Map(DISTINCTIONS.map((entry) => [entry.id, entry]));

const ID_PATTERN = /^[a-z]{2}-[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/;
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/;

const decoder = new TextDecoder('utf-8', { fatal: true });

export function distinctionById(id) {
  return DISTINCTION_BY_ID.get(id) || null;
}

/** Paragraphs of a side text, split on a blank line. Never trims the prose. */
export function paragraphsOf(text) {
  return text.split(/\n{2,}/);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isStringArray(value, { min = 1 } = {}) {
  return Array.isArray(value) && value.length >= min && value.every(isNonEmptyString);
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Anchor a quote inside a side text. Returns `{ ok, errors, start, end }`.
 * A quote that is absent, that occurs more than once, that carries wrong
 * offsets or that ends inside a multibyte character is an error: the expected
 * evidence of a case must point at one unambiguous place in the exact bytes.
 */
export function anchorQuote(text, quote) {
  const errors = [];
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, errors: ['side text must be a non-empty string'], start: null, end: null };
  }
  if (typeof quote !== 'string' || quote.length === 0) {
    return { ok: false, errors: ['quote must be a non-empty string'], start: null, end: null };
  }
  const haystack = Buffer.from(text, 'utf8');
  const needle = Buffer.from(quote, 'utf8');
  const first = haystack.indexOf(needle);
  if (first < 0) {
    return { ok: false, errors: [`quote not found in the side text: ${JSON.stringify(quote)}`], start: null, end: null };
  }
  if (haystack.indexOf(needle, first + 1) >= 0) {
    return { ok: false, errors: [`quote is ambiguous; it occurs more than once: ${JSON.stringify(quote)}`], start: null, end: null };
  }
  const start = first;
  const end = first + needle.length;
  if (!isCodePointBoundary(haystack, start)) errors.push(`start ${start} is not a UTF-8 code-point boundary`);
  if (!isCodePointBoundary(haystack, end)) errors.push(`end ${end} is not a UTF-8 code-point boundary`);
  if (errors.length === 0 && decoder.decode(haystack.subarray(start, end)) !== quote) {
    errors.push('the byte range does not decode to the declared quote');
  }
  return errors.length === 0 ? { ok: true, errors, start, end } : { ok: false, errors, start, end };
}

function isCodePointBoundary(bytes, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > bytes.length) return false;
  if (offset === 0 || offset === bytes.length) return true;
  return (bytes[offset] & 0xc0) !== 0x80;
}

function checkSide(raw, side, label, errors) {
  if (!isPlainObject(raw)) {
    errors.push(`${label} must be a JSON object`);
    return null;
  }
  if (!isNonEmptyString(raw.label) || !SLUG_PATTERN.test(raw.label)) {
    errors.push(`${label}.label must be a lowercase slug such as "flat_emotion"`);
  }
  if (!isNonEmptyString(raw.text)) errors.push(`${label}.text must be a non-empty string`);
  return raw;
}

function checkChange(raw, distinction, errors) {
  if (!isPlainObject(raw)) {
    errors.push('change must be a JSON object');
    return;
  }
  if (!isNonEmptyString(raw.feature)) {
    errors.push('change.feature must be a non-empty string');
  } else if (distinction && raw.feature !== distinction.feature) {
    errors.push(
      `change.feature ${JSON.stringify(raw.feature)} does not match target_distinction ` +
        `${JSON.stringify(distinction.id)}, whose only feature is ${JSON.stringify(distinction.feature)}`,
    );
  }
  if (!isNonEmptyString(raw.description)) errors.push('change.description must be a non-empty string');
  const changed = raw.changed_paragraphs;
  if (!Array.isArray(changed) || changed.length === 0) {
    errors.push('change.changed_paragraphs must be a non-empty array of 1-based paragraph numbers');
  } else if (!changed.every((n) => Number.isInteger(n) && n > 0)) {
    errors.push('change.changed_paragraphs must contain only positive integers');
  } else if (changed.some((n, index) => index > 0 && n <= changed[index - 1])) {
    errors.push('change.changed_paragraphs must be strictly increasing');
  }
}

function checkEvidence(raw, sides, errors) {
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push('expected_evidence must be a non-empty array');
    return;
  }
  const seenSides = new Set();
  raw.forEach((item, index) => {
    const label = `expected_evidence[${index}]`;
    if (!isPlainObject(item)) {
      errors.push(`${label} must be a JSON object`);
      return;
    }
    const side = item.side === 'before' || item.side === 'after' ? item.side : null;
    if (!side) {
      errors.push(`${label}.side must be "before" or "after"`);
      return;
    }
    seenSides.add(side);
    if (!isNonEmptyString(item.expectation)) errors.push(`${label}.expectation must be a non-empty string`);
    const text = sides[side];
    if (typeof text !== 'string' || text.length === 0) {
      errors.push(`${label}.side references a side without text`);
      return;
    }
    const anchor = anchorQuote(text, item.quote);
    if (!anchor.ok) {
      anchor.errors.forEach((message) => errors.push(`${label}: ${message}`));
      return;
    }
    if (item.start !== anchor.start || item.end !== anchor.end) {
      errors.push(
        `${label}: offsets [${item.start},${item.end}) do not match the quote's real range ` +
          `[${anchor.start},${anchor.end}) in the ${side} text`,
      );
    }
  });
  ['before', 'after'].forEach((side) => {
    if (!seenSides.has(side)) errors.push(`expected_evidence must quote at least one passage from the ${side} side`);
  });
}

/**
 * Validate one case document. Returns an array of `{ file, message }` problems;
 * an empty array means the case is a valid pair.
 */
export function checkCase(raw, file = 'case.json') {
  const errors = [];
  const push = (message) => errors.push({ file, message });
  if (!isPlainObject(raw)) {
    push('case must be a JSON object');
    return errors;
  }
  if (raw.schema_version !== CASE_SCHEMA_VERSION) {
    push(`unsupported schema_version ${JSON.stringify(raw.schema_version)}; expected ${JSON.stringify(CASE_SCHEMA_VERSION)}`);
    return errors;
  }
  if (!isNonEmptyString(raw.id) || !ID_PATTERN.test(raw.id)) {
    push('id must be a stable identifier such as "ro-01-flat-versus-specific-emotion"');
  }
  if (!LIBRARY_LANGUAGES.includes(raw.language)) {
    push(`language must be one of ${LIBRARY_LANGUAGES.join('|')}`);
  } else if (isNonEmptyString(raw.id) && !raw.id.startsWith(`${raw.language}-`)) {
    push(`id ${JSON.stringify(raw.id)} must start with its language prefix ${JSON.stringify(`${raw.language}-`)}`);
  }
  if (!isNonEmptyString(raw.title)) push('title must be a non-empty string');
  if (!isNonEmptyString(raw.intention)) push('intention must be a non-empty string');
  if (raw.synthetic !== true) push('synthetic must be true: every case is synthetic teaching material');
  if (raw.label !== 'synthetic_teaching_and_regression') {
    push('label must be "synthetic_teaching_and_regression"');
  }
  if (typeof raw.regression !== 'boolean') push('regression must be a boolean');
  if (raw.weaker_side !== 'after') {
    push('weaker_side must be "after": the after side is the variant under discussion in every case');
  }
  if (!VARIANT_KINDS.includes(raw.kind)) push(`kind must be one of ${VARIANT_KINDS.join('|')}`);

  const distinction = distinctionById(raw.target_distinction);
  if (!distinction) {
    push(`unknown target_distinction ${JSON.stringify(raw.target_distinction)}`);
  } else if (!isNonEmptyString(raw.distinction_statement)) {
    push('distinction_statement must be a non-empty string');
  }

  const before = checkSide(raw.before, 'before', 'before', errors);
  const after = checkSide(raw.after, 'after', 'after', errors);
  const sides = {
    before: isNonEmptyString(before && before.text) ? before.text : '',
    after: isNonEmptyString(after && after.text) ? after.text : '',
  };

  const paragraphs = { before: paragraphsOf(sides.before), after: paragraphsOf(sides.after) };
  const declared = distinction ? raw.change && raw.change.changed_paragraphs : null;

  if (!isPlainObject(raw.change)) errors.push({ file, message: 'change must be a JSON object' });
  else checkChange(raw.change, distinction, errors);

  if (before && after && isNonEmptyString(sides.before) && isNonEmptyString(sides.after)) {
    if (sides.before === sides.after) push('the two sides are identical; a pair must change something');
    if (paragraphs.before.length !== paragraphs.after.length) {
      push(
        `the sides must keep the same paragraph count so the diff stays inside declared paragraphs ` +
          `(before ${paragraphs.before.length}, after ${paragraphs.after.length})`,
      );
    } else {
      const differing = [];
      paragraphs.before.forEach((text, index) => {
        if (text !== paragraphs.after[index]) differing.push(index + 1);
      });
      const declaredList = Array.isArray(declared) && declared.length > 0 ? declared : [];
      if (declaredList.length > 0 && differing.join(',') !== declaredList.join(',')) {
        push(
          `change.changed_paragraphs ${JSON.stringify(declaredList)} does not match the paragraphs that ` +
            `actually differ ${JSON.stringify(differing)}`,
        );
      }
      if (differing.length === 0) push('no paragraph differs between the two sides');
      if (differing.length === paragraphs.before.length) {
        push('every paragraph differs; a pair must retain unchanged text so the diff is one feature');
      }
      if (declaredList.length > 0 && declaredList.some((n) => n > paragraphs.before.length)) {
        push('change.changed_paragraphs references a paragraph that does not exist');
      }
    }
    if (raw.kind === 'counterexample' && byteLength(sides.after) <= byteLength(sides.before)) {
      push('a counterexample case must add material: the after side is longer than the before side');
    }
  }

  checkEvidence(raw.expected_evidence, sides, errors);

  if (!isStringArray(raw.acceptable_alternative_readings)) {
    push('acceptable_alternative_readings must be a non-empty array of strings');
  }
  const provenance = raw.provenance;
  if (!isPlainObject(provenance)) {
    push('provenance must be a JSON object');
  } else {
    ['author', 'origin', 'rights', 'model_calls'].forEach((key) => {
      if (!isNonEmptyString(provenance[key])) push(`provenance.${key} must be a non-empty string`);
    });
    if (!isNonEmptyString(provenance.created) || !ISO_DATE_PATTERN.test(provenance.created)) {
      push('provenance.created must be an ISO date such as "2026-09-22"');
    }
    if (provenance.material !== 'original_synthetic') {
      push('provenance.material must be "original_synthetic": no third-party text is used');
    }
  }
  // `checkEvidence` pushes bare messages; every problem is reported as {file,message}.
  return errors.map((problem) => (typeof problem === 'string' ? { file, message: problem } : problem));
}
