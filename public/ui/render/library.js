/**
 * scriptaWorlds — The Library tab: the list on the left, everything the book says on the right.
 *
 * A click only puts the template's request into the field below and shows its indications;
 * nothing is created here.
 */
import { loadLibrary, loadLibraryEntry } from '../api.js';
import { setComposerError } from './composer.js';
import { writeComposerText } from './ingredients.js';
import { el, elem, state } from '../state.js';

export async function renderLibraryTab() {
  const list = el('library-list');
  if (!list) return;
  if (!state.library) {
    list.replaceChildren(elem('li', { className: 'unirow__meta', text: 'Loading the library…' }));
    try {
      await loadLibrary();
    } catch (error) {
      list.replaceChildren(elem('li', { className: 'unirow__meta', text: `The library could not be loaded: ${error.message}` }));
      return;
    }
  }
  renderLibraryList();
  renderLibraryDetail();
}

export function renderLibraryList() {
  const list = el('library-list');
  const templates = state.library ?? [];
  if (!list) return;
  if (!templates.length) {
    list.replaceChildren(elem('li', { className: 'unirow__meta', text: 'The library is empty.' }));
    return;
  }
  list.replaceChildren(...templates.map((template) => elem('li', { className: 'librow-wrap' },
    elem('button', {
      className: `librow${state.libraryPick?.slug === template.slug ? ' librow--on' : ''}${state.libraryEntry?.slug === template.slug ? ' librow--shown' : ''}`,
      attrs: { type: 'button', title: template.title ?? '' },
      on: { click: () => chooseTemplate(template) }
    },
    elem('span', { className: 'librow__head' },
      elem('span', { className: 'librow__title', text: template.title ?? template.slug }),
      template.sector ? elem('span', { className: 'librow__sector', text: template.sector }) : null
    ),
    template.genealogy?.length
      ? elem('span', { className: 'librow__genealogy', text: template.genealogy.join(' · ') })
      : null,
    elem('span', { className: 'librow__summary', text: template.summary ?? '' }),
    (template.cells ?? []).length
      ? elem('span', { className: 'librow__cells', text: template.cells.map((cell) => cell.symbol).join(' ') })
      : null
    )
  )));
}

// The right half: the exact request, then every indication the book gives, then the source text.
export function renderLibraryDetail() {
  const detail = el('library-detail');
  if (!detail) return;
  const entry = state.libraryEntry;
  if (!entry) {
    detail.replaceChildren(elem('p', { className: 'libdetail__hint', text: 'Open a template to read its request and the indications behind it.' }));
    return;
  }
  const applied = state.libraryPick?.slug === entry.slug;
  detail.replaceChildren(
    elem('div', { className: 'libdetail__head' },
      elem('h2', { className: 'libdetail__title', text: entry.title ?? entry.slug }),
      elem('button', {
        className: `btn btn--accent libdetail__use${applied ? ' libdetail__use--on' : ''}`,
        text: applied ? 'In use' : 'Use',
        attrs: { type: 'button', id: 'library-use', disabled: applied },
        on: { click: () => useTemplate(entry.slug) }
      })
    ),
    elem('section', { className: 'libdetail__block' },
      elem('h3', { className: 'libdetail__label', text: 'Request sent to ALA' }),
      elem('pre', { className: 'libdetail__request', text: entry.request ?? '' })
    ),
    elem('section', { className: 'libdetail__block' },
      elem('h3', { className: 'libdetail__label', text: 'From the table of ideas' }),
      elem('dl', { className: 'libdetail__indications' }, (entry.indications ?? []).flatMap((item) => [
        elem('dt', { className: 'libdetail__indication-label', text: item.label ?? '' }),
        elem('dd', { className: 'libdetail__indication-text', text: item.ingredient ?? item.text ?? '' })
      ]))
    ),
    (entry.sourceText ?? '').trim()
      ? elem('details', { className: 'libdetail__source' },
        elem('summary', { text: 'From the book' }),
        elem('pre', { className: 'libdetail__sourcetext', text: entry.sourceText })
      )
      : null
  );
}

// A click only opens the template: the request text is applied with `Use`.
export async function chooseTemplate(template) {
  setComposerError(null);
  try {
    const entry = await loadLibraryEntry(template.slug);
    if (!entry?.request) {
      setComposerError('This template carries no request text.');
      return;
    }
    state.libraryEntry = entry;
    renderLibraryList();
    renderLibraryDetail();
  } catch (error) {
    setComposerError(error.message);
  }
}

// `Use`: the template is in charge of the field from now on (the row stays marked).
export function useTemplate(slug) {
  const entry = state.libraryEntry;
  if (!entry || (slug && entry.slug !== slug)) return;
  state.libraryPick = { slug: entry.slug, title: entry.title ?? entry.slug };
  state.ingredientError = null;
  setComposerError(null);
  renderLibraryList();
  renderLibraryDetail();
  writeComposerText();
}

export function bindLibrary() {
  // Every row carries its own handler.
}
