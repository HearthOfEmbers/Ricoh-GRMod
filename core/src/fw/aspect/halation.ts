// SPDX-License-Identifier: GPL-2.0-only
/**
 * Halation for the added Image Control slots: the light of the highlights spread around them in a
 * warm red, as on film without an anti-halation layer (CineStill 800T and the like).
 *
 * In the camera the level is chosen per slot on the parameter screen: the slider of Cinema's
 * "Toning" (parameter 8, values 0..2, which does nothing for an added slot: its curves apply as
 * they are) becomes "Halation" with Off / Weak / Strong for an added slot. Its value travels with
 * the other parameters (own values per slot and set, the frame's record at +0x7A6, RAW
 * development, the maker note).
 *
 * The effect is applied to the finished pictures, before they are compressed: the module of
 * `tools/halation/halation.c` runs at the start of JpegEncodeMacroProcess::Execute (0x537034B4),
 * before the date imprint when that is installed. Which look and level the picture has is left in
 * a word by the development step that reads the frame's record (0x539113DC, see `slots.ts`). The
 * look's settings (threshold, radius, strength of Weak and Strong, colour) are set in GR Mod.
 *
 * Not shown: live view (the effect is only in the JPEG, and in the camera's playback of it). RAW
 * files are not changed; a JPEG developed from one in the camera has the effect.
 */
import { FirmwareError } from '../types';
import { assembleWords, branchTarget, movImmediate } from './arm';
import { Patch, u32le } from './build';
import { HALATION_CODE, HALATION_CODE_LENGTH } from './halation-code';

/** What GR Mod lets the user set for one slot. Integer units so that a file can be read back. */
export interface HalationSpec {
  /** Brightness (0..254 of 255) above which light spreads. */
  threshold: number;
  /** Size of the glow, in 1/1000 of the picture's width (1..100). */
  radius: number;
  /** Strength of Weak and Strong, in tenths (0..200: 0 = none, 10 = 1.0). */
  weak: number;
  strong: number;
  /** Colour of the glow. */
  color: readonly [number, number, number];
  /** How much the glow brightens as well as tints, in percent (0..100). */
  luminance: number;
}

export const DEFAULT_HALATION: HalationSpec = { threshold: 225, radius: 6, weak: 50, strong: 100, color: [255, 40, 0], luminance: 30 };

/** JpegEncodeMacroProcess::Execute. */
const JPEG_EXECUTE = 0x537034b4;
const CACHE = 0x538f0448;
const CACHE_FLUSH_FOR_READ = 0x538f04d8;
const CACHE_CLEAN = 0x538f04c4;
const HEAP_ALLOC = 0x538e09b0;
const HEAP_FREE = 0x538e09ec;
const MAX_LOOKS = 6;
const LOOK_BYTES = 16;
const SPEC_BYTES = 12;
/** Marks the context so that a built file can be read back. */
const CTX_MAGIC = 0x4f4c4148; // 'HALO'

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

export function validateHalation(h: HalationSpec): string | null {
  const int = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
  if (!h || typeof h !== 'object') return 'missing';
  if (!int(h.threshold, 0, 254)) return 'threshold';
  if (!int(h.radius, 1, 100)) return 'radius';
  if (!int(h.weak, 0, 200) || !int(h.strong, 0, 200)) return 'strength';
  if (!Array.isArray(h.color) || h.color.length !== 3 || !h.color.every((c) => int(c, 0, 255))) return 'color';
  if (!int(h.luminance, 0, 100)) return 'luminance';
  return null;
}

/** The module's parameters of one look (struct look in halation.c). */
export function lookBytes(h: HalationSpec | undefined): Uint8Array {
  const out = new Uint8Array(LOOK_BYTES);
  if (!h) return out;
  const v = new DataView(out.buffer);
  const [r, g, b] = h.color.map((c) => c / 255);
  const lum = h.luminance / 100;
  const dy = (0.299 * r + 0.587 * g + 0.114 * b) * lum;
  const dcb = -0.168736 * r - 0.331264 * g + 0.5 * b;
  const dcr = 0.5 * r - 0.418688 * g - 0.081312 * b;
  const q = (x: number): number => Math.max(-32767, Math.min(32767, Math.round(255 * x * 256)));
  v.setUint16(0, h.threshold, true);
  v.setUint16(2, Math.round(1024 / (255 - h.threshold)), true);
  v.setUint16(4, Math.max(1, Math.round((h.radius * 4096) / 1000)), true);
  v.setUint16(6, Math.round((h.weak * 256) / 10), true);
  v.setUint16(8, Math.round((h.strong * 256) / 10), true);
  v.setInt16(10, q(dy), true);
  v.setInt16(12, q(dcb), true);
  v.setInt16(14, q(dcr), true);
  return out;
}

function specBytes(h: HalationSpec | undefined): Uint8Array {
  const out = new Uint8Array(SPEC_BYTES);
  if (!h) return out;
  out.set([1, h.threshold, h.radius, h.luminance, h.weak, h.strong, h.color[0], h.color[1], h.color[2]]);
  return out;
}

function specOf(b: Uint8Array): HalationSpec | undefined {
  if (b[0] !== 1) return undefined;
  return { threshold: b[1], radius: b[2], luminance: b[3], weak: b[4], strong: b[5], color: [b[6], b[7], b[8]] };
}

export function halationModule(): Uint8Array {
  const raw = Uint8Array.from(atob(HALATION_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== HALATION_CODE_LENGTH || raw.length % 4 !== 0) fail('internal', 'halation module length');
  return raw;
}

/**
 * Install the module at the JPEG encode step for `looks` (one entry per added slot, undefined =
 * no halation) whose styles start at `firstStyle`; `stash` is the word the development step
 * writes. Chains to the date imprint when that is installed (it runs after the halation).
 */
export function installHalationModule(p: Patch, looks: readonly (HalationSpec | undefined)[], firstStyle: number, stash: number): void {
  if (looks.length < 1 || looks.length > MAX_LOOKS) fail('internal', 'halation: number of looks');
  looks.forEach((h, k) => {
    if (h && validateHalation(h)) fail('bad-halation', `added slot ${k + 1}: halation ${validateHalation(h)}`);
  });
  const first = p.word(JPEG_EXECUTE);
  let tail: string;
  if (first === 0xe1a0c00d) tail = `mov ip,sp;b #${JPEG_EXECUTE + 4}`;
  else if (first >>> 24 === 0xea) tail = `b #${branchTarget(JPEG_EXECUTE, first)}`;
  else fail('unexpected-layout', 'halation: unexpected JPEG encode entry');
  const lookTable: Uint8Array[] = [];
  const specs: Uint8Array[] = [];
  for (let k = 0; k < MAX_LOOKS; k++) {
    lookTable.push(lookBytes(looks[k]));
    specs.push(specBytes(looks[k]));
  }
  const ctx = p.append(new Uint8Array([
    ...u32le([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, HEAP_ALLOC, HEAP_FREE, stash, firstStyle, looks.length]),
    ...lookTable.flatMap((b) => [...b]),
    ...u32le([CTX_MAGIC]),
    ...specs.flatMap((b) => [...b]),
  ]), 16);
  const code = p.append(halationModule(), 16);
  const stub = p.append((at) => assembleWords(
    `push {r0-r3,ip,lr}
     ldr r1,[r1,#8]
     movw r0,#${ctx & 65535};movt r0,#${ctx >>> 16}
     bl #${code}
     pop {r0-r3,ip,lr}
     ${tail}`, at), 16);
  p.setWord(JPEG_EXECUTE, (0xea000000 | (((stub - (JPEG_EXECUTE + 8)) >> 2) & 0xffffff)) >>> 0, 'added slots: halation at the JPEG encode step');
}

/** The halation of each added slot of a built image, or null when it has none. */
export function readHalation(p: Patch, count: number): (HalationSpec | undefined)[] | null {
  try {
    const first = p.word(JPEG_EXECUTE);
    if (first >>> 24 !== 0xea) return null;
    const stub = branchTarget(JPEG_EXECUTE, first);
    // push; ldr r1,[r1,#8]; movw r0; movt r0
    const ctx = (movImmediate(p.word(stub + 8)) | (movImmediate(p.word(stub + 12)) << 16)) >>> 0;
    const at = ctx + 8 * 4 + MAX_LOOKS * LOOK_BYTES;
    if (p.word(at) !== CTX_MAGIC) return null;
    const out: (HalationSpec | undefined)[] = [];
    for (let k = 0; k < count; k++) out.push(specOf(p.read(at + 4 + k * SPEC_BYTES, SPEC_BYTES)));
    return out;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------- pictures

/** Colour and coverage (0..255) of a pixel, or null. */
type Paint = (x: number, y: number) => [number, number, number, number] | null;

/**
 * Pixels as the camera's icons have them: no partial transparency. A pixel at least half covered
 * becomes opaque, its colour mixed with black by the coverage (the native icons have black
 * edges); the others stay as `base` has them (transparent: FF FF FF 00).
 */
function render(w: number, h: number, paint: Paint, base?: Uint8Array): Uint8Array {
  const out = base ? base.slice() : new Uint8Array(w * h * 4).fill(255).map((v, i) => (i % 4 === 3 ? 0 : v));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = paint(x, y);
    if (!c || c[3] < 128) continue;
    const i = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) out[i + k] = Math.round((c[k] * c[3]) / 255);
    out[i + 3] = 255;
  }
  return out;
}

/** Coverage of a disc / ring, 4x4 supersampled. */
function cover(x: number, y: number, cx: number, cy: number, r0: number, r1: number): number {
  let n = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const dx = x + (sx + 0.5) / 4 - cx, dy = y + (sy + 0.5) / 4 - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d >= r0 && d <= r1) n++;
  }
  return n / 16;
}

const RED: [number, number, number] = [255, 84, 40];

/** A light with a red ring: the list icon of the parameter (40 x 40, like the other parameters). */
export function halationIcon(): Uint8Array {
  return render(40, 40, (x, y) => {
    const core = cover(x, y, 20, 20, 0, 6);
    const ring = cover(x, y, 20, 20, 10, 15.5);
    if (core) return [255, 255, 255, Math.round(255 * core)];
    if (ring) return [...RED, Math.round(255 * ring)];
    return null;
  });
}

/**
 * The slider's scale (400 x 60, as the native ones): the panel and the track of `native` (the
 * three-position scale 0x23B), its marks replaced by Off (an empty circle), Weak and Strong (a
 * light with a thin and a thick red ring) at x = 20, 200, 380.
 */
export function halationScale(native: Uint8Array): Uint8Array {
  if (native.length !== 400 * 60 * 4) fail('unexpected-layout', 'halation: the native scale has another size');
  const base = native.slice();
  // Clear the marks (above the track): back to the panel colour.
  for (let y = 2; y < 34; y++) for (let x = 0; x < 400; x++) {
    const i = (y * 400 + x) * 4;
    base[i] = 0; base[i + 1] = 0; base[i + 2] = 0; base[i + 3] = 191;
  }
  const marks: Paint = (x, y) => {
    const off = cover(x, y, 20, 17, 6, 8);
    if (off) return [255, 255, 255, Math.round(255 * off)];
    for (const [cx, ring] of [[200, 2.2], [380, 4.5]] as const) {
      const core = cover(x, y, cx, 17, 0, 4);
      const red = cover(x, y, cx, 17, 6, 6 + ring);
      if (core) return [255, 255, 255, Math.round(255 * core)];
      if (red) return [...RED, Math.round(255 * red)];
    }
    return null;
  };
  return render(400, 60, marks, base);
}

/** The name of the parameter, per camera language (21; see build.ts). */
export const HALATION_NAMES: readonly string[] = [
  'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation',
  'ハレーション', '할레이션', 'Halation', 'Halation', 'Halation', 'Halation', '光晕', 'Halation', 'Halation', 'Halation',
  '光暈', 'Halation',
];

// -------------------------------------------------------------------------------- preview

/**
 * The module's computation (halation.c, `halate`) in TypeScript, on a YCbCr 4:2:2 picture (Y and
 * the interleaved CbCr plane, `w` bytes per row each), for GR Mod's preview. Same integer steps.
 */
export function halateYcc(Y: Uint8Array, C: Uint8Array, w: number, h: number, look: Uint8Array, level: 1 | 2): void {
  const v = new DataView(look.buffer, look.byteOffset, look.byteLength);
  const threshold = v.getUint16(0, true), escale = v.getUint16(2, true), radius = v.getUint16(4, true);
  const strength = v.getUint16(level === 1 ? 6 : 8, true);
  const ky = v.getInt16(10, true), kcb = v.getInt16(12, true), kcr = v.getInt16(14, true);
  if (!strength || threshold > 254) return;
  const kmax = Math.max(Math.abs(ky), Math.abs(kcb), Math.abs(kcr));
  let s = 0;
  while ((w >>> s) > 512) s++;
  const F = 1 << s;
  const sw = (w + F - 1) >>> s, sh = (h + F - 1) >>> s;
  const small = new Uint16Array(sw * sh);
  const acc = new Uint32Array(sw);
  const q = s >= 2 ? 1 : 0;
  for (let y = 0; y < h; y += F) {
    const by = y >>> s, ylim = Math.min(h, y + F);
    acc.fill(0);
    for (let yy = y; yy < ylim; yy += 1 << q) {
      const row = yy * w;
      for (let x = 0; x < w; x += 1 << q) {
        const e = Y[row + x] - threshold;
        if (e > 0) acc[x >>> s] += e * escale;
      }
    }
    for (let x = 0; x < sw; x++) small[by * sw + x] = Math.min(1024, acc[x] >>> (2 * (s - q)));
  }
  let r = (radius * sw) >>> 12;
  r = Math.max(1, Math.min(200, r));
  const recip = Math.floor(65536 / (2 * r + 1));
  const tmp = new Uint16Array(Math.max(sw, sh));
  const box = (off: number, n: number, step: number): void => {
    if (n < 2) return;
    for (let i = 0; i < n; i++) tmp[i] = small[off + i * step];
    let sum = 0;
    for (let j = -r; j <= r; j++) sum += tmp[j < 0 ? 0 : j >= n ? n - 1 : j];
    for (let i = 0; i < n; i++) {
      const out = i - r, inn = i + r + 1;
      small[off + i * step] = Math.floor((sum * recip) / 65536);
      sum -= tmp[out < 0 ? 0 : out];
      sum += tmp[inn >= n ? n - 1 : inn];
    }
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < sh; y++) box(y * sw, sw, 1);
    for (let x = 0; x < sw; x++) box(x, sh, sw);
  }
  const rowv = new Uint32Array(sw);
  const c8 = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : n);
  for (let y = 0; y < h; y++) {
    let fy = (((y << 8) + 128) >> s) - 128;
    if (fy < 0) fy = 0;
    let sy0 = fy >> 8; const wy = fy & 255; let sy1 = sy0 + 1;
    if (sy0 >= sh) sy0 = sh - 1;
    if (sy1 >= sh) sy1 = sh - 1;
    let maxv = 0;
    for (let i = 0; i < sw; i++) {
      const val = (small[sy0 * sw + i] * (256 - wy) + small[sy1 * sw + i] * wy) >>> 8;
      rowv[i] = val;
      if (val > maxv) maxv = val;
    }
    if (Math.floor((((maxv * strength) >>> 8) * kmax) / 262144) === 0) continue;
    const row = y * w;
    for (let x = 0; x < w; x += 2) {
      let fx = (((x << 8) + 128) >> s) - 128;
      if (fx < 0) fx = 0;
      const sx0 = fx >> 8, wx = fx & 255;
      let sx1 = sx0 + 1;
      if (sx1 >= sw) sx1 = sw - 1;
      const l = (rowv[sx0] * (256 - wx) + rowv[sx1] * wx) >>> 8;
      let g = (l * strength) >>> 8;
      if (!g) continue;
      if (g > 8191) g = 8191;
      const y0 = Y[row + x], y1 = x + 1 < w ? Y[row + x + 1] : y0;
      const sh18 = (k: number): number => (g * k) >> 18;
      Y[row + x] = c8(y0 + ((sh18(ky) * (255 - y0)) >> 8));
      if (x + 1 < w) Y[row + x + 1] = c8(y1 + ((sh18(ky) * (255 - y1)) >> 8));
      const room = 255 - ((y0 + y1) >> 1);
      C[row + x] = c8(C[row + x] + ((sh18(kcb) * room) >> 8));
      C[row + x + 1] = c8(C[row + x + 1] + ((sh18(kcr) * room) >> 8));
    }
  }
}

/** Halation on an RGBA picture (sRGB, through YCbCr 4:2:2 as in the camera), in place. */
export function halateRgba(data: Uint8ClampedArray, width: number, height: number, spec: HalationSpec, level: 1 | 2): void {
  const w = width & ~1;
  if (w < 2 || height < 2) return;
  const Y = new Uint8Array(w * height), C = new Uint8Array(w * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < w; x += 2) {
    let cb = 0, cr = 0;
    for (let k = 0; k < 2; k++) {
      const i = (y * width + x + k) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      Y[y * w + x + k] = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b)));
      cb += 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      cr += 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    C[y * w + x] = Math.max(0, Math.min(255, Math.round(cb / 2)));
    C[y * w + x + 1] = Math.max(0, Math.min(255, Math.round(cr / 2)));
  }
  const before = Y.slice(), cbefore = C.slice();
  halateYcc(Y, C, w, height, lookBytes(spec), level);
  // Only the change is put back, so the rest of the picture keeps its full colour resolution.
  for (let y = 0; y < height; y++) for (let x = 0; x < w; x += 2) {
    const dcb = C[y * w + x] - cbefore[y * w + x], dcr = C[y * w + x + 1] - cbefore[y * w + x + 1];
    for (let k = 0; k < 2; k++) {
      const dy = Y[y * w + x + k] - before[y * w + x + k];
      if (!dy && !dcb && !dcr) continue;
      const i = (y * width + x + k) * 4;
      data[i] += dy + 1.402 * dcr;
      data[i + 1] += dy - 0.344136 * dcb - 0.714136 * dcr;
      data[i + 2] += dy + 1.772 * dcb;
    }
  }
}
