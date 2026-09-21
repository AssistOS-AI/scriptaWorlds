/**
 * scriptaWorlds — The Ingredients tab: the table of ideas as a 12 × 15 grid.
 *
 * Nothing is created here: every change recomposes the request text in the field below, from
 * the template (if one is chosen) plus the operations taken from the table.
 */
import { setComposerError } from './composer.js';
import { loadTable } from '../api.js';
import { openTableInfo, openTableCell } from './tableinfo.js';
import { el, elem, state } from '../state.js';

export const MAX_INGREDIENTS = 6;
export const LIMIT_MESSAGE = 'Six ingredients are the most a universe law can hold. Remove one first.';

export function bindIngredients(root) {
  const find = (id) => (root ?? document).querySelector(`#${id}`);
  find('ingredients-clear').addEventListener('click', () => {
    state.ingredients = [];
    state.ingredientError = null;
    setComposerError(null);
    afterChange();
  });
}

export async function renderIngredientsPanel() {
  if (!el('ingredients-panel')) return;
  if (!state.table) {
    const grid = el('ingredients-grid');
    if (grid) grid.textContent = 'Loading the table of ideas…';
    try {
      state.table = await loadTable();
    } catch (error) {
      if (grid) grid.textContent = `The table of ideas could not be loaded: ${error.message}`;
      return;
    }
  }
  renderIngredients();
}

/* ------------------------------------------------------------ the panel */

export function renderIngredients() {
  const table = state.table;
  if (!table) return;
  el('ingredients-count').textContent = `${state.ingredients.length} of ${MAX_INGREDIENTS} chosen`;
  renderChosen();
  renderNote();
  renderGrid(table);
}

function renderNote() {
  const note = el('ingredients-note');
  if (!note) return;
  note.hidden = !state.ingredientError;
  note.textContent = state.ingredientError ?? '';
}

// Each chosen operation is written with its prompt line, not just its symbol.
// The cell's own sentence from the book, never the two letter code: `Neutron Life: a universe
// where organisms live in degenerate matter (life and evolution, extension).`
export function ingredientLine(entry) {
  if (entry.ingredient) return entry.ingredient;
  if (entry.custom) {
    const parts = [entry.family, entry.operator].filter(Boolean).join(', ');
    return `${entry.name}${parts ? ` (${parts})` : ''}${entry.note ? `: ${entry.note}` : ''}`;
  }
  return `${entry.name}${entry.prompt ? `: ${entry.prompt}` : (entry.gist ? `: ${entry.gist}` : '')}`;
}

function renderChosen() {
  el('ingredients-chosen').replaceChildren(...state.ingredients.map((entry) => elem('li', { className: 'ing__chosen-row' },
    elem('span', { className: 'ing__chosen-text', text: ingredientLine(entry) }),
    elem('button', {
      className: 'ing__chip-remove',
      text: '\u00d7',
      attrs: { type: 'button', 'aria-label': `Remove ${entry.name}` },
      on: { click: () => removeIngredient(entry.key) }
    })
  )));
}

// The grid: one row per family, one column per operator, the symbol in every cell, and a small
// `i` beside each header and each row label.
function renderGrid(table) {
  const chosen = new Set(state.ingredients.filter((entry) => !entry.custom).map((entry) => entry.symbol));
  const bySymbol = new Map((table.elements ?? []).map((element) => [element.symbol, element]));
  const rows = [];

  rows.push(elem('div', { className: 'ing__head-row' },
    elem('span', { className: 'ing__corner' }),
    ...table.operators.map((operator) => elem('span', { className: 'ing__col-head', attrs: { title: operator.name } },
      elem('span', { className: 'ing__col-letter', text: operator.letter ?? '' }),
      elem('button', {
        className: 'ing__info',
        text: 'i',
        attrs: { type: 'button', 'aria-label': `About the operator ${operator.name}` },
        on: { click: () => openTableInfo('operator', operator.name) }
      }),
      elem('span', { className: 'ing__col-name', text: operator.name })
    ))
  ));

  for (const family of table.families) {
    const cells = family.cells ?? table.elements.filter((element) => element.family === family.name).map((element) => element.symbol);
    rows.push(elem('div', { className: 'ing__row' },
      elem('span', { className: 'ing__row-head' },
        elem('span', { className: 'ing__row-name', text: family.name }),
        elem('button', {
          className: 'ing__info',
          text: 'i',
          attrs: { type: 'button', 'aria-label': `About the family ${family.name}` },
          on: { click: () => openTableInfo('family', family.name) }
        })
      ),
      ...table.operators.map((operator, index) => {
        const symbol = cells[index] ?? cells.find((candidate) => candidate.endsWith(operator.letter ?? ''));
        const element = symbol ? bySymbol.get(symbol) : null;
        if (!element) return elem('span', { className: 'ing__cell ing__cell--empty' });
        const on = chosen.has(element.symbol);
        return elem('button', {
          className: `ing__cell${on ? ' ing__cell--on' : ''}`,
          text: element.symbol,
          attrs: {
            type: 'button',
            title: `${element.name} — ${element.gist ?? ''}`,
            'aria-pressed': on ? 'true' : 'false',
            'aria-label': `${element.symbol} ${element.name}`
          },
          on: { click: () => openTableCell(element.symbol) }
        });
      })
    ));
  }
  el('ingredients-grid').replaceChildren(...rows);
}

/* ------------------------------------------------------------ selection */

export function ingredientByKey(key) {
  return state.ingredients.find((entry) => entry.key === key) ?? null;
}

export function addIngredient(element) {
  if (ingredientByKey(element.symbol)) return;
  if (state.ingredients.length >= MAX_INGREDIENTS) {
    rejectSeventh();
    return;
  }
  state.ingredients.push({
    key: element.symbol,
    symbol: element.symbol,
    name: element.name,
    family: element.family,
    operator: element.operator,
    gist: element.gist ?? '',
    prompt: element.prompt ?? '',
    ingredient: element.ingredient ?? '',
    custom: false
  });
  state.ingredientError = null;
  afterChange();
}

function rejectSeventh() {
  state.ingredientError = LIMIT_MESSAGE;
  setComposerError(LIMIT_MESSAGE);
  renderNote();
}

export function removeIngredient(key) {
  state.ingredients = state.ingredients.filter((entry) => entry.key !== key);
  state.ingredientError = null;
  setComposerError(null);
  afterChange();
}

function afterChange() {
  renderIngredients();
  writeComposerText();
}

/* ------------------------------------------------------- the prompt text */

// The field holds the template request (if a template is chosen) plus the operations taken
// from the table, so the two tabs build one text together.
export function writeComposerText() {
  const input = el('input');
  const parts = [];
  const request = state.libraryEntry?.request ?? state.libraryPick?.request ?? '';
  if (request) parts.push(request);
  if (state.ingredients.length) {
    parts.push([
      'Operations added by me:',
      ...state.ingredients.map((entry) => `- ${ingredientLine(entry)}`)
    ].join('\n'));
  }
  input.value = parts.join('\n\n');
  if (parts.length) {
    setComposerError(null);
    input.focus();
  }
}

/* --------------------------------------------------------------- payload */

// What POST /api/universes expects: symbols for table cells, objects for proposed ones.
export function ingredientPayload() {
  return state.ingredients.map((entry) => (entry.custom
    ? {
      custom: true,
      name: entry.name,
      ...(entry.family ? { family: entry.family } : {}),
      ...(entry.operator ? { operator: entry.operator } : {}),
      ...(entry.note ? { note: entry.note } : {})
    }
    : entry.symbol));
}
