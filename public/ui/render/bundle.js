/**
 * scriptaWorlds — The assessment bundle as a readable report.
 *
 * `assessment.json` is the source of everything the report says: the metrics with their value kinds, the
 * literary indicators, the findings with their evidence, the passages worth preserving and the coverage
 * the review actually reached. This module renders that bundle and never re-derives a number: a metric
 * that is not `computed` or `judged` has no value, so its own missing reason is shown where the number
 * would be, and a zero is never invented in its place.
 */
import { elem } from '../state.js';

const AVAILABLE = new Set(['computed', 'judged']);

// The anchored rating scale of the annotation vocabulary (`annotations.v1`): 0 to 4.
const RATING_SCALE = 4;

export function fmtNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return String(Number(value.toFixed(3)));
}

export function statusWords(status) {
  return String(status ?? 'unknown').replace(/_/g, ' ');
}

export function bundleReport(bundle) {
  const root = elem('div', { className: 'bundle' });
  const evidence = new Map((bundle?.evidence ?? []).map((item) => [item.id, item]));
  root.append(scopeBlock(bundle));
  root.append(metricsSection(bundle?.metrics ?? {}, evidence));
  root.append(indicatorsSection(bundle?.indicators ?? {}, evidence));
  root.append(findingsSection(bundle?.findings ?? [], evidence));
  root.append(preservedSection(bundle?.preserved_qualities ?? {}, evidence));
  return root;
}

/* ------------------------------------------------------------- coverage */

function scopeBlock(bundle) {
  const coverage = bundle?.coverage ?? {};
  const scope = bundle?.scope ?? {};
  const rows = [
    ['Book', bundle?.book?.title ? `${bundle.book.title} (${bundle.book.language ?? '—'})` : '—'],
    ['Assessment', bundle?.assessment_id ?? '—'],
    ['Reviewed scope', scopeText(scope)],
    ['Packet scope', coverage.packet_scope ?? '—'],
    ['Omitted chapters', (coverage.omitted_chapters ?? []).length ? coverage.omitted_chapters.join(', ') : 'none declared'],
    [
      'Evidence coverage',
      coverage.evidence
        ? `${coverage.evidence.chapters_with_evidence ?? 0}/${coverage.evidence.selected_chapters ?? 0} selected chapters carry a verified evidence item`
        : '—'
    ],
    ['Tokenizer', coverage.tokenizer ? `${coverage.tokenizer.method ?? '—'} (${coverage.tokenizer.eligible_tokens ?? 0} eligible tokens)` : '—'],
    ['Continuity input', coverage.continuity?.reason ?? (coverage.continuity?.applicable ? 'applicable' : 'not applicable')]
  ];
  const list = elem('dl', { className: 'meta__list' });
  for (const [label, value] of rows) {
    list.append(elem('dt', { text: label }), elem('dd', { text: String(value) }));
  }
  const block = elem('section', { className: 'bundle__section' },
    elem('h4', { className: 'bundle__title', text: 'What this review covered' }),
    list
  );
  if (coverage.note) block.append(elem('p', { className: 'analysis__hint', text: String(coverage.note) }));
  return block;
}

export function scopeText(scope) {
  if (!scope) return '—';
  const parts = [`kind ${scope.kind ?? '—'}`];
  if (scope.chapters?.length) parts.push(`chapters ${scope.chapters.join(', ')}`);
  if (scope.segments?.length) parts.push(`segments ${scope.segments.join(', ')}`);
  return parts.join(' · ');
}

/**
 * The value of one component of a judged metric, or of one point of a trajectory. A component may be a
 * plain number, an anchored `rating` on the 0-4 scale the annotation vocabulary publishes, or a small
 * record of named numbers; an object is never printed as `[object Object]` in place of a measurement.
 */
export function componentValue(component) {
  if (typeof component === 'number') return fmtNumber(component) ?? '—';
  if (!component || typeof component !== 'object') return component == null ? '—' : String(component);
  if (typeof component.rating === 'number') return `${fmtNumber(component.rating)} / ${RATING_SCALE}`;
  const numbers = Object.entries(component).filter(([, value]) => typeof value === 'number');
  if (numbers.length) return numbers.map(([key, value]) => `${statusWords(key)} ${fmtNumber(value)}`).join(' · ');
  const text = component.value ?? component.label ?? null;
  return text == null ? '—' : String(text);
}

export function componentNote(component) {
  if (!component || typeof component !== 'object') return null;
  const text = component.rationale ?? component.note ?? component.description ?? component.uncertainty;
  return typeof text === 'string' && text.trim() ? text : null;
}

/* -------------------------------------------------------------- metrics */

function metricsSection(metrics, evidence) {
  const entries = Object.values(metrics);
  const section = elem('section', { className: 'bundle__section' },
    elem('h4', { className: 'bundle__title' },
      elem('span', { text: 'Metrics' }),
      elem('span', { className: 'analysis__count', text: `${entries.length}` })
    )
  );
  if (!entries.length) {
    section.append(elem('p', { className: 'analysis__hint', text: 'The bundle declares no metric.' }));
    return section;
  }
  for (const metric of entries) section.append(metricCard(metric, evidence));
  return section;
}

function metricCard(metric, evidence) {
  const card = elem('article', { className: 'metric' },
    elem('header', { className: 'metric__head' },
      elem('span', { className: 'metric__id', text: metric.id ?? '??' }),
      elem('span', { className: 'metric__name', text: metric.name ?? metric.id ?? 'metric' }),
      elem('span', { className: `badge badge--${metric.status ?? 'unknown'}`, text: statusWords(metric.status) }),
      metric.value_kind ? elem('span', { className: 'metric__kind', text: String(metric.value_kind) }) : null
    ),
    valueBlock(metric)
  );
  const facts = [`scope: ${scopeText(metric.scope)}`];
  if (metric.unit) facts.push(`unit: ${metric.unit}`);
  if (metric.direction) facts.push(`direction: ${statusWords(metric.direction)}`);
  card.append(elem('p', { className: 'metric__meta', text: facts.join(' · ') }));
  const detail = [];
  if (metric.purpose) detail.push(elem('p', {}, elem('strong', { text: 'Purpose. ' }), document.createTextNode(String(metric.purpose))));
  if (metric.method) detail.push(elem('p', {}, elem('strong', { text: 'Method. ' }), document.createTextNode(String(metric.method))));
  if (metric.limits) detail.push(elem('p', {}, elem('strong', { text: 'Limits. ' }), document.createTextNode(String(metric.limits))));
  if (metric.rationale) detail.push(elem('p', {}, elem('strong', { text: 'Rationale. ' }), document.createTextNode(String(metric.rationale))));
  const quotes = evidenceList(metric.evidence, evidence);
  if (quotes) detail.push(quotes);
  if (detail.length) {
    card.append(elem('details', { className: 'metric__detail' },
      elem('summary', { text: 'Method, limits and evidence' }),
      ...detail
    ));
  }
  return card;
}

/** The number, the components, the trajectory — or the recorded reason instead of any of them. */
function valueBlock(metric) {
  const wrap = elem('div', { className: 'metric__value' });
  if (!AVAILABLE.has(metric.status)) {
    const reason = metric.missing_reason ? ` — ${metric.missing_reason}` : '';
    wrap.append(elem('p', { className: 'metric__unavailable' },
      elem('span', { className: 'metric__unavailable-label', text: `${statusWords(metric.status)}${reason}` })
    ));
    return wrap;
  }
  if (metric.value_kind === 'components') {
    const components = metric.components ?? {};
    const names = Object.keys(components);
    const list = elem('ul', { className: 'metric__components' });
    for (const name of names) {
      const component = components[name];
      const note = componentNote(component);
      list.append(elem('li', { className: 'metric__component' },
        elem('div', { className: 'metric__component-head' },
          elem('span', { className: 'metric__component-name', text: name }),
          elem('span', { className: 'metric__component-value', text: componentValue(component) })
        ),
        note ? elem('p', { className: 'metric__component-note', text: note }) : null
      ));
    }
    wrap.append(names.length
      ? list
      : elem('p', { className: 'metric__unavailable', text: 'no component was judged' }));
    if (typeof metric.value === 'number') {
      wrap.append(elem('p', { className: 'metric__scalar' },
        elem('span', { className: 'metric__number', text: fmtNumber(metric.value) }),
        elem('span', { className: 'metric__unit', text: ` ${metric.unit ?? ''}`.trimEnd() })
      ));
    } else if (metric.missing_reason) {
      // Judged without a combined scalar: the components stand and the report says why no single number
      // was produced, instead of leaving the reader to guess.
      wrap.append(elem('p', { className: 'metric__unavailable', text: metric.missing_reason }));
    }
    return wrap;
  }
  if (metric.value_kind === 'trajectory') {
    const points = Array.isArray(metric.trajectory) ? metric.trajectory : [];
    const list = elem('ol', { className: 'metric__trajectory' });
    for (const point of points) {
      const note = componentNote(point);
      list.append(elem('li', { className: 'metric__component' },
        elem('span', { className: 'metric__component-value', text: componentValue(point) }),
        note ? elem('span', { className: 'metric__component-note', text: note }) : null
      ));
    }
    wrap.append(points.length ? list : elem('p', { className: 'metric__unavailable', text: 'no ordered segment was judged' }));
    return wrap;
  }
  wrap.append(elem('p', { className: 'metric__scalar' },
    elem('span', { className: 'metric__number', text: fmtNumber(metric.value) ?? '—' }),
    elem('span', { className: 'metric__unit', text: ` ${metric.unit ?? ''}`.trimEnd() })
  ));
  return wrap;
}

/* ----------------------------------------------------------- indicators */

function indicatorsSection(indicators, evidence) {
  const entries = Object.values(indicators);
  const section = elem('section', { className: 'bundle__section' },
    elem('h4', { className: 'bundle__title' },
      elem('span', { text: 'Literary indicators' }),
      elem('span', { className: 'analysis__count', text: `${entries.length}` })
    )
  );
  if (!entries.length) {
    section.append(elem('p', { className: 'analysis__hint', text: 'The bundle declares no indicator.' }));
    return section;
  }
  for (const indicator of entries) {
    const card = elem('article', { className: 'metric' },
      elem('header', { className: 'metric__head' },
        elem('span', { className: 'metric__name', text: statusWords(indicator.id) }),
        elem('span', { className: `badge badge--${indicator.status ?? 'unknown'}`, text: statusWords(indicator.status) }),
        indicator.category ? elem('span', { className: 'metric__kind', text: String(indicator.category) }) : null
      )
    );
    if (!AVAILABLE.has(indicator.status) && indicator.missing_reason) {
      card.append(elem('p', { className: 'metric__unavailable', text: `${statusWords(indicator.status)} — ${indicator.missing_reason}` }));
    }
    if (indicator.rationale) card.append(elem('p', {}, elem('strong', { text: 'Rationale. ' }), document.createTextNode(String(indicator.rationale))));
    if (indicator.counterevidence) card.append(elem('p', {}, elem('strong', { text: 'Counterevidence. ' }), document.createTextNode(String(indicator.counterevidence))));
    if (indicator.intended_effect_fit) card.append(elem('p', {}, elem('strong', { text: 'Intended effect. ' }), document.createTextNode(String(indicator.intended_effect_fit))));
    if (indicator.evaluator) card.append(elem('p', { className: 'metric__meta', text: `evaluator: ${indicator.evaluator}` }));
    const quotes = evidenceList(indicator.evidence, evidence);
    if (quotes) card.append(quotes);
    section.append(card);
  }
  return section;
}

/* ------------------------------------------------------------- findings */

function findingsSection(findings, evidence) {
  const section = elem('section', { className: 'bundle__section' },
    elem('h4', { className: 'bundle__title' },
      elem('span', { text: 'Findings' }),
      elem('span', { className: 'analysis__count', text: `${findings.length}` })
    )
  );
  if (!findings.length) {
    section.append(elem('p', { className: 'analysis__hint', text: 'The review recorded no finding.' }));
    return section;
  }
  for (const finding of findings) {
    const card = elem('article', { className: 'finding' },
      elem('header', { className: 'metric__head' },
        elem('span', { className: 'metric__id', text: finding.id }),
        elem('span', { className: 'metric__name', text: statusWords(finding.kind) }),
        elem('span', { className: `badge badge--severity-${finding.severity}`, text: `${finding.severity} severity` }),
        elem('span', { className: `badge badge--certainty-${finding.certainty}`, text: `${finding.certainty} certainty` }),
        elem('span', { className: `badge badge--${finding.status}`, text: statusWords(finding.status) })
      ),
      elem('p', { className: 'finding__description', text: finding.description })
    );
    if (finding.temporal) {
      card.append(elem('p', { className: 'metric__meta' },
        elem('span', { text: 'baseline: ' }),
        elem('span', { text: (finding.temporal.baseline ?? []).join(', ') || '—' }),
        elem('span', { text: ' · later: ' }),
        elem('span', { text: (finding.temporal.later ?? []).join(', ') || '—' })
      ));
    }
    const quotes = evidenceList(finding.evidence, evidence);
    if (quotes) card.append(quotes);
    if (finding.alternative_explanation) {
      card.append(elem('p', {}, elem('strong', { text: 'Alternative explanation. ' }), document.createTextNode(String(finding.alternative_explanation))));
    }
    if (finding.repair_suggestion) {
      card.append(elem('p', {}, elem('strong', { text: 'Suggested repair. ' }), document.createTextNode(String(finding.repair_suggestion))));
    }
    section.append(card);
  }
  return section;
}

/* ---------------------------------------------------- preserved passages */

function preservedSection(preserved, evidence) {
  const passages = Array.isArray(preserved.passages) ? preserved.passages : [];
  const section = elem('section', { className: 'bundle__section' },
    elem('h4', { className: 'bundle__title' },
      elem('span', { text: 'Worth preserving' }),
      elem('span', { className: 'analysis__count', text: `${passages.length}` })
    )
  );
  if (!passages.length) {
    section.append(elem('p', { className: 'analysis__hint', text: preserved.reason ?? 'Nothing was marked as worth preserving.' }));
    return section;
  }
  for (const passage of passages) {
    const card = elem('article', { className: 'preserved' },
      elem('header', { className: 'metric__head' }, elem('span', { className: 'metric__id', text: passage.id }))
    );
    if (passage.rationale) card.append(elem('p', { className: 'metric__meta', text: passage.rationale }));
    const quotes = evidenceList(passage.evidence, evidence);
    if (quotes) card.append(quotes);
    section.append(card);
  }
  return section;
}

/* ------------------------------------------------------------- evidence */

/**
 * The frozen passages an item rests on. Each quotation is the recorded text of the packet the review
 * read, with its file and byte range, so a report from an earlier version can never be mistaken for a
 * reading of the current prose.
 */
export function evidenceList(ids, evidence) {
  const wanted = Array.isArray(ids) ? ids : [];
  if (!wanted.length) return null;
  const list = elem('div', { className: 'quotes' });
  for (const id of wanted) {
    const item = evidence.get(id);
    if (!item) {
      list.append(elem('p', { className: 'quote__missing', text: `evidence ${id} is not in the bundle` }));
      continue;
    }
    list.append(elem('blockquote', { className: 'quote' },
      elem('p', { className: 'quote__text', text: item.quote ?? '' }),
      elem('footer', { className: 'quote__caption', text: `${item.file} [${item.start},${item.end}) · ${String(item.sha256 ?? '').slice(0, 12)}…` })
    ));
  }
  return list;
}

/* --------------------------------------------------------- generic JSON */

/** A readable rendering of any other published JSON: nested lists, no interpretation. */
export function jsonView(value, depth = 0) {
  if (Array.isArray(value)) {
    if (!value.length) return elem('p', { className: 'analysis__hint', text: 'empty list' });
    return elem('ol', { className: 'json__list' }, ...value.map((entry) => elem('li', {}, jsonView(entry, depth + 1))));
  }
  if (value && typeof value === 'object') {
    const list = elem('dl', { className: 'meta__list' });
    for (const [key, entry] of Object.entries(value)) {
      list.append(elem('dt', { text: key }), elem('dd', {}, jsonView(entry, depth + 1)));
    }
    return list;
  }
  if (value === null || value === undefined) return elem('span', { className: 'json__null', text: '—' });
  if (typeof value === 'boolean') return elem('span', { className: 'json__flag', text: value ? 'true' : 'false' });
  if (typeof value === 'number') return elem('span', { className: 'json__number', text: String(value) });
  return elem('span', { className: 'json__text', text: String(value) });
}
