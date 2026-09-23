/**
 * scriptaWorlds — Bootstrap: bind the DOM, wire events, start the reader.
 */
import { sendFromInput } from './ui/actions.js';
import { loadConfig, loadUniverses } from './ui/api.js';
import { showError } from './ui/errors.js';
import { rememberSelection } from './ui/feedback.js';
import { PANELS, POPUPS, closeOverlays, closePanel, closePopup, openPopup, rewriteTarget, sendRewrite } from './ui/overlays.js';
import { autosize, bindInputResize } from './ui/render/composer.js';
import { renderUniverseList } from './ui/render/explore.js';
import { bindLanguage, renderHeader, renderLanguageSelect } from './ui/render/header.js';
import { bindTableInfo } from './ui/render/tableinfo.js';
import { renderMenuItems } from './ui/render/menu.js';
import { render } from './ui/render/reader.js';
import { applyTransform, navigate } from './ui/slides.js';
import { selectUniverse } from './ui/universe.js';
import { closeSessions } from './ui/sessions.js';
import { UNIVERSE_KEY, bindDom, dom, state } from './ui/state.js';

export function bindEvents() {
  bindLanguage();
  bindInputResize();
  bindTableInfo();
  // A passage a reader selects in the book is remembered as it is selected, so the feedback surface can
  // quote it: the dialog covers the reading area, so the selection cannot be made while it is open.
  document.addEventListener('selectionchange', rememberSelection);
  dom['btn-universes'].addEventListener('click', () => openPopup('universes'));
  dom['btn-more'].addEventListener('click', () => openPopup('more'));
  dom['universes-close'].addEventListener('click', closePopup);
  dom['menu-close'].addEventListener('click', closePopup);
  // The ⋯ menu closes on Esc, on × , and on any click outside it.
  document.addEventListener('click', (event) => {
    if (state.popup !== 'more') return;
    const target = event.target;
    if (target instanceof Node && (dom.more.contains(target) || dom['btn-more'].contains(target))) return;
    closePopup();
  });
  // The two modals close when the backdrop itself is clicked.
  for (const name of POPUPS) {
    dom[name].addEventListener('click', (event) => {
      if (event.target === dom[name]) closePopup();
    });
  }
  for (const name of PANELS) {
    dom[name].addEventListener('click', (event) => {
      if (event.target === dom[name]) closePanel();
    });
  }
  dom['requests-hide'].addEventListener('click', closePanel);
  dom['sessions-close'].addEventListener('click', closeSessions);
  dom['rewrite-hide'].addEventListener('click', closePanel);
  dom['review-close'].addEventListener('click', closePanel);
  dom['report-close'].addEventListener('click', closePanel);
  dom['feedback-close'].addEventListener('click', closePanel);
  dom['rewrite-cancel'].addEventListener('click', closePanel);
  dom['rewrite-submit'].addEventListener('click', () => sendRewrite({ dropLater: rewriteTarget()?.later != null }));
  dom['nav-prev'].addEventListener('click', () => navigate(state.index - 1));
  dom['nav-next'].addEventListener('click', () => navigate(state.index + 1));

  dom.ala.addEventListener('submit', (event) => {
    event.preventDefault();
    sendFromInput();
  });

  dom.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    dom.ala.requestSubmit();
  });
  dom.input.addEventListener('input', autosize);

  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement
      && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (event.key === 'Escape') {
      closeOverlays();
      return;
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      navigate(state.index - 1);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      navigate(state.index + 1);
    }
  });

  bindSwipe();
  window.addEventListener('resize', () => applyTransform());
}

export function bindSwipe() {
  const thread = dom.thread;
  let drag = null;
  thread.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) {
      drag = null;
      return;
    }
    drag = { x: event.touches[0].clientX, y: event.touches[0].clientY, dx: 0, axis: null };
  }, { passive: true });

  thread.addEventListener('touchmove', (event) => {
    if (!drag || event.touches.length !== 1) return;
    const dx = event.touches[0].clientX - drag.x;
    const dy = event.touches[0].clientY - drag.y;
    if (!drag.axis) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (drag.axis !== 'x') return;
    drag.dx = dx;
    dom.track.classList.add('track--dragging');
    dom.track.style.transform = `translateX(calc(${-state.index * 100}% + ${dx}px))`;
  }, { passive: true });

  const settle = () => {
    if (!drag) return;
    const dx = drag.dx;
    const threshold = Math.min(90, Math.max(44, thread.clientWidth * 0.14));
    drag = null;
    dom.track.classList.remove('track--dragging');
    if (dx <= -threshold) navigate(state.index + 1);
    else if (dx >= threshold) navigate(state.index - 1);
    else applyTransform();
  };

  thread.addEventListener('touchend', settle, { passive: true });
  thread.addEventListener('touchcancel', settle, { passive: true });
}

/* --------------------------------------------------------------- boot */

export async function boot() {
  bindDom();
  bindEvents();
  renderHeader();
  dom.input.placeholder = 'Pick a universe or start a new one…';
  try {
    await loadConfig();
    await loadUniverses();
  } catch (error) {
    showError(error.message);
    render();
    return;
  }
  renderUniverseList();
  renderMenuItems();
  renderLanguageSelect();
  let linked = null;
  let stored = null;
  try {
    const url = new URL(window.location.href);
    linked = url.searchParams.get('universe');
    stored = localStorage.getItem(UNIVERSE_KEY);
  } catch { /* unavailable */ }
  const target = state.universes.find((universe) => universe.id === linked)
    ?? state.universes.find((universe) => universe.id === stored)
    ?? null;
  if (!target) {
    render();
    return;
  }
  await selectUniverse(target.id, { initial: !linked });
  autosize();
}

boot().catch((error) => {
  showError(`The reader did not start: ${error?.message ?? error}`);
});
