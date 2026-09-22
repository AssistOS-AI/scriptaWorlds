/**
 * Font families for the book: discovery under `--fonts` or the system font roots, family
 * ranking, the `BookFace` wrapper (used-character tracking, subset tag, Identity-H codes) and
 * `resolveFonts`, which accepts a family only when every face the layout renders with covers the
 * characters rendered with it (the regular face must also cover the essential Latin baseline),
 * and otherwise fails with `MISSING_FONT` naming the family, the face and the missing characters.
 */

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { fail } from './errors.mjs';
import { TrueTypeFont } from './truetype.mjs';

const RO_PAIRS = {
  0x0103: 0x0102, 0x00e2: 0x00c2, 0x00ee: 0x00ce, 0x0219: 0x0218, 0x021b: 0x021a,
};

export function essentialCodes() {
  const codes = new Set();
  for (let c = 0x20; c <= 0x7e; c++) codes.add(c);
  codes.add(0x00a0);
  codes.add(0x00b7);
  codes.add(0x2013);
  codes.add(0x2014);
  codes.add(0x2018);
  codes.add(0x2019);
  codes.add(0x201c);
  codes.add(0x201d);
  codes.add(0x201e);
  codes.add(0x2026);
  for (const [lower, upper] of Object.entries(RO_PAIRS)) {
    codes.add(Number(lower));
    codes.add(upper);
  }
  return codes;
}

function classifyFontFile(file) {
  const raw = basename(file).replace(/\.(ttf|otf|ttc)$/i, '').replace(/\[[^\]]*\]/g, '');
  const lower = raw.toLowerCase();
  let style = 'regular';
  if ((/bold/.test(lower) && /italic|oblique/.test(lower))) style = 'bolditalic';
  else if (/bold/.test(lower)) style = 'bold';
  else if (/italic|oblique/.test(lower)) style = 'italic';
  const family = lower
    .replace(/[\s_-]*(bolditalic|boldoblique|italic|oblique|bold|regular|normal|roman|medium|light|semibold|black|thin|extralight|extrabold|ultra|book)\b/g, '')
    .replace(/[^a-z0-9]+/g, '');
  if (!family) return null;
  return { family, style };
}

function listFontFiles(dir, depth) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) out.push(...listFontFiles(full, depth - 1));
    } else if (/\.(ttf|ttc|otf)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function fontSearchRoots(overrideDir) {
  if (overrideDir) return [{ label: overrideDir, files: listFontFiles(overrideDir, 3) }];
  const roots = [];
  const push = (label, files) => {
    if (files.length) roots.push({ label, files });
  };
  push('/usr/share/fonts/liberation-serif-fonts', listFontFiles('/usr/share/fonts/liberation-serif-fonts', 0));
  push(
    '/usr/share/fonts/truetype/liberation*',
    listFontFiles('/usr/share/fonts/truetype', 1).filter((file) => /liberation/i.test(file)),
  );
  push(
    '/usr/share/fonts/google-noto-vf/NotoSerif*',
    listFontFiles('/usr/share/fonts/google-noto-vf', 0).filter((file) => /notoserif/i.test(file)),
  );
  push('/usr/share/fonts/**', listFontFiles('/usr/share/fonts', 3));
  return roots;
}

export class BookFace {
  constructor(font, styleLabel, psName) {
    this.font = font;
    this.style = styleLabel;
    this.psName = psName;
    this.codes = new Set([0x20]);
    this.subsetData = null;
    this.gidMap = null;
    this.gidOrder = null;
    this.tag = null;
    this.pdfName = null;
  }

  get ascentRatio() {
    return this.font.ascentRatio;
  }

  get descentRatio() {
    return this.font.descentRatio;
  }

  width(text, size) {
    return this.font.width(text, size);
  }

  note(text) {
    for (const ch of String(text)) this.codes.add(ch.codePointAt(0));
  }

  finish() {
    const { data, gidMap } = this.font.subset(this.codes);
    this.subsetData = Buffer.from(data);
    this.gidMap = gidMap;
    this.gidOrder = [...gidMap.entries()].sort((a, b) => a[1] - b[1]).map(([oldGid]) => oldGid);
    const digest = createHash('md5').update(this.subsetData).digest('hex').slice(0, 6);
    this.tag = [...digest].map((digit) => 'ABCDEFGHIJKLMNOP'[parseInt(digit, 16)]).join('');
  }

  subsetTag() {
    return this.tag;
  }

  subsetGlyphCount() {
    return this.gidOrder.length;
  }

  /** Width (em units) of the glyph in the subset, indexed by the new GID. */
  advanceOf(newGid) {
    return this.font.advance(this.gidOrder[newGid]);
  }

  /** Identity-H codes (2 bytes = GID in the subset) for the given text. */
  hex(text) {
    let hex = '';
    for (const ch of String(text)) {
      const oldGid = this.font.gidFor(ch.codePointAt(0));
      const newGid = this.gidMap.get(oldGid) || 0;
      hex += newGid.toString(16).padStart(4, '0');
    }
    return hex.toUpperCase();
  }
}

function rankFamilies(files) {
  const families = new Map();
  for (const file of files) {
    const info = classifyFontFile(file);
    if (!info) continue;
    let family = families.get(info.family);
    if (!family) {
      family = { key: info.family, faces: {} };
      families.set(info.family, family);
    }
    if (family.faces[info.style]) continue;
    const font = TrueTypeFont.open(file);
    if (!font) continue;
    family.faces[info.style] = { file, font };
  }
  const list = [...families.values()].filter((family) => Object.keys(family.faces).length);
  list.sort((a, b) => {
    const rank = (family) => (/serif/.test(family.key) ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.key < b.key ? -1 : 1;
  });
  return list;
}

/**
 * The four faces of one family. A style that has no file of its own uses the regular face (then the
 * bold face, then the italic one) — the documented fallback — and that substitution is acceptable
 * only if the substituted face covers the characters that style renders, which `coverageProblem`
 * proves before the family is accepted.
 */
function makeFaceSet(family) {
  const pick = (style) =>
    family.faces[style] || family.faces.regular || family.faces.bold || family.faces.italic || null;
  const faces = {};
  for (const style of ['regular', 'bold', 'italic', 'bolditalic']) {
    const chosen = pick(style);
    if (!chosen) return null;
    const psBase = basename(chosen.file).replace(/\.(ttf|ttc|otf)$/i, '').replace(/[^A-Za-z0-9-]/g, '');
    faces[style] = new BookFace(chosen.font, style, psBase || 'Serif');
  }
  return { family: family.key, files: Object.fromEntries(Object.entries(family.faces).map(([k, v]) => [k, v.file])), faces };
}

/**
 * Characters a candidate family cannot render, per face the layout actually used: every used face
 * must cover the characters rendered with it, and the regular face must additionally cover the
 * essential baseline (printable Latin, the Romanian diacritics and the typographic punctuation the
 * labels, the page numbers and the table of contents are built from).
 * @returns {null|{family: string, problems: Array<{face: object, missing: number[]}>}}
 */
function coverageProblem(set, used, essential) {
  const problems = [];
  for (const face of used) {
    const missing = face.font.missing(face.codes);
    if (missing.length) problems.push({ face, missing });
  }
  const regular = set.faces.regular.font;
  if (!problems.length && !regular.covers(essential)) {
    problems.push({ face: set.faces.regular, missing: regular.missing(essential) });
  }
  return problems.length ? { family: set.family, problems } : null;
}

function describeProblem(problem) {
  const parts = problem.problems.map(({ face, missing }) => {
    const listed = missing.slice(0, 8).map((code) => {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      return `${JSON.stringify(String.fromCodePoint(code))} (U+${hex})`;
    });
    if (missing.length > listed.length) listed.push(`and ${missing.length - listed.length} more`);
    return `${problem.family} ${face.style} face (${face.psName}) has no glyph for ${listed.join(' ')}`;
  });
  return parts.join('; ');
}

function missingFontMessage(problems, overrideDir) {
  const where = overrideDir
    ? `the --fonts folder ${overrideDir}`
    : '/usr/share/fonts (Liberation Serif, Liberation, Noto Serif, then any serif family)';
  const detail = problems.length
    ? describeProblem(problems[0])
    : 'no serif TrueType font with usable glyf outlines was found there';
  return (
    `No font family covers every character of this edition. Searched in ${where}: ${detail}. ` +
    'Install a serif TrueType family (for example liberation-serif-fonts) or pass --fonts <folder> ' +
    'with .ttf files whose regular, bold, italic and bold-italic faces cover the text.'
  );
}

/**
 * Picks the serif font family that can render the whole edition.
 *
 * `probe(faces)` lays the book out with a candidate family and returns the faces actually used
 * (`usedFaces` in layout.mjs), each of them carrying the characters rendered with it. A family is
 * accepted only when every one of those faces covers its own characters; a style without its own
 * file uses the regular face, which is allowed only when the regular face covers the characters
 * that style renders. No partial family is ever accepted, and an incomplete edition is never
 * produced: the search either finds a covering family or fails with `MISSING_FONT`.
 *
 * Order: `--fonts`, then Liberation Serif, then any Liberation, then Noto Serif, then the system.
 */
export function resolveFonts(overrideDir, probe) {
  const essential = essentialCodes();
  const problems = [];
  for (const root of fontSearchRoots(overrideDir)) {
    for (const family of rankFamilies(root.files)) {
      const set = makeFaceSet(family);
      if (!set) continue;
      const problem = coverageProblem(set, probe(set.faces), essential);
      if (!problem) return set;
      problems.push(problem);
    }
  }
  fail(missingFontMessage(problems, overrideDir), 'MISSING_FONT');
  return null;
}
