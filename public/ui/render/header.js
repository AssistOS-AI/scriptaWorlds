/**
 * scriptaWorlds — The sticky header and the new-chapter notice.
 */
import { navigate } from '../slides.js';
import { LANGUAGE_KEY, dom, elem, short, state } from '../state.js';

export function renderHeader() {
  const universe = state.universe;
  // A short title in the header, the full sentence as a discreet line underneath.
  dom['uni-title'].textContent = universe ? short(universe.title, 34) : 'scriptaWorlds';
  const summary = dom['uni-summary'];
  // The line under the title describes the universe (the template description or the sentence ALA
  // moved there when it renamed the book); the opening the reader picked is the fallback.
  const line = String(universe?.summary || universe?.premise || '').replace(/\s+/g, ' ').trim();
  summary.hidden = !line;
  summary.textContent = line;
  summary.title = line;
  document.title = universe ? `${universe.title} — scriptaWorlds` : 'scriptaWorlds';
  dom['btn-universes'].disabled = false;
  // The `Edition` dialog stays reachable without a universe: it is the way back to `New universe`.
  dom['btn-more'].disabled = false;
}

/* ------------------------------------------------------------- language */

// The language of the next universe: a discreet select in the header, remembered locally.
export function renderLanguageSelect() {
  const select = dom.lang;
  const languages = state.config.languages ?? [];
  if (!languages.length) return;
  if (select.options.length !== languages.length) {
    select.replaceChildren(...languages.map((entry) => elem('option', { attrs: { value: entry.code }, text: entry.code })));
  }
  let stored = null;
  try {
    stored = localStorage.getItem(LANGUAGE_KEY);
  } catch { /* unavailable */ }
  const chosen = languages.some((entry) => entry.code === stored) ? stored : (state.language ?? languages[0].code);
  select.value = chosen;
  state.language = chosen;
}

export function bindLanguage() {
  dom.lang.addEventListener('change', () => {
    state.language = dom.lang.value;
    try {
      localStorage.setItem(LANGUAGE_KEY, state.language);
    } catch { /* unavailable */ }
  });
}

/* ------------------------------------------------- chapter nav (between the arrows) */

// Every slice that belongs to the book gets a number between ‹ and ›: chapters that exist,
// and the part ALA is writing right now (marked live, so a new request shows up immediately).

export function renderNotice() {
  const notice = state.notice;
  dom.notice.hidden = !notice;
  if (!notice) return;
  dom.notice.textContent = 'New chapter ready — read it';
  dom.notice.onclick = () => navigate(notice.index);
}

/* ------------------------------------------------------- footer (ALA) */
