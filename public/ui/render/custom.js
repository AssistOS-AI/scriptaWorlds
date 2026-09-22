/**
 * scriptaWorlds — The Custom tab: one large field for the world you have in mind.
 *
 * The text written here is the specification of a new universe: what exists, what is impossible,
 * who is in it and what is already wrong. `Start` creates that universe from the text and asks for
 * its first chapter, so a reader who arrives with an idea needs no template and no ingredient.
 */
import { startFromSpec } from '../actions.js';
import { elem, state } from '../state.js';

const PLACEHOLDER = 'Write the world: what exists in it, what cannot be done, who lives there, what is '
  + 'already wrong. This text becomes the law of the new universe.';

const LEAD = 'One field for a world of your own. Write the rules and the situation you have in mind, '
  + 'then press Start: the text becomes the fundamental law of the new universe and its first chapter begins.';

export function customPanel() {
  const field = elem('textarea', {
    className: 'custom__field',
    attrs: { id: 'custom-spec', rows: 12, placeholder: PLACEHOLDER, 'aria-label': 'Specification of the new universe' },
    props: { value: state.customSpec ?? '' },
    on: {
      input: (event) => {
        state.customSpec = event.currentTarget.value;
        if (state.customError) {
          state.customError = null;
          renderCustomError();
        }
      }
    }
  });
  return elem('section', { className: 'newpanel', attrs: { 'data-panel': 'custom', id: 'custom-panel' } },
    elem('p', { className: 'custom__lead', text: LEAD }),
    field,
    elem('div', { className: 'custom__actions' },
      elem('button', {
        className: 'btn btn--accent',
        text: 'Start',
        attrs: { type: 'button', id: 'custom-start' },
        on: { click: (event) => startFromSpec(event.currentTarget) }
      }),
      elem('span', { className: 'custom__hint', text: 'The universe is created only when you press Start.' })
    ),
    elem('p', { className: 'custom__error', attrs: { id: 'custom-error', hidden: true } })
  );
}

/** The one line under the field: what the server refused, or what is missing before Start. */
export function renderCustomError() {
  const line = document.getElementById('custom-error');
  if (!line) return;
  line.textContent = state.customError ?? '';
  line.hidden = !state.customError;
}
