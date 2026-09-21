/**
 * TrueType parsing and subsetting: table directory, `cmap` (formats 0/4/12), `loca`/`glyf` glyph
 * access, composite glyph closure and a rebuilt single-family SFNT containing only the requested
 * glyphs (plus `.notdef`) with hinting instructions dropped. No dependencies beyond ./errors.mjs.
 */

import { readFileSync } from 'node:fs';

import { byteTag, concatBytes, i16, pad4, tableChecksum, u16 } from './errors.mjs';

const GLYF_HEADER_SIZE = 10;

export class TrueTypeFont {
  constructor(file) {
    this.file = file;
    this.buf = readFileSync(file);
    this.bytes = new Uint8Array(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.tables = new Map();
  }

  /** @returns {TrueTypeFont|null} null if the file is not a TTF with usable `glyf` outlines. */
  static open(file) {
    let font;
    try {
      font = new TrueTypeFont(file);
    } catch {
      return null;
    }
    return font.parse() ? font : null;
  }

  parse() {
    const { bytes, dv } = this;
    if (bytes.length < 12) return false;
    const version = dv.getUint32(0);
    // 0x00010000 = TrueType, 0x74727565 = 'true', 0x4F54544F = 'OTTO' (CFF, not accepted).
    if (version !== 0x00010000 && version !== 0x74727565) return false;
    const numTables = dv.getUint16(4);
    if (!numTables || numTables > 512) return false;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      if (rec + 16 > bytes.length) return false;
      this.tables.set(byteTag(bytes, rec), {
        offset: dv.getUint32(rec + 8),
        length: dv.getUint32(rec + 12),
      });
    }
    for (const required of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'loca', 'glyf']) {
      if (!this.tables.has(required)) return false;
    }
    const head = this.tables.get('head').offset;
    if (head + 54 > bytes.length) return false;
    this.unitsPerEm = dv.getUint16(head + 18);
    if (!this.unitsPerEm) return false;
    this.indexToLocFormat = dv.getInt16(head + 50);
    this.macStyle = dv.getUint16(head + 44);
    this.xMin = dv.getInt16(head + 36);
    this.yMin = dv.getInt16(head + 38);
    this.xMax = dv.getInt16(head + 40);
    this.yMax = dv.getInt16(head + 42);
    const hhea = this.tables.get('hhea').offset;
    this.ascender = dv.getInt16(hhea + 4);
    this.descender = dv.getInt16(hhea + 6);
    this.numHMetrics = dv.getUint16(hhea + 34);
    this.numGlyphs = dv.getUint16(this.tables.get('maxp').offset + 4);
    this.italicAngle = this.tables.has('post') ? dv.getInt32(this.tables.get('post').offset + 4) / 65536 : 0;
    if (!this.numGlyphs || !this.numHMetrics) return false;
    this.loca = this.readLoca();
    this.glyfLength = this.tables.get('glyf').length;
    this.glyfOffset = this.tables.get('glyf').offset;
    this.cmap = this.readCmap();
    if (!this.cmap.size) return false;
    this.ascentRatio = this.ascender / this.unitsPerEm;
    this.descentRatio = -this.descender / this.unitsPerEm;
    return true;
  }

  readLoca() {
    const { dv, numGlyphs, indexToLocFormat } = this;
    const off = this.tables.get('loca').offset;
    const out = new Uint32Array(numGlyphs + 1);
    for (let i = 0; i <= numGlyphs; i++) {
      out[i] = indexToLocFormat === 0 ? dv.getUint16(off + i * 2) * 2 : dv.getUint32(off + i * 4);
    }
    return out;
  }

  readCmap() {
    const { dv } = this;
    const base = this.tables.get('cmap').offset;
    const map = new Map();
    const numSubtables = dv.getUint16(base + 2);
    let best = null;
    for (let i = 0; i < numSubtables; i++) {
      const rec = base + 4 + i * 8;
      const platform = dv.getUint16(rec);
      const encoding = dv.getUint16(rec + 2);
      const off = base + dv.getUint32(rec + 4);
      const format = dv.getUint16(off);
      let score = 0;
      if (platform === 3 && encoding === 10) score = 5;
      else if (platform === 3 && encoding === 1) score = 4;
      else if (platform === 0) score = 3;
      else if (platform === 3 && encoding === 0) score = 2;
      else if (platform === 1 && encoding === 0) score = 1;
      if (score && (!best || score > best.score)) best = { score, off, format };
    }
    if (!best) return map;
    if (best.format === 4) this.readCmapFormat4(best.off, map);
    else if (best.format === 12) this.readCmapFormat12(best.off, map);
    else if (best.format === 0) this.readCmapFormat0(best.off, map);
    return map;
  }

  readCmapFormat0(off, map) {
    for (let c = 0; c < 256; c++) {
      const gid = this.bytes[off + 6 + c];
      if (gid) map.set(c, gid);
    }
  }

  readCmapFormat4(off, map) {
    const { dv } = this;
    const segCount = dv.getUint16(off + 6) / 2;
    const endBase = off + 14;
    const startBase = endBase + segCount * 2 + 2;
    const deltaBase = startBase + segCount * 2;
    const rangeBase = deltaBase + segCount * 2;
    for (let seg = 0; seg < segCount; seg++) {
      const end = dv.getUint16(endBase + seg * 2);
      const start = dv.getUint16(startBase + seg * 2);
      const delta = dv.getInt16(deltaBase + seg * 2);
      const rangeOffset = dv.getUint16(rangeBase + seg * 2);
      if (start === 0xffff) continue;
      for (let code = start; code <= end && code !== 0x10000; code++) {
        let gid;
        if (rangeOffset === 0) {
          gid = (code + delta) & 0xffff;
        } else {
          const gidOff = rangeBase + seg * 2 + rangeOffset + (code - start) * 2;
          if (gidOff + 2 > this.bytes.length) continue;
          gid = dv.getUint16(gidOff);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid) map.set(code, gid);
      }
    }
  }

  readCmapFormat12(off, map) {
    const { dv } = this;
    const groups = dv.getUint32(off + 12);
    for (let i = 0; i < groups; i++) {
      const rec = off + 16 + i * 12;
      const start = dv.getUint32(rec);
      const end = dv.getUint32(rec + 4);
      const gidStart = dv.getUint32(rec + 8);
      for (let code = start, gid = gidStart; code <= end; code++, gid++) map.set(code, gid);
    }
  }

  covers(codes) {
    for (const code of codes) if (!this.cmap.has(code)) return false;
    return true;
  }

  missing(codes) {
    const out = [];
    for (const code of codes) if (!this.cmap.has(code)) out.push(code);
    return out;
  }

  gidFor(code) {
    const gid = this.cmap.get(code);
    if (gid !== undefined) return gid;
    const fallback = this.cmap.get(0x3f);
    return fallback === undefined ? 0 : fallback;
  }

  advance(gid) {
    const { dv, numHMetrics } = this;
    const off = this.tables.get('hmtx').offset;
    const index = Math.min(gid, numHMetrics - 1);
    return dv.getUint16(off + index * 4);
  }

  /** Text width, in PDF points, at the given size. */
  width(text, size) {
    let total = 0;
    for (const ch of text) total += this.advance(this.gidFor(ch.codePointAt(0)));
    return (total * size) / this.unitsPerEm;
  }

  tableBytes(tag) {
    const entry = this.tables.get(tag);
    if (!entry) return null;
    return this.bytes.subarray(entry.offset, entry.offset + entry.length);
  }

  glyphData(gid) {
    const start = this.loca[gid];
    const end = Math.min(this.loca[gid + 1], this.glyfLength);
    if (end <= start) return this.bytes.subarray(0, 0);
    return this.bytes.subarray(this.glyfOffset + start, this.glyfOffset + end);
  }

  /** Component glyph indexes (composite TrueType); [] for simple glyphs. */
  components(gid) {
    const glyph = this.glyphData(gid);
    if (glyph.length < GLYF_HEADER_SIZE || i16(glyph, 0) >= 0) return [];
    const out = [];
    let pos = GLYF_HEADER_SIZE;
    for (;;) {
      if (pos + 4 > glyph.length) break;
      const flags = u16(glyph, pos);
      out.push(u16(glyph, pos + 2));
      let len = 4 + (flags & 0x0001 ? 4 : 2);
      if (flags & 0x0008) len += 2;
      else if (flags & 0x0040) len += 4;
      else if (flags & 0x0080) len += 8;
      pos += len;
      if (!(flags & 0x0020)) break;
    }
    return out;
  }

  /**
   * Prepares a glyph for the subset: rewrites the component indexes and drops the hinting
   * instructions (the subset keeps no `fpgm`/`prep`/`cvt `).
   */
  prepareGlyph(gid, newGid) {
    const glyph = this.glyphData(gid);
    if (glyph.length < GLYF_HEADER_SIZE) return new Uint8Array(0);
    const contours = i16(glyph, 0);
    if (contours >= 0) {
      const instrLenPos = GLYF_HEADER_SIZE + contours * 2;
      if (instrLenPos + 2 > glyph.length) return glyph.slice();
      const instrLen = u16(glyph, instrLenPos);
      if (instrLenPos + 2 + instrLen > glyph.length) return glyph.slice();
      const out = new Uint8Array(glyph.length - instrLen);
      out.set(glyph.subarray(0, instrLenPos), 0);
      out[instrLenPos] = 0;
      out[instrLenPos + 1] = 0;
      out.set(glyph.subarray(instrLenPos + 2 + instrLen), instrLenPos + 2);
      return out;
    }
    const out = glyph.slice();
    let pos = GLYF_HEADER_SIZE;
    let hasInstructions = false;
    for (;;) {
      if (pos + 4 > out.length) return out;
      const flags = u16(out, pos);
      const component = u16(out, pos + 2);
      const mapped = newGid.get(component);
      if (mapped !== undefined) {
        out[pos + 2] = (mapped >> 8) & 0xff;
        out[pos + 3] = mapped & 0xff;
      }
      let len = 4 + (flags & 0x0001 ? 4 : 2);
      if (flags & 0x0008) len += 2;
      else if (flags & 0x0040) len += 4;
      else if (flags & 0x0080) len += 8;
      pos += len;
      if (flags & 0x0100) hasInstructions = true;
      if (!(flags & 0x0020)) break;
    }
    if (!hasInstructions || pos + 2 > out.length) return out;
    const instrLen = u16(out, pos);
    if (pos + 2 + instrLen > out.length) return out;
    const trimmed = new Uint8Array(out.length - instrLen);
    trimmed.set(out.subarray(0, pos), 0);
    trimmed[pos] = 0;
    trimmed[pos + 1] = 0;
    trimmed.set(out.subarray(pos + 2 + instrLen), pos + 2);
    return trimmed;
  }

  /**
   * Builds a TrueType subset with the requested glyphs (closed over components) plus `.notdef`.
   * @returns {{data: Uint8Array, gidMap: Map<number, number>}}
   */
  subset(codes) {
    const keep = new Set([0]);
    for (const code of codes) {
      const gid = this.cmap.get(code);
      if (gid) keep.add(gid);
    }
    const queue = [...keep];
    while (queue.length) {
      const gid = queue.pop();
      for (const component of this.components(gid)) {
        if (!keep.has(component)) {
          keep.add(component);
          queue.push(component);
        }
      }
    }
    const order = [...keep].sort((a, b) => a - b);
    const gidMap = new Map(order.map((gid, index) => [gid, index]));
    const glyphs = order.map((gid) => pad4(this.prepareGlyph(gid, gidMap)));
    const locaOffsets = new Uint32Array(glyphs.length + 1);
    let offset = 0;
    for (let i = 0; i < glyphs.length; i++) {
      locaOffsets[i] = offset;
      offset += glyphs[i].length;
    }
    locaOffsets[glyphs.length] = offset;
    const glyf = concatBytes(glyphs);
    const loca = new Uint8Array(locaOffsets.length * 4);
    const locaView = new DataView(loca.buffer);
    for (let i = 0; i < locaOffsets.length; i++) locaView.setUint32(i * 4, locaOffsets[i]);
    const hmtx = new Uint8Array(order.length * 4);
    const hmtxView = new DataView(hmtx.buffer);
    for (let i = 0; i < order.length; i++) {
      const glyph = this.glyphData(order[i]);
      hmtxView.setUint16(i * 4, this.advance(order[i]));
      hmtxView.setInt16(i * 4 + 2, glyph.length >= GLYF_HEADER_SIZE ? i16(glyph, 2) : 0);
    }
    const head = this.tableBytes('head').slice(0, 54);
    head[8] = 0;
    head[9] = 0;
    head[10] = 0;
    head[11] = 0;
    head[50] = 0;
    head[51] = 1; // indexToLocFormat = long
    const hhea = this.tableBytes('hhea').slice();
    const hheaView = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength);
    hheaView.setUint16(34, order.length);
    const maxp = this.tableBytes('maxp').slice();
    new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).setUint16(4, order.length);
    const tables = [
      { tag: 'cmap', data: buildCmapTable(order, gidMap, this.cmap) },
      { tag: 'glyf', data: glyf },
      { tag: 'head', data: head },
      { tag: 'hhea', data: hhea },
      { tag: 'hmtx', data: hmtx },
      { tag: 'loca', data: loca },
      { tag: 'maxp', data: maxp },
      { tag: 'name', data: buildEmptyNameTable() },
      { tag: 'post', data: buildPostTable(this) },
    ];
    const os2 = this.tableBytes('OS/2');
    if (os2) tables.push({ tag: 'OS/2', data: os2.slice() });
    tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    return { data: assembleSfnt(tables), gidMap };
  }
}

function buildPostTable(font) {
  const out = new Uint8Array(32);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00030000); // version 3.0: no glyph names
  view.setInt32(4, Math.round(font.italicAngle * 65536));
  const original = font.tableBytes('post');
  if (original && original.length >= 12) {
    view.setInt16(8, i16(original, 8));
    view.setInt16(10, i16(original, 10));
    view.setUint32(12, (original[12] << 24) | (original[13] << 16) | (original[14] << 8) | original[15]);
  }
  return out;
}

function buildEmptyNameTable() {
  const out = new Uint8Array(6);
  new DataView(out.buffer).setUint16(4, 6); // format 0, count 0, storageOffset 6
  return out;
}

function buildCmapTable(order, gidMap, originalCmap) {
  const pairs = [];
  for (const code of [...originalCmap.keys()].sort((a, b) => a - b)) {
    if (code < 0x20 || code > 0xffff) continue;
    const newGid = gidMap.get(originalCmap.get(code));
    if (newGid === undefined) continue;
    pairs.push([code, newGid]);
  }
  const segments = [];
  for (const [code, gid] of pairs) {
    const last = segments[segments.length - 1];
    if (last && code === last.end + 1 && gid === last.lastGid + 1) {
      last.end = code;
      last.lastGid = gid;
    } else {
      segments.push({ start: code, end: code, startGid: gid, lastGid: gid });
    }
  }
  segments.push({ start: 0xffff, end: 0xffff, startGid: 0, lastGid: 0, reserved: true });
  const segCount = segments.length;
  const length = 16 + segCount * 8;
  const sub = new Uint8Array(length);
  const view = new DataView(sub.buffer);
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  view.setUint16(0, 4);
  view.setUint16(2, length);
  view.setUint16(4, 0);
  view.setUint16(6, segCount * 2);
  view.setUint16(8, searchRange);
  view.setUint16(10, entrySelector);
  view.setUint16(12, segCount * 2 - searchRange);
  const endBase = 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  const rangeBase = deltaBase + segCount * 2;
  segments.forEach((segment, index) => {
    view.setUint16(endBase + index * 2, segment.end);
    view.setUint16(startBase + index * 2, segment.start);
    view.setUint16(deltaBase + index * 2, (segment.startGid - segment.start + 0x10000) & 0xffff);
    view.setUint16(rangeBase + index * 2, 0);
  });
  const table = new Uint8Array(12 + length);
  const tableView = new DataView(table.buffer);
  tableView.setUint16(2, 1);
  tableView.setUint16(4, 3);
  tableView.setUint16(6, 1);
  tableView.setUint32(8, 12);
  table.set(sub, 12);
  return table;
}

function assembleSfnt(tables) {
  const count = tables.length;
  const headerSize = 12 + count * 16;
  let offset = headerSize;
  const entries = tables.map((table) => {
    const data = pad4(table.data);
    const entry = { tag: table.tag, data, offset, checksum: tableChecksum(data) };
    offset += data.length;
    return entry;
  });
  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, count);
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 16 * 2 ** entrySelector;
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, count * 16 - searchRange);
  entries.forEach((entry, index) => {
    const rec = 12 + index * 16;
    for (let i = 0; i < 4; i++) out[rec + i] = entry.tag.charCodeAt(i) & 0xff;
    view.setUint32(rec + 4, entry.checksum);
    view.setUint32(rec + 8, entry.offset);
    view.setUint32(rec + 12, entry.data.length);
    out.set(entry.data, entry.offset);
  });
  const head = entries.find((entry) => entry.tag === 'head');
  if (head) view.setUint32(head.offset + 8, (0xb1b0afba - tableChecksum(out)) >>> 0);
  return out;
}
