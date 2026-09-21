/**
 * Font families for the book: discovery under `--fonts` or the system font roots, family
 * ranking, the `BookFace` wrapper (used-character tracking, subset tag, Identity-H codes) and
 * `resolveFonts`, which picks the first serif family whose regular face covers the book
 * characters (falling back to Latin + Romanian diacritics, else `MISSING_FONT`).
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
    this.missingChars = new Set();
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
    const missing = this.font.missing(this.codes);
    for (const code of missing) this.missingChars.add(String.fromCodePoint(code));
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
 * Picks the serif font family that covers all requested characters.
 * Order: `--fonts`, then Liberation Serif, then any Liberation, then Noto Serif, then the system.
 */
export function resolveFonts(overrideDir, requiredCodes) {
  const essential = essentialCodes();
  let partial = null;
  for (const root of fontSearchRoots(overrideDir)) {
    for (const family of rankFamilies(root.files)) {
      const set = makeFaceSet(family);
      if (!set) continue;
      if (set.faces.regular.font.covers(requiredCodes)) return set;
      if (!partial && set.faces.regular.font.covers(essential)) partial = set;
    }
  }
  if (partial) return partial;
  fail(
    `No valid serif TrueType font with coverage for the book characters was found. ` +
      `Searched in ${overrideDir ? `the --fonts folder ${overrideDir}` : '/usr/share/fonts (Liberation Serif, Liberation, Noto Serif, then any serif)'}. ` +
      `Install liberation-serif-fonts or use --fonts <folder> with a serif .ttf font.`,
    'MISSING_FONT',
  );
  return null;
}
