/**
 * scriptaWorlds — Shared state, DOM handles and small helpers.
 */

export const UNIVERSE_KEY = 'scriptaWorlds.currentUniverse';

export const LANGUAGE_KEY = 'scriptaWorlds.language';

export const chapterKey = (id) => `scriptaWorlds.currentChapter.${id}`;

// One reader identity per book: the identifier the server issued for this person (`docs/contracts.md`
// §8.7), remembered so the same reader is not asked for their name twice in a book.
export const readerKey = (id) => `scriptaWorlds.reader.${id}`;

// Used only when GET /api/config is unreachable (contract §4.1).

export const FALLBACK_LANGUAGES = [
  { code: 'ro', label: 'Română' },
  { code: 'en', label: 'English' }
];

export const PREMISE_EXAMPLES = [
  'A colony that hears from its own future and cannot agree on what it is told.',
  'An empire that reads only books written by civilisations that vanished.',
  'A city where memories are taxed and forgetting becomes a currency.',
  'A library whose newest volumes are written by readers who are still alive.'
];

export const LIVE_STATUSES = new Set(['queued', 'running']);

export const FAILED_STATUSES = new Set(['error', 'interrupted']);

// A review run of `GET /api/universes/:id/assessments` has its own lifecycle: it is queued, running and
// then settled as done, error, cancelled or interrupted (§8.5 of docs/contracts.md).
export const RUN_LIVE_STATUSES = new Set(['queued', 'running']);

export const RUN_FAILED_STATUSES = new Set(['error', 'interrupted', 'cancelled']);

// A review is a phase of the separate design and review pass, and its observations come from the
// configured evaluator, from nobody at all, or from a document the caller brought.
export const REVIEW_PHASES = [
  { value: 'metrics', label: 'Metrics', hint: 'Twelve measures, eight indicators and the five reports.' },
  { value: 'continuity', label: 'Continuity', hint: 'Integrity and contradiction checks over the frozen state.' }
];

export const REVIEW_MODES = [
  { value: 'generic', label: 'Generic — the host asks the configured evaluator', hint: 'The ordinary review: no profile and no annotations to author.' },
  { value: 'deterministic', label: 'Deterministic — no model call', hint: 'Only what can be measured without judgements; the rest reports why it is unavailable.' }
];

// How often a run this client started is checked while it is queued or running. The check stops as
// soon as the run settles, so an open panel never polls once there is nothing to watch.
export const RUN_POLL_MS = 2000;

export const DISCUSSION_LIMIT = 60_000;

export const EXPORT_REQUEST = 'Produce the printed edition of the book so far, with preface and afterword.';

export const ALA_INVITATION = 'I am ALA. You bring a request, I write the next chapter, and the universe keeps '
  + 'whatever we agree on. Nothing here is a form — tell me what you want to happen, or pick one of these first lines.';

export const state = {
  config: { languages: FALLBACK_LANGUAGES, formats: ['docx', 'pdf', 'both'], degraded: false },
  universes: [],
  universeId: null,
  universe: null,
  detail: null,
  chapters: new Map(),
  turns: new Map(),
  ideas: new Map(),
  live: new Map(),
  requests: new Map(),
  watched: new Set(),
  table: null,
  ingredients: [],
  ingredientError: null,
  ingredientQuery: '',
  library: null,
  libraryPick: null,
  libraryEntry: null,
  tableInfo: null,
  newTab: 'custom',
  customSpec: '',
  customError: null,
  language: null,
  composerError: null,
  slides: [],
  index: 0,
  errors: [],
  expanded: new Set(),
  notice: null,
  band: null,
  requestChapter: null,
  rewrite: null,
  rewriteChapters: new Map(),
  importRecord: null,
  importProgress: null,
  importBusy: false,
  importError: null,
  runs: [],
  arcEvents: [],
  runsLoaded: false,
  review: null,
  report: null,
  feedback: null,
  responses: [],
  feedbackTargets: [],
  feedbackCounts: null,
  feedbackLoaded: false,
  readers: [],
  readersLoaded: false,
  selection: null,
  liveNodes: new Map(),
  events: null,
  ideasPending: false
};

export const dom = {};

// Live lookup: elements created after boot (the New screen) are not in `dom`.
export const el = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ DOM */

export function elem(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = String(options.text);
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    if (value === false || value == null) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [key, value] of Object.entries(options.props ?? {})) node[key] = value;
  for (const [key, handler] of Object.entries(options.on ?? {})) node.addEventListener(key, handler);
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

export const ROOT_IDS = [
  'app', 'topbar', 'uni-title', 'uni-summary', 'btn-universes', 'btn-more', 'lang',
  'nav-prev', 'nav-next', 'nav-title', 'nav-count', 'chapnav',
  'universes', 'universes-close', 'universe-list',
  'more', 'menu-close', 'menu-items',
  'requests', 'requests-hide', 'request-title', 'request-list',
  'rewrite', 'rewrite-title', 'rewrite-hide', 'rewrite-instructions', 'rewrite-error', 'rewrite-submit', 'rewrite-cancel',
  'review', 'review-title', 'review-close', 'review-body',
  'report', 'report-title', 'report-close', 'report-body',
  'feedback', 'feedback-title', 'feedback-close', 'feedback-body',
  'newtabs', 'library-panel', 'library-list', 'library-detail',
  'ingredients-panel', 'ingredients-count', 'ingredients-grid', 'ingredients-chosen', 'ingredients-clear', 'ingredients-note',
  'tabledialog', 'tabledialog-title', 'tabledialog-body', 'tabledialog-close', 'tabledialog-add',
  'thread', 'track', 'footer', 'notice', 'ala', 'ala-voice', 'ala-offer', 'composer-error', 'input', 'send'
];

export function bindDom() {
  for (const id of ROOT_IDS) dom[id] = document.getElementById(id);
}

/* ------------------------------------------------------------ formatare */

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function languageLabel(code) {
  const found = state.config.languages.find((entry) => entry.code === code);
  if (found) return found.label;
  return code ? code.toUpperCase() : '';
}

export function short(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/* ------------------------------------------------------------------ API */
