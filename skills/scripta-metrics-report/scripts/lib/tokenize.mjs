/**
 * Deterministic UTF-8 Markdown prose tokenizer, method version 2.
 *
 * The method is versioned because every lexical metric depends on it, and its
 * applicability is bounded and stated rather than guessed:
 *
 *   - **Segmentation.** A token is a maximal run of Unicode letters (`\p{L}`)
 *     optionally continuing with combining marks (`\p{L}\p{M}*`). Whitespace,
 *     digits, punctuation, symbols and Markdown markers separate tokens.
 *     Languages whose script does not delimit words with separators (Chinese,
 *     Japanese, Korean, Thai, Khmer, Lao, Burmese, Tibetan and Dzongkha) cannot
 *     be segmented by this method: `tokenize` reports `supported: false` and the
 *     lexical metrics become `not_assessable` with that reason instead of a
 *     misleading zero.
 *   - **Case.** Every token is lower-cased with `String.prototype.toLowerCase`,
 *     so `The` and `the` compare equal everywhere the same locale-independent
 *     mapping applies.
 *   - **Numbers.** Digits are separators, never tokens: `chapter 2` and
 *     `chapter 3` are the same token sequence. A purely numeric difference is
 *     therefore invisible to SI and TOP, which is a stated limitation.
 *   - **Apostrophes and hyphens.** `don't`, `well-known` and `it_s` split into
 *     two or three tokens; contractions are never joined.
 *   - **Diacritics.** Letters with diacritics are ordinary letters and are kept.
 *     Precomposed and decomposed spellings (`ș` vs `s` + combining comma) are
 *     different tokens: the text is not normalized, so a mixed normalization
 *     convention inside one book lowers similarity.
 *   - **Markdown.** `#`/`##` heading markers, `> ` quotation markers, `*`/`_`
 *     emphasis and `---` separators are separators: the words inside a heading or
 *     a quotation are ordinary eligible tokens, so quoted material and headings
 *     count toward the denominator. Boilerplate is not detected automatically;
 *     it is handled by excluding a source from the corpus (see corpus.mjs).
 *   - **Byte mapping.** Every token carries `[start, end)` byte offsets into the
 *     original UTF-8 buffer, computed through an explicit UTF-16 code-unit to
 *     UTF-8 byte table, so a match always maps back to the original bytes.
 */

import { TextDecoder } from 'node:util';

import { fail } from './errors.mjs';

export const TOKENIZER_VERSION = 2;
export const TOKENIZER_METHOD = 'unicode-letter-run-v2+byte-offsets';

/** Languages whose script this method cannot segment (no whitespace delimiters). */
export const UNSUPPORTED_SEGMENTATION_LANGUAGES = ['zh', 'ja', 'ko', 'th', 'km', 'lo', 'my', 'bo', 'dz'];

const LETTER_RUN = /\p{L}[\p{L}\p{M}]*/gu;

/** Normalize an ISO 639-1 style code to its lowercase primary subtag. */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return primary.length === 0 ? null : primary;
}

/**
 * Whether this method can segment `language`. Unknown codes are treated as
 * space-delimited; only the scripts listed above are declared unsupported.
 */
export function segmentationSupport(language) {
  const normalized = normalizeLanguage(language);
  if (normalized !== null && UNSUPPORTED_SEGMENTATION_LANGUAGES.includes(normalized)) {
    return {
      supported: false,
      language: normalized,
      reason:
        `tokenization is unsupported for language "${normalized}": its script does not delimit words with ` +
        'separators, so this method cannot produce a comparable token sequence',
    };
  }
  return { supported: true, language: normalized, reason: null };
}

/**
 * Map every UTF-16 code-unit index in `text` to the byte offset of that code
 * unit in the original UTF-8 buffer. `offsets[text.length]` is the byte length.
 */
function buildByteOffsets(text) {
  const offsets = new Uint32Array(text.length + 1);
  let bytePos = 0;
  let i = 0;
  while (i < text.length) {
    offsets[i] = bytePos;
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytePos += 1;
      i += 1;
    } else if (code < 0x800) {
      bytePos += 2;
      i += 1;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: the pair encodes one code point (4 UTF-8 bytes). The
      // low surrogate has no distinct byte boundary, so its slot is never used
      // as a match boundary; store the pair's start for safety.
      offsets[i + 1] = bytePos;
      bytePos += 4;
      i += 2;
    } else {
      bytePos += 3;
      i += 1;
    }
  }
  offsets[text.length] = bytePos;
  return offsets;
}

/**
 * Tokenize a UTF-8 byte buffer. Returns
 *   { tokenizer_version, method, language, supported, missing_reason,
 *     tokens: string[], spans: {start,end}[], byte_length }.
 * Throws CliError (exit 2) when the buffer is not valid UTF-8.
 */
export function tokenize(buffer, label = 'text', options = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const support = segmentationSupport(options.language);
  const base = {
    tokenizer_version: TOKENIZER_VERSION,
    method: TOKENIZER_METHOD,
    language: support.language,
    supported: support.supported,
    missing_reason: support.reason,
    byte_length: bytes.length,
  };
  if (!support.supported) {
    return { ...base, tokens: [], spans: [] };
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error && error.message ? error.message : String(error)}`, 'INVALID_UTF8');
  }
  const offsets = buildByteOffsets(text);
  const tokens = [];
  const spans = [];
  for (const match of text.matchAll(LETTER_RUN)) {
    tokens.push(match[0].toLowerCase());
    spans.push({
      start: offsets[match.index],
      end: offsets[match.index + match[0].length],
    });
  }
  return { ...base, tokens, spans };
}
