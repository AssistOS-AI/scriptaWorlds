/**
 * scriptaWorlds — Shared state, DOM handles and small helpers.
 */

export const UNIVERSE_KEY = 'scriptaWorlds.currentUniverse';

export const LANGUAGE_KEY = 'scriptaWorlds.language';

export const chapterKey = (id) => `scriptaWorlds.currentChapter.${id}`;

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
