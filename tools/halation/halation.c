/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: halation for the added Image Control slots (Ricoh GR IV, firmware 1.11).
 *
 * Called at the start of JpegEncodeMacroProcess::Execute with the process configuration, like the
 * date imprint (tools/datestamp/datestamp.c), before it. The configuration lists the YCbCr 4:2:2
 * pictures the JPEG encoder is about to compress (main picture, screennail, thumbnail). When the
 * picture was developed with an added slot that has halation and its level ("Halation" on the
 * parameter screen, the slider of Cinema's Toning) is not off, the light of the highlights spreads
 * around them as on CineStill 800T (cinema film without its anti-halation layer): light that went
 * through the film comes back from the base and exposes the red layer again, a little the green.
 *   1. light: how far a pixel is above the slot's threshold, of the brighter of Y and red,
 *      averaged down to a picture at most 1024 wide and high. Threshold and scale are the slot's
 *      own (`light`): the level its look gives to what Standard renders at the threshold and
 *      the range up to its white, so that the same light spreads whatever the look does to the
 *      highlights (a look whose white is 238 would otherwise never reach a fixed threshold);
 *   2. spread with two widths together (a narrow fringe and a wider glow; three box passes each
 *      way for each), relative to the picture's width;
 *   3. the spread light times the level's gain picks, from a table, how much red, green and blue
 *      are lifted towards white ("screen"): red first, so the glow is red, orange near strong
 *      light, and white highlights stay white.
 * Every picture is done on its own, with the widths scaled to it, so the screennail and the
 * thumbnail match the main picture. The parameters (fitted to CineStill 800T pictures) and the
 * table are made by GR Mod (halation.ts); GR Mod's preview runs the same integer steps.
 *
 * Which look and level: `stash` (written by the development step that reads the frame's record,
 * see slots.ts): bits 0..7 the style, 8..15 the level (0 off, 1 weak, 2 strong), bit 16 valid.
 *
 * Position-independent: no global data, every address comes in through `struct ctx`. No division
 * (the module must not need a run-time library).
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int s32;

struct picture {
  u8 format;          /* 1: YCbCr 4:2:2, Cb/Cr interleaved in their own plane */
  u8 pad[3];
  u8 *y;
  u8 *c;
  u32 size;
  u16 width, height, stride, c_height;
  u16 x, y_off;
  u8 tail[4];
};

struct params {
  u16 narrow, wide;   /* box radius of the two spreads, in 1/4096 of the picture's width */
  u16 mix;            /* share of the narrow spread, of 256 */
  u16 gain[2];        /* weak, strong: table index = light * gain >> 10 */
  u16 pad[3];
};

#define LUT_N 4096    /* lut[0..N) red, [N..2N) green, [2N..3N) blue: lift towards white, of 255 */

struct ctx {
  void *(*cache)(void);                              /* 0x538f0448 */
  void (*invalidate)(void *cache, u32 addr, u32 n);  /* 0x538f04d8 */
  void (*clean)(void *cache, u32 addr, u32 n);       /* 0x538f04c4 */
  void *(*alloc)(u32 n);                             /* 0x538e09b0 */
  void (*release)(void *p);                          /* 0x538e09ec */
  const volatile u32 *stash;
  u32 first_style, count;
  u32 enabled;        /* bit k: added slot k has halation */
  const u8 *lut;
  struct params p;
  u32 magic;
  u32 light[];        /* per added slot: threshold (0..254 of 255) | escale << 16 (16384 / range to the slot's white) */
};

#define STASH_VALID 0x10000u
#define SMALL_MAX 1024u
#define E_MAX 16384u

static int ram(const void *p) {
  u32 a = (u32)p;
  return a >= 0x40000000u && a < 0xc0000000u && (a & 3) == 0;
}

static int picture_ok(const struct picture *p) {
  u32 w = p->width, h = p->height;
  if (p->format != 1 || !ram(p->y) || !ram(p->c) || w < 64 || h < 48 || p->stride < w || p->c_height < h) return 0;
  return w <= 12000 && h <= 12000;
}

/* n / d for small numbers, by shift and subtract. */
static u32 udiv(u32 n, u32 d) {
  u32 q = 0, r = 0;
  s32 i;
  if (!d) return 0;
  for (i = 31; i >= 0; i--) {
    r = (r << 1) | ((n >> i) & 1);
    if (r >= d) { r -= d; q |= 1u << i; }
  }
  return q;
}

static void sync(const struct ctx *k, void *cache, const struct picture *p, int clean) {
  u32 a, b;
  a = (u32)p->y & ~63u; b = ((u32)p->y + (u32)p->height * p->stride + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
  a = (u32)p->c & ~63u; b = ((u32)p->c + (u32)p->height * p->stride + 63) & ~63u;
  if (clean) k->clean(cache, a, b - a); else k->invalidate(cache, a, b - a);
}

/* Box blur of radius r along one direction: n values `step` apart, through `tmp` (n values). */
static void box(u16 *v, u32 n, u32 step, u32 r, u32 recip, u16 *tmp) {
  u32 i, sum;
  s32 j;
  if (n < 2) return;
  for (i = 0; i < n; i++) tmp[i] = v[i * step];
  sum = 0;
  for (j = -(s32)r; j <= (s32)r; j++) sum += tmp[j < 0 ? 0 : ((u32)j >= n ? n - 1 : (u32)j)];
  for (i = 0; i < n; i++) {
    s32 out = (s32)i - (s32)r, in = (s32)i + (s32)r + 1;
    v[i * step] = (u16)((sum * recip) >> 16);
    sum -= tmp[out < 0 ? 0 : (u32)out];
    sum += tmp[(u32)in >= n ? n - 1 : (u32)in];
  }
}

/* Three box passes each way, radius from `rad` (1/4096 of the width sw). */
static void spread(u16 *v, u32 sw, u32 sh, u32 rad, u16 *tmp) {
  u32 r = (rad * sw + 2048) >> 12, recip, pass, x, y;
  if (r < 1) return;
  if (r > 200) r = 200;
  recip = udiv(65536u, 2 * r + 1);
  for (pass = 0; pass < 3; pass++) {
    for (y = 0; y < sh; y++) box(v + y * sw, sw, 1, r, recip, tmp);
    for (x = 0; x < sw; x++) box(v + x, sh, sw, r, recip, tmp);
  }
}

static s32 clamp8(s32 v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

/* Lift a colour towards white by h (0..255 of 255). */
static s32 lift(s32 v, u32 h) { return v + (s32)(((u32)(255 - v) * h * 257 + 32768) >> 16); }

static void halate(const struct ctx *k, void *cache, const struct picture *p, u32 gain, s32 threshold, u32 escale) {
  const struct params *P = &k->p;
  const u8 *lr = k->lut, *lg = k->lut + LUT_N, *lb = k->lut + 2 * LUT_N;
  u32 w = p->width, h = p->height, s = 0, q, F, sw, sh, x, y, i, n;
  u16 *small, *wide, *tmp, *row;
  u32 *acc;
  while ((w >> s) > SMALL_MAX || (h >> s) > SMALL_MAX) s++;
  F = 1u << s;
  sw = (w + F - 1) >> s; sh = (h + F - 1) >> s;
  n = sw * sh;
  small = (u16 *)k->alloc(n * 2 + 8);
  wide = (u16 *)k->alloc(n * 2 + 8);
  tmp = (u16 *)k->alloc((sw > sh ? sw : sh) * 2 + 8);
  acc = (u32 *)k->alloc(sw * 4 + 8);
  row = (u16 *)k->alloc(sw * 2 + 8);
  if (!small || !wide || !tmp || !acc || !row) goto out;
  sync(k, cache, p, 0);

  /* 1. light above the threshold (0..16384), of the brighter of Y and red, averaged over F x F
   * blocks; from blocks of 4 x 4 on, every other pixel of every other row is enough */
  q = s >= 2 ? 1 : 0;
  for (y = 0; y < h; y += F) {
    u32 by = y >> s, yy, ylim = y + F > h ? h : y + F;
    for (x = 0; x < sw; x++) acc[x] = 0;
    for (yy = y; yy < ylim; yy += 1u << q) {
      const u8 *yr = p->y + yy * p->stride, *cr = p->c + yy * p->stride;
      for (x = 0; x < w; x += 1u << q) {
        s32 v = yr[x], red = v + ((91881 * ((s32)cr[x | 1] - 128) + 32768) >> 16), e;
        if (red > v) v = red;
        e = v - threshold;
        if (e > 0) { u32 l = (u32)e * escale; acc[x >> s] += l > E_MAX ? E_MAX : l; }
      }
    }
    for (x = 0; x < sw; x++) {
      u32 v = acc[x] >> (2 * (s - q));
      small[by * sw + x] = (u16)(v > E_MAX ? E_MAX : v);
    }
  }

  /* 2. the narrow and the wide spread, mixed */
  for (i = 0; i < n; i++) wide[i] = small[i];
  spread(small, sw, sh, P->narrow, tmp);
  spread(wide, sw, sh, P->wide, tmp);
  for (i = 0; i < n; i++) small[i] = (u16)((small[i] * P->mix + wide[i] * (256 - P->mix)) >> 8);

  /* 3. lift towards white by the table, bilinear from the small picture; per pair of pixels
   * (they share Cb and Cr): to RGB, lift, back */
  for (y = 0; y < h; y++) {
    s32 fy = (s32)(((y << 8) + 128) >> s) - 128, sy0, sy1, wy;
    u32 maxv = 0, idx;
    u8 *yr = p->y + y * p->stride, *cr = p->c + y * p->stride;
    if (fy < 0) fy = 0;
    sy0 = fy >> 8; wy = fy & 255; sy1 = sy0 + 1;
    if ((u32)sy0 >= sh) sy0 = (s32)sh - 1;
    if ((u32)sy1 >= sh) sy1 = (s32)sh - 1;
    for (i = 0; i < sw; i++) {
      u32 v = ((u32)small[(u32)sy0 * sw + i] * (u32)(256 - wy) + (u32)small[(u32)sy1 * sw + i] * (u32)wy) >> 8;
      row[i] = (u16)v;
      if (v > maxv) maxv = v;
    }
    idx = (maxv * gain) >> 10;
    if (lr[idx >= LUT_N ? LUT_N - 1 : idx] == 0) continue;
    for (x = 0; x + 1 < w; x += 2) {
      s32 fx = (s32)(((x << 8) + 128) >> s) - 128, sx0, sx1, wx, cb, crr, j, sb = 0, sr = 0;
      u32 l, hr, hg, hb;
      if (fx < 0) fx = 0;
      sx0 = fx >> 8; wx = fx & 255; sx1 = sx0 + 1;
      if ((u32)sx1 >= sw) sx1 = (s32)sw - 1;
      l = ((u32)row[sx0] * (u32)(256 - wx) + (u32)row[sx1] * (u32)wx) >> 8;
      idx = (l * gain) >> 10;
      if (idx >= LUT_N) idx = LUT_N - 1;
      hr = lr[idx];
      if (!hr) continue;
      hg = lg[idx]; hb = lb[idx];
      cb = (s32)cr[x] - 128; crr = (s32)cr[x + 1] - 128;
      for (j = 0; j < 2; j++) {
        s32 Y = yr[x + j];
        s32 R = clamp8(Y + ((91881 * crr + 32768) >> 16));
        s32 G = clamp8(Y - ((22554 * cb + 46802 * crr - 32768) >> 16));
        s32 B = clamp8(Y + ((116130 * cb + 32768) >> 16));
        R = lift(R, hr); G = lift(G, hg); B = lift(B, hb);
        yr[x + j] = (u8)clamp8((19595 * R + 38470 * G + 7471 * B + 32768) >> 16);
        sb += -11059 * R - 21709 * G + 32768 * B;
        sr += 32768 * R - 27439 * G - 5329 * B;
      }
      cr[x] = (u8)clamp8(128 + ((sb + 65536) >> 17));
      cr[x + 1] = (u8)clamp8(128 + ((sr + 65536) >> 17));
    }
  }
  sync(k, cache, p, 1);
out:
  if (row) k->release(row);
  if (acc) k->release(acc);
  if (tmp) k->release(tmp);
  if (wide) k->release(wide);
  if (small) k->release(small);
}

/* Entry: k = context, config = JpegEncodeMacroProcess configuration. */
void halation(const struct ctx *k, u32 *config) {
  u32 st = *k->stash, style, level, i, j, gain, light, threshold, escale;
  struct picture *seen[4];
  void *cache;
  if (!(st & STASH_VALID) || !ram(config) || !ram(k->lut)) return;
  style = st & 0xff; level = (st >> 8) & 0xff;
  if (style < k->first_style || style >= k->first_style + k->count || style - k->first_style >= 32) return;
  if (!((k->enabled >> (style - k->first_style)) & 1)) return;
  if (level < 1 || level > 2) return;
  gain = k->p.gain[level - 1];
  light = k->light[style - k->first_style];
  threshold = light & 0xffff; escale = light >> 16;
  if (!gain || threshold > 254 || !escale || escale > E_MAX || k->p.mix > 256) return;
  cache = k->cache();
  /* One picture per buffer (another entry with the same planes describes the whole sensor). */
  for (i = 0; i < 4; i++) {
    struct picture *p = (struct picture *)config[(0x3c >> 2) + i];
    seen[i] = 0;
    if (!ram(p) || !picture_ok(p)) continue;
    for (j = 0; j < i; j++) if (seen[j] && seen[j]->y == p->y) break;
    if (j == i) seen[i] = p;
  }
  for (i = 0; i < 4; i++) if (seen[i]) halate(k, cache, seen[i], gain, (s32)threshold, escale);
}
