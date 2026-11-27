// png-squeeze-01: a lossless PNG re-encoder that squeezes 1280x720 screenshots
// into as few bytes as possible. Every pixel decodes back exactly; the only
// freedom is the PNG form (colour type, palette order, per-row filter) and the
// zlib stream that carries it. The program screens many forms with zlib level 6
// and writes the winner with zlib level 9, trying both the default and the
// filtered deflate strategy. Fully deterministic: no clock, no randomness.
//
// Run: node main.ts with MAKEFUN_INPUT_DIR (default /input) holding one
// image.png per instance directory, and MAKEFUN_OUTPUT_DIR (default /output)
// receiving one image.png per instance directory.

import { deflateSync, inflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const READABLE_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/* ------------------------------------------------------------------ */
/* checksums                                                           */
/* ------------------------------------------------------------------ */

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ */
/* PNG writing                                                         */
/* ------------------------------------------------------------------ */

function chunkBytes(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdrData(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function assemblePng(width: number, height: number, colourType: number, plte: Uint8Array | null, trns: Uint8Array | null, idat: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [PNG_SIG, chunkBytes('IHDR', ihdrData(width, height, colourType))];
  if (plte !== null) parts.push(chunkBytes('PLTE', plte));
  if (trns !== null) parts.push(chunkBytes('tRNS', trns));
  parts.push(chunkBytes('IDAT', idat));
  parts.push(chunkBytes('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* PNG filters                                                         */
/* ------------------------------------------------------------------ */

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Writes row `cur` filtered by `type` into `out` (exactly cur.length bytes).
// `prev` is the row above, or null for the first row.
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (prev === null ? 0 : prev[i])) & 0xff;
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev === null ? 0 : prev[i];
      out[i] = (cur[i] - ((left + up) >> 1)) & 0xff;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = (cur[i] - paethPredictor(a, b, c)) & 0xff;
    }
  }
}

// Sum of the filtered row's bytes read as signed values: the PNG spec's
// minimum-sum heuristic cost.
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* PNG reading (decoder: the contest's accepted subset)                */
/* ------------------------------------------------------------------ */

interface DecodedImage {
  width: number;
  height: number;
  colourType: number;
  rgba: Uint8Array;
}

function decodePng(bytes: Uint8Array): DecodedImage {
  if (bytes.length < 8 || !PNG_SIG.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!READABLE_CHUNKS.has(type)) throw new Error('unreadable chunk ' + type);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(type + ' CRC mismatch');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header !== null) throw new Error('two IHDR');
      if (len !== 13) throw new Error('bad IHDR');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
      if (data[8] !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('unsupported IHDR fields');
      if (!(header.colourType in CHANNELS)) throw new Error('unsupported colour type');
    } else if (type === 'PLTE') {
      if (palette !== null || header === null || header.colourType !== 3 || idatParts.length > 0) throw new Error('bad PLTE');
      if (len === 0 || len % 3 !== 0 || len > 768) throw new Error('bad PLTE size');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null || header === null || idatParts.length > 0) throw new Error('bad tRNS');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null || len > palette.length / 3) throw new Error('bad palette tRNS');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) throw new Error('bad tRNS size');
      } else throw new Error('tRNS with colour type ' + ct);
      trns = data;
    } else if (type === 'IDAT') {
      if (header === null) throw new Error('IDAT before IHDR');
      if (header.colourType === 3 && palette === null) throw new Error('IDAT before PLTE');
      idatParts.push(data);
    } else {
      if (len !== 0) throw new Error('non-empty IEND');
      ended = true;
    }
  }
  if (!ended || header === null || idatParts.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to ' + raw.length + ', expected ' + expected);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('bad filter ' + ft + ' on row ' + y);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = (raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0)) & 0xff;
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = (raw[src + i] + (y > 0 ? samples[p + i] : 0)) & 0xff;
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = (raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1)) & 0xff;
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = (raw[src + i] + paethPredictor(a, b, c)) & 0xff;
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = (palette as Uint8Array).length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = (palette as Uint8Array)[e * 3];
      lut[e * 4 + 1] = (palette as Uint8Array)[e * 3 + 1];
      lut[e * 4 + 2] = (palette as Uint8Array)[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, colourType, rgba };
}

/* ------------------------------------------------------------------ */
/* image analysis                                                      */
/* ------------------------------------------------------------------ */

interface ColourInfo {
  word: number;
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: ColourInfo[] | null; // null when more than 256 distinct colours
}

// One pass over the pixels: opacity, greyness, and the colour histogram
// (capped at 256 entries; beyond that the palette form is off the table).
function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = words[i];
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(w, 1);
      } else counts.set(w, k + 1);
    }
  }
  let colours: ColourInfo[] | null = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      word,
      r: word & 0xff,
      g: (word >>> 8) & 0xff,
      b: (word >>> 16) & 0xff,
      a: (word >>> 24) & 0xff,
      count,
    }));
  }
  return { opaque, grey, colours };
}

// The one fully transparent colour the image may key by tRNS instead of an
// alpha channel: every non-opaque pixel is that exact colour at alpha 0, and
// no opaque pixel uses that colour. Null when there is no such colour.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// The image's samples in a channel colour type (0 grey, 2 RGB, 4 grey+alpha,
// 6 RGBA) pulled out of RGBA.
function samplesOf(rgba: Uint8Array, colourType: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const ch = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (colourType === 0) out[s] = rgba[d];
    else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

interface PaletteForm {
  plte: Uint8Array;
  trns: Uint8Array | null;
  indices: Uint8Array;
}

// Orders the palette: transparent entries first (so tRNS stays short), then
// either by use count or by luminance. Returns the PLTE/tRNS chunks and the
// per-pixel palette indices.
function paletteForm(rgba: Uint8Array, colours: ColourInfo[], byLuminance: boolean): PaletteForm {
  const lum = (c: ColourInfo): number => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (byLuminance) return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]) as number;
  return { plte, trns, indices };
}

/* ------------------------------------------------------------------ */
/* filter strategies                                                   */
/* ------------------------------------------------------------------ */

// All five filtered variants of every row, computed once and reused by every
// strategy below. variants[t][y] is row y filtered by t (no filter byte).
class RowFilters {
  variants: Uint8Array[];
  stride: number;
  height: number;

  constructor(samples: Uint8Array, width: number, height: number, bpp: number) {
    this.stride = width * bpp;
    this.height = height;
    this.variants = [];
    for (let t = 0; t < 5; t++) {
      const rows = new Uint8Array(height * this.stride);
      for (let y = 0; y < height; y++) {
        const cur = samples.subarray(y * this.stride, (y + 1) * this.stride);
        const prev = y === 0 ? null : samples.subarray((y - 1) * this.stride, y * this.stride);
        filterRow(t, cur, prev, bpp, rows.subarray(y * this.stride, (y + 1) * this.stride));
      }
      this.variants.push(rows);
    }
  }

  // Assembles the filtered image (filter byte + row bytes per row) for a
  // per-row filter choice given as an array of 720 types.
  assemble(choice: Uint8Array): Uint8Array {
    const raw = new Uint8Array(this.height * (this.stride + 1));
    for (let y = 0; y < this.height; y++) {
      const t = choice[y];
      const at = y * (this.stride + 1);
      raw[at] = t;
      raw.set(this.variants[t].subarray(y * this.stride, (y + 1) * this.stride), at + 1);
    }
    return raw;
  }
}

// How many distinct neighbouring byte pairs a row holds: the fewest-pairs
// heuristic's cost.
function pairsCost(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

type RowChoice = 'minsum' | 'pairs';

// A per-row filter choice for a whole image: each row its own by minimum
// sum, or by fewest distinct neighbouring byte pairs. Fixed types are just
// an array filled with that type.
function choiceArray(rows: RowFilters, kind: RowChoice): Uint8Array {
  const height = rows.height;
  const out = new Uint8Array(height);
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      const row = rows.variants[t].subarray(y * rows.stride, (y + 1) * rows.stride);
      const cost = kind === 'minsum' ? signedSum(row) : pairsCost(row, seen, ++stamp);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    out[y] = type;
  }
  return out;
}

// Brute force, row by row: each trial row is compressed at level 4 with the
// preceding 32 KiB of already-chosen filtered data as the dictionary, and the
// smallest trial wins the row. The dictionary is the data that will actually
// precede the row in the final stream.
function bruteRaw(rows: RowFilters): Uint8Array {
  const stride = rows.stride;
  const height = rows.height;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(stride + 1);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[0] = t;
      trial.set(rows.variants[t].subarray(y * stride, (y + 1) * stride), 1);
      const cost = deflateSync(trial, before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(rows.variants[type].subarray(y * stride, (y + 1) * stride), at + 1);
  }
  return raw;
}

// Block choice: rows are grouped in blocks of `blockRows` and every row of a
// block shares one filter, the one whose whole block compresses smallest at
// level 4 with the preceding 32 KiB as dictionary. Coarser than per-row
// brute force, but it follows the image's regions instead of its noise.
function blockRaw(rows: RowFilters, blockRows: number): Uint8Array {
  const stride = rows.stride;
  const height = rows.height;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = new Uint8Array(blockRows * (stride + 1));
  for (let y0 = 0; y0 < height; y0 += blockRows) {
    const count = Math.min(blockRows, height - y0);
    const before = raw.subarray(Math.max(0, y0 * (stride + 1) - 32768), y0 * (stride + 1));
    let bestType = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      for (let y = y0; y < y0 + count; y++) {
        const at = (y - y0) * (stride + 1);
        trial[at] = t;
        trial.set(rows.variants[t].subarray(y * stride, (y + 1) * stride), at + 1);
      }
      const block = trial.subarray(0, count * (stride + 1));
      const cost = deflateSync(block, before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        bestType = t;
      }
    }
    for (let y = y0; y < y0 + count; y++) {
      const at = y * (stride + 1);
      raw[at] = bestType;
      raw.set(rows.variants[bestType].subarray(y * stride, (y + 1) * stride), at + 1);
    }
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* screening and encoding                                              */
/* ------------------------------------------------------------------ */

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
}

interface Candidate {
  form: Form;
  data: Uint8Array; // filtered image data (filter byte + row bytes per row)
  screenBytes: number; // level-6 zlib size plus chunk overhead
}

// Bytes a form's PLTE and tRNS chunks add to the file.
function chunkOverhead(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// Total file bytes of a PNG holding `zlibLen` bytes of IDAT for this form.
function fileBytes(form: Form, zlibLen: number): number {
  return 57 + chunkOverhead(form) + zlibLen;
}

// Encodes one RGBA image as small as the search below can make it.
function encodeOne(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const info = analyse(rgba);
  const best: Candidate[] = [];
  const consider = (form: Form, data: Uint8Array): void => {
    // Screened cheaply at level 6; the ranking it gives matches the final
    // level-9 ranking on every practice image, and the top three all get
    // the level-9 treatment below, so a near miss at level 6 still wins.
    const z = deflateSync(data, { level: 6, memLevel: 8 });
    const bytes = fileBytes(form, z.length);
    if (best.length < 3 || bytes < best[best.length - 1].screenBytes) {
      best.push({ form, data, screenBytes: bytes });
      best.sort((x, y) => x.screenBytes - y.screenBytes);
      if (best.length > 3) best.length = 3;
    }
  };
  const runChoices = (form: Form, kinds: string[]): void => {
    const rows = new RowFilters(form.samples, width, height, form.bpp);
    for (const kind of kinds) {
      if (kind === 'brute') consider(form, bruteRaw(rows));
      else if (kind.startsWith('block')) consider(form, blockRaw(rows, parseInt(kind.slice(5), 10)));
      else if (kind === 'minsum' || kind === 'pairs') consider(form, rows.assemble(choiceArray(rows, kind)));
      else consider(form, rows.assemble(new Uint8Array(height).fill(Number(kind))));
    }
  };

  // Palette forms, when the image holds at most 256 colours: by use count
  // (unfiltered only) and by luminance (unfiltered, minimum sum, brute).
  if (info.colours !== null) {
    const byCount = paletteForm(rgba, info.colours, false);
    runChoices({ colourType: 3, bpp: 1, samples: byCount.indices, plte: byCount.plte, trns: byCount.trns }, ['0']);
    const byLum = paletteForm(rgba, info.colours, true);
    runChoices({ colourType: 3, bpp: 1, samples: byLum.indices, plte: byLum.plte, trns: byLum.trns }, ['0', 'minsum', 'brute']);
  }

  // Channel form: grey (0, or 4 with alpha), RGB (2), or RGBA (6); a tRNS
  // key replaces the alpha channel when the image allows it.
  const key = transparentKey(rgba, info.grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (info.grey) {
    ct = info.opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = info.opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[ct] as number;
  const channel: Form = { colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns };
  const kinds = ['0', '1', '2', '3', '4', 'minsum', 'pairs', 'brute'];
  if (ct === 2 || ct === 6) kinds.push('block32', 'block64', 'block90', 'block128', 'block240');
  runChoices(channel, kinds);

  // The three best screened candidates, each re-compressed at level 9 with
  // both the default and the filtered strategy; the smallest file wins.
  let winner: { form: Form; zlib: Uint8Array; bytes: number } | null = null;
  for (const cand of best) {
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
      const z = deflateSync(cand.data, { level: 9, memLevel: 9, strategy });
      const bytes = fileBytes(cand.form, z.length);
      if (winner === null || bytes < winner.bytes) winner = { form: cand.form, zlib: z, bytes };
    }
  }
  if (winner === null) throw new Error('no candidate produced');
  return assemblePng(width, height, winner.form.colourType, winner.form.plte, winner.form.trns, winner.zlib);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

for (const id of readdirSync(INPUT_DIR).sort()) {
  try {
    const bytes = readFileSync(join(INPUT_DIR, id, 'image.png'));
    const image = decodePng(new Uint8Array(bytes));
    const out = encodeOne(image.rgba, image.width, image.height);
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'image.png'), out);
  } catch (err) {
    // One bad instance must never kill the run: it simply goes unanswered.
    console.error(id + ': ' + (err as Error).message);
  }
}
