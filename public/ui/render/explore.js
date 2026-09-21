/**
 * scriptaWorlds — The New screen: two tabs, one field.
 *
 * Library holds the worlds from the book; Ingredients holds the table of ideas. Neither
 * creates anything: they only put a request in the field below, where the reader edits it.
 */
import { closePopup } from '../overlays.js';
import { bindIngredients, renderIngredientsPanel } from './ingredients.js';
import { bindTableInfo } from './tableinfo.js';
import { renderLibraryTab } from './library.js';
import { dom, elem, languageLabel, plural, short, state } from '../state.js';
import { selectUniverse } from '../universe.js';

const NOTE = 'A template is a world that already has rules and a problem under way: open one and its '
  + 'text lands in the field below, where you can change anything before you press Send — or build '
  + 'your own world from the table of ideas under Ingredients.';

export function welcomePanel() {
  const panel = elem('div', { className: 'welcome' });
  panel.append(elem('p', { className: 'welcome__note' },
    elem('span', { className: 'welcome__info', text: '\u24d8', attrs: { 'aria-hidden': 'true' } }),
    elem('span', { text: NOTE })
  ));
  panel.append(tabBar());
  const body = elem('div', { className: 'newbody' });
  const ingredients = ingredientsPanel();
  body.append(libraryPanel());
  body.append(ingredients);
  panel.append(body);
  // The tab controls live only as long as this panel does: bind them in their own subtree.
  bindIngredients(ingredients);
  return panel;
}

function tabBar() {
  const tabs = elem('div', { className: 'newtabs', attrs: { id: 'newtabs', role: 'tablist' } });
  for (const [key, label] of [['library', 'Library'], ['ingredients', 'Ingredients']]) {
    tabs.append(elem('button', {
      className: 'newtab',
      text: label,
      attrs: {
        type: 'button',
        role: 'tab',
        'data-tab': key,
        'aria-selected': state.newTab === key ? 'true' : 'false'
      },
      on: { click: () => openTab(key) }
    }));
  }
  return tabs;
}

function libraryPanel() {
  return elem('section', { className: 'newpanel', attrs: { 'data-panel': 'library', id: 'library-panel' } },
    elem('div', { className: 'libsplit' },
      elem('ul', { className: 'liblist', attrs: { id: 'library-list' } }),
      elem('div', { className: 'libdetail', attrs: { id: 'library-detail' } })
    )
  );
}

function ingredientsPanel() {
  return elem('section', { className: 'newpanel', attrs: { 'data-panel': 'ingredients', id: 'ingredients-panel' } },
    elem('div', { className: 'ing__head' },
      elem('span', { className: 'ing__count', attrs: { id: 'ingredients-count' }, text: '0 of 6 chosen' }),
      elem('button', {
        className: 'btn btn--quiet',
        text: 'Clear',
        attrs: { type: 'button', id: 'ingredients-clear' }
      })
    ),
    elem('div', { className: 'ing__scroll' }, elem('div', { className: 'ing__table', attrs: { id: 'ingredients-grid' } })),
    elem('ul', { className: 'ing__chosen', attrs: { id: 'ingredients-chosen' } }),
    elem('p', { className: 'ing__error', attrs: { id: 'ingredients-note', hidden: true } })
  );
}

// `ingredients-panel` is the section the table renders into.
export function openTab(name) {
  state.newTab = name;
  renderTabs();
  if (name === 'library') renderLibraryTab();
  else renderIngredientsPanel();
}

function renderTabs() {
  const tabs = document.getElementById('newtabs');
  if (!tabs) return;
  for (const tab of tabs.children) {
    tab.setAttribute('aria-selected', tab.dataset.tab === state.newTab ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll('.newpanel')) {
    panel.hidden = panel.dataset.panel !== state.newTab;
  }
}

export async function renderNewScreen() {
  renderTabs();
  if (state.newTab === 'library') await renderLibraryTab();
  else await renderIngredientsPanel();
}

/* ------------------------------------------------- universes (the dialog) */

export function universeRow(universe) {
  const meta = [languageLabel(universe.language), plural(universe.chapterCount ?? 0, 'chapter', 'chapters')]
    .filter(Boolean)
    .join(' · ');
  return elem('li', { className: `unirow${universe.id === state.universeId ? ' unirow--current' : ''}` },
    elem('button', {
      className: 'unirow__main',
      attrs: { type: 'button', 'aria-current': universe.id === state.universeId ? 'true' : 'false' },
      on: {
        click: () => {
          closePopup();
          selectUniverse(universe.id);
        }
      }
    },
    elem('span', { className: 'unirow__title', text: short(universe.title, 44) }),
    elem('span', { className: 'unirow__meta', text: meta })
    )
  );
}

export function renderUniverseList() {
  const open = state.universes.filter((universe) => universe.status !== 'closed');
  const closed = state.universes.filter((universe) => universe.status === 'closed');
  const rows = [];
  if (open.length) rows.push(...open.map(universeRow));
  if (closed.length) {
    rows.push(elem('li', { className: 'unilist__group', text: 'Closed' }));
    rows.push(...closed.map(universeRow));
  }
  if (!rows.length) rows.push(elem('li', { className: 'unilist__empty', text: 'No universes on disk yet.' }));
  dom['universe-list'].replaceChildren(...rows);
}
