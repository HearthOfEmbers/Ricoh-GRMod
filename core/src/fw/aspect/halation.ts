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
 * look is fixed (`HALATION`, fitted to CineStill 800T); GR Mod only switches it on per slot.
 *
 * Not shown: live view (the effect is only in the JPEG, and in the camera's playback of it). RAW
 * files are not changed; a JPEG developed from one in the camera has the effect.
 */
import { FirmwareError } from '../types';
import { assembleWords, branchTarget, movImmediate } from './arm';
import { Patch, u32le } from './build';
import { HALATION_CODE, HALATION_CODE_LENGTH } from './halation-code';

/**
 * The look of the glow, the same for every slot that has it: fitted to CineStill 800T pictures
 * (night street lamps, platform tubes, LED boards): a saturated red fringe close to the light and a
 * wider, fainter red glow; orange near strong light; white highlights stay white. Only light near
 * clipping spreads, so a daylight picture shows it on lamps and specular highlights only.
 */
export const HALATION = {
  /**
   * Brightness (of the brighter of Y and red, of 255) above which light spreads, as the camera's
   * Standard renders it. Each slot uses the level its own look gives to that grey, and the range
   * from there to its white (`halationLight`).
   */
  threshold: 235,
  /** Least range from a slot's threshold to its white (a look that clips early still has a few levels of light). */
  minRange: 4,
  /** Box radius of the narrow and the wide spread, as a fraction of the picture's width (three box passes each way: about a gaussian of this sigma). */
  narrow: 0.0035,
  wide: 0.012,
  /** Share of the narrow spread. */
  mix: 0.6,
  /** Weak and strong: how strongly the spread light lifts the colours. */
  gain: [25, 60] as const,
  /** Lift of red, green and blue per unit of light (red first: the red layer is exposed again from behind, a little the green). */
  channels: [1, 0.06, 0.03] as const,
};

/** JpegEncodeMacroProcess::Execute. */
const JPEG_EXECUTE = 0x537034b4;
const CACHE = 0x538f0448;
const CACHE_FLUSH_FOR_READ = 0x538f04d8;
const CACHE_CLEAN = 0x538f04c4;
const HEAP_ALLOC = 0x538e09b0;
const HEAP_FREE = 0x538e09ec;
const MAX_SLOTS = 32;
const LUT_N = 4096;
const PARAM_BYTES = 16;
/** Marks the context so that a built file can be read back ('HAL2': with a threshold per slot; 'HALO' in 0.7.2). */
const CTX_MAGIC = 0x324c4148; // 'HAL2'
const CTX_MAGIC_072 = 0x4f4c4148; // 'HALO'

function fail(code: string, message: string): never {
  throw new FirmwareError(code, message);
}

/** struct params in halation.c. */
export function paramBytes(): Uint8Array {
  const out = new Uint8Array(PARAM_BYTES);
  const v = new DataView(out.buffer);
  const H = HALATION;
  v.setUint16(0, Math.round(H.narrow * 4096), true);
  v.setUint16(2, Math.round(H.wide * 4096), true);
  v.setUint16(4, Math.round(H.mix * 256), true);
  v.setUint16(6, Math.round(H.gain[0] * 4), true);
  v.setUint16(8, Math.round(H.gain[1] * 4), true);
  return out;
}

/** Where a slot's light starts (0..254 of 255) and its scale (16384 / range to the slot's white). */
export interface HalationLight { threshold: number; escale: number }

/** Without a look (the camera's Standard): from HALATION.threshold to 255. */
export const PLAIN_LIGHT: HalationLight = { threshold: HALATION.threshold, escale: Math.round(16384 / (255 - HALATION.threshold)) };

/**
 * A slot's light: grey goes through the slot's matrix unchanged (its rows sum to 1), so its look
 * on grey is its tone curves (256 values, 0..16383, for display input i * 64 / 16383) and the
 * post-curve matrix (Q9). The threshold is what the look gives to the grey Standard renders at
 * HALATION.threshold, the range runs from there to what it gives to white; both measured as the
 * module does (the brighter of Y and red).
 */
export function halationLight(curves: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>], postQ9?: ArrayLike<number>): HalationLight {
  const level = (v: number): number => {
    const x = (v / 255) * (16383 / 64);
    // the table ends at input 255 * 64 / 16383: white continues the last step
    const i = Math.min(254, Math.floor(x)), f = x - i;
    let o = curves.map((c) => Math.min(16383, c[i] + (c[i + 1] - c[i]) * f) / 16383);
    if (postQ9) o = [0, 1, 2].map((r) => (postQ9[r * 3] * o[0] + postQ9[r * 3 + 1] * o[1] + postQ9[r * 3 + 2] * o[2]) / 512);
    const [R, G, B] = o.map((c) => Math.round((c < 0 ? 0 : c > 1 ? 1 : c) * 255));
    return Math.max(R, (19595 * R + 38470 * G + 7471 * B + 32768) >> 16);
  };
  const white = level(255);
  const threshold = Math.max(0, Math.min(254, level(HALATION.threshold), white - HALATION.minRange));
  return { threshold, escale: Math.min(16384, Math.round(16384 / Math.max(1, white - threshold))) };
}

let lutCache: Uint8Array | undefined;
/** The table of halation.c: lift of red, green, blue (of 255) for light index i (i / 64 units). */
export function halationLut(): Uint8Array {
  if (lutCache) return lutCache;
  const out = new Uint8Array(3 * LUT_N);
  HALATION.channels.forEach((wc, c) => {
    for (let i = 0; i < LUT_N; i++) out[c * LUT_N + i] = Math.round(255 * (1 - Math.exp(-(i / 64) * wc)));
  });
  lutCache = out;
  return out;
}

export function halationModule(): Uint8Array {
  const raw = Uint8Array.from(atob(HALATION_CODE), (c) => c.charCodeAt(0));
  if (raw.length !== HALATION_CODE_LENGTH || raw.length % 4 !== 0) fail('internal', 'halation module length');
  return raw;
}

/**
 * Install the module at the JPEG encode step for the added slots whose `enabled` entry is true
 * (one per added slot); their styles start at `firstStyle`; `stash` is the word the development
 * step writes. Chains to the date imprint when that is installed (it runs after the halation).
 */
export function installHalationModule(p: Patch, enabled: readonly boolean[], firstStyle: number, stash: number, light: readonly HalationLight[]): void {
  if (enabled.length < 1 || enabled.length > MAX_SLOTS) fail('internal', 'halation: number of slots');
  if (light.length !== enabled.length || light.some((l) => !(l.threshold >= 0 && l.threshold <= 254 && l.escale >= 1 && l.escale <= 16384))) fail('internal', 'halation: light of the slots');
  const first = p.word(JPEG_EXECUTE);
  let tail: string;
  if (first === 0xe1a0c00d) tail = `mov ip,sp;b #${JPEG_EXECUTE + 4}`;
  else if (first >>> 24 === 0xea) tail = `b #${branchTarget(JPEG_EXECUTE, first)}`;
  else fail('unexpected-layout', 'halation: unexpected JPEG encode entry');
  const mask = enabled.reduce((m, on, k) => (on ? m | (1 << k) : m), 0) >>> 0;
  const lut = p.append(halationLut(), 16);
  const ctx = p.append(new Uint8Array([
    ...u32le([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, HEAP_ALLOC, HEAP_FREE, stash, firstStyle, enabled.length, mask, lut]),
    ...paramBytes(),
    ...u32le([CTX_MAGIC, ...light.map((l) => (l.threshold | (l.escale << 16)) >>> 0)]),
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

/** Which added slots of a built image have halation, or null when none has. */
export function readHalation(p: Patch, count: number): boolean[] | null {
  try {
    const first = p.word(JPEG_EXECUTE);
    if (first >>> 24 !== 0xea) return null;
    const stub = branchTarget(JPEG_EXECUTE, first);
    // push; ldr r1,[r1,#8]; movw r0; movt r0
    const ctx = (movImmediate(p.word(stub + 8)) | (movImmediate(p.word(stub + 12)) << 16)) >>> 0;
    const magic = p.word(ctx + 10 * 4 + PARAM_BYTES);
    if (magic !== CTX_MAGIC && magic !== CTX_MAGIC_072) return null;
    const mask = p.word(ctx + 8 * 4);
    return Array.from({ length: count }, (_, k) => ((mask >>> k) & 1) === 1);
  } catch {
    return null;
  }
}

/** The light of each added slot of a built image (null when it has no halation, or from 0.7.2: one fixed threshold). */
export function readHalationLight(p: Patch, count: number): HalationLight[] | null {
  try {
    const stub = branchTarget(JPEG_EXECUTE, p.word(JPEG_EXECUTE));
    const ctx = (movImmediate(p.word(stub + 8)) | (movImmediate(p.word(stub + 12)) << 16)) >>> 0;
    const at = ctx + 10 * 4 + PARAM_BYTES;
    if (p.word(at) !== CTX_MAGIC) return null;
    return Array.from({ length: count }, (_, k) => { const w = p.word(at + 4 + 4 * k); return { threshold: w & 0xffff, escale: w >>> 16 }; });
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

/**
 * The name of the parameter, per row of the text catalog (21; see build.ts): 0 Japanese, 1 English,
 * 2 French, 3 German, 4 Spanish, 5 Portuguese, 6 Italian, 7 Dutch, 8 Danish, 9 Swedish, 10 Finnish,
 * 11 Polish, 12 Czech, 13 Hungarian, 14 Turkish, 15 Greek, 16 Russian, 17 Korean, 18 Traditional
 * Chinese, 19 Simplified Chinese, 20 Thai (as the rows hold "OK" / "Toning").
 */
export const HALATION_NAMES: readonly string[] = [
  'ハレーション', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation',
  'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Halation', 'Ореол', '할레이션', '光暈',
  '光晕', 'Halation',
];

// -------------------------------------------------------------------------------- preview

const c8 = (n: number): number => (n < 0 ? 0 : n > 255 ? 255 : n);
/** Lift towards white by h (0..255 of 255), as `lift` in halation.c. */
const lift = (v: number, h: number): number => v + Math.floor(((255 - v) * h * 257 + 32768) / 65536);

/**
 * The module's computation (halation.c, `halate`) in TypeScript, on a YCbCr 4:2:2 picture (Y and
 * the interleaved CbCr plane, `w` bytes per row each), for GR Mod's preview. Same integer steps.
 */
export function halateYcc(Y: Uint8Array, C: Uint8Array, w: number, h: number, level: 1 | 2, light: HalationLight = PLAIN_LIGHT): void {
  const P = paramBytes();
  const v = new DataView(P.buffer);
  const { threshold, escale } = light;
  const narrow = v.getUint16(0, true), wideR = v.getUint16(2, true), mix = v.getUint16(4, true);
  const gain = v.getUint16(level === 1 ? 6 : 8, true);
  const lut = halationLut();
  let s = 0;
  while ((w >>> s) > 1024 || (h >>> s) > 1024) s++;
  const F = 1 << s;
  const sw = (w + F - 1) >>> s, sh = (h + F - 1) >>> s, n = sw * sh;
  const small = new Uint16Array(n);
  const acc = new Uint32Array(sw);
  const q = s >= 2 ? 1 : 0;
  for (let y = 0; y < h; y += F) {
    const by = y >>> s, ylim = Math.min(h, y + F);
    acc.fill(0);
    for (let yy = y; yy < ylim; yy += 1 << q) {
      const row = yy * w;
      for (let x = 0; x < w; x += 1 << q) {
        let val = Y[row + x];
        const red = val + ((91881 * (C[row + (x | 1)] - 128) + 32768) >> 16);
        if (red > val) val = red;
        const e = val - threshold;
        if (e > 0) acc[x >>> s] += Math.min(16384, e * escale);
      }
    }
    for (let x = 0; x < sw; x++) small[by * sw + x] = Math.min(16384, acc[x] >>> (2 * (s - q)));
  }
  const tmp = new Uint16Array(Math.max(sw, sh));
  const spread = (a: Uint16Array, rad: number): void => {
    let r = (rad * sw + 2048) >>> 12;
    if (r < 1) return;
    if (r > 200) r = 200;
    const recip = Math.floor(65536 / (2 * r + 1));
    const box = (off: number, len: number, step: number): void => {
      if (len < 2) return;
      for (let i = 0; i < len; i++) tmp[i] = a[off + i * step];
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += tmp[j < 0 ? 0 : j >= len ? len - 1 : j];
      for (let i = 0; i < len; i++) {
        const out = i - r, inn = i + r + 1;
        a[off + i * step] = (sum * recip) >>> 16;
        sum -= tmp[out < 0 ? 0 : out];
        sum += tmp[inn >= len ? len - 1 : inn];
      }
    };
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < sh; y++) box(y * sw, sw, 1);
      for (let x = 0; x < sw; x++) box(x, sh, sw);
    }
  };
  const wide = small.slice();
  spread(small, narrow);
  spread(wide, wideR);
  for (let i = 0; i < n; i++) small[i] = (small[i] * mix + wide[i] * (256 - mix)) >>> 8;
  const rowv = new Uint32Array(sw);
  const at = (i: number): number => (i >= LUT_N ? LUT_N - 1 : i);
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
    if (lut[at(Math.floor((maxv * gain) / 1024))] === 0) continue;
    const row = y * w;
    for (let x = 0; x + 1 < w; x += 2) {
      let fx = (((x << 8) + 128) >> s) - 128;
      if (fx < 0) fx = 0;
      const sx0 = fx >> 8, wx = fx & 255;
      let sx1 = sx0 + 1;
      if (sx1 >= sw) sx1 = sw - 1;
      const l = (rowv[sx0] * (256 - wx) + rowv[sx1] * wx) >>> 8;
      const idx = at(Math.floor((l * gain) / 1024));
      const hr = lut[idx];
      if (!hr) continue;
      const hg = lut[LUT_N + idx], hb = lut[2 * LUT_N + idx];
      const cb = C[row + x] - 128, cr = C[row + x + 1] - 128;
      let sb = 0, sr = 0;
      for (let j = 0; j < 2; j++) {
        const y0 = Y[row + x + j];
        const R = lift(c8(y0 + ((91881 * cr + 32768) >> 16)), hr);
        const G = lift(c8(y0 - ((22554 * cb + 46802 * cr - 32768) >> 16)), hg);
        const B = lift(c8(y0 + ((116130 * cb + 32768) >> 16)), hb);
        Y[row + x + j] = c8((19595 * R + 38470 * G + 7471 * B + 32768) >> 16);
        sb += -11059 * R - 21709 * G + 32768 * B;
        sr += 32768 * R - 27439 * G - 5329 * B;
      }
      C[row + x] = c8(128 + ((sb + 65536) >> 17));
      C[row + x + 1] = c8(128 + ((sr + 65536) >> 17));
    }
  }
}

/** Halation on an RGBA picture (sRGB, through YCbCr 4:2:2 as in the camera), in place; `light` of the slot (`halationLight`). */
export function halateRgba(data: Uint8ClampedArray, width: number, height: number, level: 1 | 2, light: HalationLight = PLAIN_LIGHT): void {
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
  halateYcc(Y, C, w, height, level, light);
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
