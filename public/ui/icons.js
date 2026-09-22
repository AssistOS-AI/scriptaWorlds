/**
 * scriptaWorlds — the pictograms of the interface.
 *
 * Every control draws its own inline SVG: there is no icon font, no image file and no CDN. A drawing
 * never carries a name of its own — the button that holds it does — so the picture is hidden from
 * assistive technology and announced once, through the control's label. `iconButton` builds the two
 * together so a control without an accessible name cannot be introduced by accident.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * One icon is a list of primitives drawn with the same stroke: `{ path: 'd' }`,
 * `{ circle: [cx, cy, r] }` or `{ rect: [x, y, width, height, rx] }`.
 */
export const ICONS = {
  // What the reader asked for: the request behind the chapter.
  info: [
    { circle: [12, 12, 8.6] },
    { path: 'M12 11.3v5.2' },
    { path: 'M12 7.8h.01' }
  ],
  // Rewrite: a pencil over the chapter.
  rewrite: [
    { path: 'M4.2 19.9h4.1l10.9-10.9a1.9 1.9 0 0 0 0-2.7l-1.3-1.3a1.9 1.9 0 0 0-2.7 0L4.2 15.9z' },
    { path: 'M13.3 6.7l4.1 4.1' }
  ],
  // Console: what ALA did while it wrote.
  console: [
    { rect: [3.6, 5.2, 16.8, 13.6, 2.4] },
    { path: 'M7.4 10.1l2.7 2.1-2.7 2.1' },
    { path: 'M12.6 14.3h4' }
  ],
  // Review: a checklist the team runs over the frozen version.
  review: [
    { path: 'M9.1 4.7H8.3a2.8 2.8 0 0 0-2.8 2.8v10.3a2.8 2.8 0 0 0 2.8 2.8h7.4a2.8 2.8 0 0 0 2.8-2.8V7.5a2.8 2.8 0 0 0-2.8-2.8h-.8' },
    { rect: [9, 3.3, 6, 2.6, 1.1] },
    { path: 'M9.2 13.4l2.2 2.2 4-4' }
  ],
  // Report: the measurements and the five views a run published.
  report: [
    { path: 'M4.4 4.3v15.4h15.3' },
    { path: 'M8.7 16.4v-4.3' },
    { path: 'M12.7 16.4v-7.4' },
    { path: 'M16.7 16.4v-2.6' }
  ],
  // Reader feedback: a speech bubble with two lines — what a reader says about the book.
  feedback: [
    { path: 'M4.4 4.9h15.2a1.6 1.6 0 0 1 1.6 1.6v7.2a1.6 1.6 0 0 1-1.6 1.6h-8.6l-4.7 3.4v-3.4H4.4a1.6 1.6 0 0 1-1.6-1.6V6.5a1.6 1.6 0 0 1 1.6-1.6z' },
    { path: 'M7.6 8.7h6.4' },
    { path: 'M7.6 11.7h9' }
  ]
};

/**
 * The drawing of one icon, sized for a control and hidden from assistive technology. Unknown names
 * draw nothing rather than an empty box, so a typo is visible in review instead of silent in the page.
 */
export function icon(name, { size = 18 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const shape of ICONS[name] ?? []) {
    if (shape.path) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', shape.path);
      svg.append(path);
    } else if (shape.circle) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      const [cx, cy, r] = shape.circle;
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r));
      svg.append(circle);
    } else if (shape.rect) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      const [x, y, width, height, rx] = shape.rect;
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(width));
      rect.setAttribute('height', String(height));
      if (rx) rect.setAttribute('rx', String(rx));
      svg.append(rect);
    }
  }
  return svg;
}

/**
 * A button whose visible content is one icon. `label` is the accessible name and the tooltip, so the
 * two can never drift apart; `attrs` carries the state a control has to expose (`aria-expanded`, …).
 */
export function iconButton({ name, label, title = null, className = 'iconbtn', attrs = {}, on = {}, size = 18 }) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.setAttribute('aria-label', label);
  node.title = title ?? label;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const [event, handler] of Object.entries(on)) node.addEventListener(event, handler);
  node.append(icon(name, { size }));
  return node;
}
