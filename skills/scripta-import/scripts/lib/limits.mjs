// Shared vocabulary and bounds of the import skill.
//
// Every number and every list this skill states in prose lives here, so the instructions in
// `SKILL.md` and in `references/` and the checks in `scripts/validate-import.mjs` name the same
// things. Nothing in this module reads a file, calls a model or reaches the network.

/** The schema version of the host's extraction file and of the import record this skill writes. */
export const IMPORT_SCHEMA_VERSION = 'book-import.v1';

/** The schema version of the single JSON envelope `validate-import.mjs` prints. */
export const VALIDATION_SCHEMA_VERSION = 'book-import-validation.v1';

/** Where the host writes the extraction, and where the twin plain-text rendering lives. */
export const EXTRACTION_PATH = '.agents/import/extracted.json';
export const EXTRACTION_TEXT_PATH = '.agents/import/book.md';

/** Where an import turn records how far it has come, and what a later turn continues from. */
export const RECORD_PATH = 'drafts/import-progress.json';

/** One import turn carries at most this many extraction chapters and this many words of prose. */
export const TURN_MAX_CHAPTERS = 3;
export const TURN_MAX_WORDS = 6000;

/** The band a self-segmented chapter aims for when the extraction offers no boundary at all. */
export const SEGMENT_TARGET_WORDS = 2000;
export const SEGMENT_MIN_WORDS = 1500;
export const SEGMENT_MAX_WORDS = 2500;

/**
 * How the chapters of the universe were obtained: from the host's own segmentation, or by this
 * skill cutting a boundaryless book at scene breaks or at a bounded word count. The record declares
 * the least structured method it used.
 */
export const SEGMENTATIONS = ['host', 'scene', 'word_count'];

/** An imported chapter is plausible when its word count stays in this band around its source chapter. */
export const WORD_RATIO_MIN = 0.8;
export const WORD_RATIO_MAX = 1.2;
export const WORD_SLACK = 20;

/**
 * The run length and the overlap bound used to prove that imported prose comes from the extraction.
 * Cleaning removes page furniture and rejoins hyphenated words, and every removal breaks the
 * overlapping runs that straddled it — about `PROSE_RUN - 1` runs per removal — so the bound sits
 * well below one and is documented as a plausibility test rather than a proof.
 */
export const PROSE_RUN = 8;
export const PROSE_COVERAGE_MIN = 0.85;

/** The failure codes of the validator, most severe first: the first one present names the envelope. */
export const CODE_NO_EXTRACTION = 'NO_EXTRACTION';
export const CODE_UNPARSEABLE_JSON = 'UNPARSEABLE_JSON';
export const CODE_INVALID_IMPORT = 'INVALID_IMPORT';
export const CODE_MISSING_CHAPTER = 'MISSING_CHAPTER';
export const CODE_WORD_COVERAGE = 'WORD_COVERAGE';
export const CODE_USAGE = 'USAGE';

export const CODE_ORDER = [
  CODE_NO_EXTRACTION,
  CODE_UNPARSEABLE_JSON,
  CODE_INVALID_IMPORT,
  CODE_MISSING_CHAPTER,
  CODE_WORD_COVERAGE,
];

/** Warnings never change `ok` or the exit status: they report something the operator should know. */
export const WARNING_TURN_OVERSIZE = 'TURN_OVERSIZE';
export const WARNING_SEGMENT_OFF_BAND = 'SEGMENT_OFF_BAND';
export const WARNING_LANGUAGE_MISMATCH = 'LANGUAGE_MISMATCH';
export const WARNING_EXTRACTION_WORD_MISMATCH = 'EXTRACTION_WORD_MISMATCH';
export const WARNING_UNIVERSE_UNREADABLE = 'UNIVERSE_UNREADABLE';

/** The canonical sections of `canon.md`, exactly as the narrative skill writes them. */
export const CANON_LAW_SECTION = '## Fundamental laws';
export const CANON_SECTIONS = [
  CANON_LAW_SECTION,
  '## World',
  '## Recurring characters',
  '## Timeline',
  '## Stable facts',
  '## Mysteries with a fixed cause',
];

/** The state containers of `threads.json` and their vocabulary. */
export const THREAD_COLLECTIONS = ['open', 'closed', 'promises', 'deferred_answers'];
export const THREAD_KINDS = ['promise', 'mystery', 'decision', 'question'];
export const THREAD_STATUSES = ['open', 'deferred', 'closed', 'abandoned'];

/** The published atlas axes and node states; an import never invents an axis. */
export const ATLAS_AXIS_IDS = [
  'mind-identity',
  'life-death',
  'time-causality',
  'ai-autonomy',
  'civilization-power',
  'abundance-scarcity',
  'alien-alterity',
  'reality-simulation',
  'body-evolution',
  'knowledge-truth',
  'cosmos-scale',
  'culture-meaning',
];
export const ATLAS_STATES = ['mentioned', 'dramatized', 'decision', 'recontextualized'];

/** Chapter file names: four digits, a slug of lowercase letters, digits and hyphens. */
export const CHAPTER_FILE = /^(\d{4})-([a-z0-9-]+)\.md$/;
export const THREAD_ID = /^[a-z]{2,8}-\d{4}$/;
export const LANGUAGE_CODE = /^[a-z]{2}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The languages of the fiction the product accepts. The list is copied from `src/config.mjs` because
 * a portable skill may not import the server; that file stays the canonical source.
 */
export const SUPPORTED_LANGUAGES = [
  'ro',
  'en',
  'fr',
  'de',
  'es',
  'it',
  'pt',
  'nl',
  'sv',
  'pl',
  'cs',
  'hu',
  'bg',
  'el',
  'uk',
  'ru',
  'tr',
  'ja',
  'zh',
];

/** Labels used when the extraction gives a chapter no title; `en` is the fallback, as in an edition. */
export const CHAPTER_LABEL = { ro: 'Capitolul', en: 'Chapter' };
