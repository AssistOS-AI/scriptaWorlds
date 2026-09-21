/**
 * scriptaWorlds — What stands behind the table: operators, families and single cells.
 *
 * One dialog serves all three: the operator and the family describe the grid, the cell shows
 * the book's own text and offers `Add to my world`.
 */
import { loadTableCell } from '../api.js';
import { closePopup, renderPopups } from '../overlays.js';
import { chooseTemplate } from './library.js';
import { renderNewScreen } from './explore.js';
import { addIngredient, ingredientByKey, ingredientLine } from './ingredients.js';
import { el, elem, state } from '../state.js';

export function openTableInfo(kind, name) {
  state.tableInfo = { kind, name, cell: null };
  openDialog();
  if (kind !== 'cell') renderTableDialog();
}

export async function openTableCell(symbol) {
  const element = (state.table?.elements ?? []).find((entry) => entry.symbol === symbol);
  // The click only opens the page: inserting is the popup's own button.
  state.tableInfo = { kind: 'cell', name: symbol, cell: element ?? null };
  openDialog();
  renderTableDialog();
  try {
    const cell = await loadTableCell(symbol);
    if (state.tableInfo?.name === symbol) {
      state.tableInfo.cell = cell;
      renderTableDialog();
    }
  } catch (error) {
    const body = el('tabledialog-body');
    if (body) body.replaceChildren(elem('p', { className: 'ing__error', text: `This cell could not be loaded: ${error.message}` }));
  }
}

function openDialog() {
  state.popup = 'tabledialog';
  renderPopups();
}

export function renderTableDialog() {
  const info = state.tableInfo;
  const body = el('tabledialog-body');
  const add = el('tabledialog-add');
  const table = state.table;
  if (!info || !body) return;
  const isCell = info.kind === 'cell';
  add.hidden = !isCell;
  add.disabled = false;
  add.textContent = 'Insert in my new world';

  if (info.kind === 'operator') {
    const operator = (table?.operators ?? []).find((entry) => entry.name === info.name);
    const users = (table?.elements ?? []).filter((element) => element.operator === info.name).slice(0, 8);
    el('tabledialog-title').textContent = `${operator?.letter ? `${operator.letter} · ` : ''}${info.name}`;
    body.replaceChildren(
      elem('p', { className: 'td__does', text: operator?.does ?? '' }),
      elem('h3', { className: 'td__label', text: `${users.length} cells work this way (first shown)` }),
      elem('ul', { className: 'td__list' }, users.map((element) => elem('li', { className: 'td__row' },
        elem('span', { className: 'td__symbol', text: element.symbol }),
        elem('span', { className: 'td__name', text: element.name }),
        elem('span', { className: 'td__gist', text: element.gist ?? '' })
      )))
    );
    return;
  }

  if (info.kind === 'family') {
    const family = (table?.families ?? []).find((entry) => entry.name === info.name);
    const cells = (table?.elements ?? []).filter((element) => element.family === info.name);
    el('tabledialog-title').textContent = family?.label ?? info.name;
    body.replaceChildren(
      elem('p', { className: 'td__does', text: `Family ${family?.name ?? info.name} · ${cells.length} cells` }),
      elem('ul', { className: 'td__list' }, cells.map((element) => elem('li', { className: 'td__row' },
        elem('span', { className: 'td__symbol', text: element.symbol }),
        elem('span', { className: 'td__name', text: element.name }),
        elem('span', { className: 'td__gist', text: element.gist ?? '' })
      )))
    );
    return;
  }

  // a single cell: the idea, what this kind of change does to a world, where it is seen, and
  // the nights of the course that already use it.
  el('tabledialog-title').textContent = info.name;
  const cell = info.cell;
  if (!cell) {
    body.replaceChildren(elem('p', { className: 'td__does', text: 'Loading the page of the table…' }));
    return;
  }
  const already = Boolean(ingredientByKey(cell.symbol));
  add.disabled = already;
  add.textContent = already ? 'In your world' : 'Insert in my new world';
  const scenes = cell.scenes ?? [];
  body.replaceChildren(
    elem('p', { className: 'td__cell-name', text: cell.name }),
    elem('p', { className: 'td__cell-where', text: `${cell.familyLabel ?? cell.family} · ${cell.operator} — ${cell.operatorDoes ?? ''}` }),
    elem('section', { className: 'td__section' },
      elem('h3', { className: 'td__label', text: 'The idea' }),
      elem('p', { className: 'td__prompt', text: cell.essence ?? cell.prompt ?? cell.gist ?? '' }),
      cell.prompt && cell.prompt !== cell.essence ? elem('p', { className: 'td__text', text: cell.prompt }) : null
    ),
    cell.familyNote ? elem('section', { className: 'td__section' },
      elem('h3', { className: 'td__label', text: `What ${cell.familyLabel ?? cell.family} changes` }),
      elem('p', { className: 'td__text', text: cell.familyNote })
    ) : null,
    cell.seenIn ? elem('p', { className: 'td__landmark', text: `Seen in: ${cell.seenIn}` }) : null,
    scenes.length ? elem('section', { className: 'td__section' },
      elem('h3', { className: 'td__label', text: scenes.length === 1 ? 'A night of the course uses it' : `${scenes.length} nights of the course use it` }),
      ...scenes.map((scene) => elem('article', { className: 'td__scene' },
        elem('h4', { className: 'td__scene-title', text: scene.title ?? scene.slug }),
        scene.sector ? elem('p', { className: 'td__scene-sector', text: scene.sector }) : null,
        scene.situation ? elem('p', { className: 'td__text', text: scene.situation }) : null,
        scene.story ? elem('p', { className: 'td__text', text: scene.story }) : null,
        elem('button', {
          className: 'btn btn--quiet td__scene-open',
          text: 'Open this template',
          attrs: { type: 'button' },
          on: { click: () => openSceneTemplate(scene.slug) }
        })
      ))
    ) : null,
    already ? elem('p', { className: 'td__note', text: ingredientLine(ingredientByKey(cell.symbol)) }) : null
  );
}

// The small button under a scene: it opens that night in the Library tab.
async function openSceneTemplate(slug) {
  closePopup();
  state.newTab = 'library';
  await renderNewScreen();
  await chooseTemplate({ slug, title: slug });
}

export function bindTableInfo() {
  el('tabledialog-close').addEventListener('click', closePopup);
  el('tabledialog-add').addEventListener('click', () => {
    const info = state.tableInfo;
    if (info?.kind !== 'cell' || !info.cell) return;
    addIngredient(info.cell);
    renderTableDialog();
  });
}
