/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: halation for the added Image Control slots (Ricoh GR IV, firmware 1.11).
 *
 * Called at the start of JpegEncodeMacroProcess::Execute with the process configuration, like the
 * date imprint (tools/datestamp/datestamp.c), before it. The configuration lists the YCbCr 4:2:2
 * pictures the JPEG encoder is about to compress (main picture, screennail, thumbnail). When the
 * picture was developed with an added slot whose halation level ("Halation" on the parameter
 * screen, the slider of Cinema's Toning) is not off, the light of the highlights is spread around
 * them in a warm red, as on film without an anti-halation layer:
 *   1. the highlights above a threshold, averaged down by a power of two (at most ~512 wide);
 *   2. a blur of a radius relative to the picture's width (three box passes each way);
 *   3. added back in the slot's colour, scaled down where the picture is already bright so the
 *      cores stay white.
 * Every picture is done on its own, with the radius scaled to its width, so the screennail and the
 * thumbnail match the main picture.
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
typedef short s16;

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

/* One slot's halation (all zero: none). Written by GR Mod (halation.ts). */
struct look {
  u16 threshold;      /* Y above this (0..254) is light that spreads */
  u16 escale;         /* 1024 / (255 - threshold): the light of a pixel, 0..1024 */
  u16 radius;         /* blur radius in 1/4096 of the picture's width */
  u16 strength[2];    /* weak, strong: 256 = 1.0 */
  s16 ky, kcb, kcr;   /* change of Y, Cb, Cr for a glow of 1.0 on black, x256 */
};

#define MAX_LOOKS 6

struct ctx {
  void *(*cache)(void);                              /* 0x538f0448 */
  void (*invalidate)(void *cache, u32 addr, u32 n);  /* 0x538f04d8 */
  void (*clean)(void *cache, u32 addr, u32 n);       /* 0x538f04c4 */
  void *(*alloc)(u32 n);                             /* 0x538e09b0 */
  void (*release)(void *p);                          /* 0x538e09ec */
  const volatile u32 *stash;
  u32 first_style, count;
  struct look looks[MAX_LOOKS];
};

#define STASH_VALID 0x10000u
#define SMALL_MAX 512u

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

static u8 clamp8(s32 v) { return (u8)(v < 0 ? 0 : (v > 255 ? 255 : v)); }

static void halate(const struct ctx *k, void *cache, const struct picture *p, const struct look *L, u32 strength) {
  u32 w = p->width, h = p->height, s = 0, q, F, sw, sh, x, y, i, r, recip, pass, kmax;
  u16 *small, *tmp, *row;
  u32 *acc;
  if (!strength) return;
  kmax = (u32)(L->ky < 0 ? -L->ky : L->ky);
  if ((u32)(L->kcb < 0 ? -L->kcb : L->kcb) > kmax) kmax = (u32)(L->kcb < 0 ? -L->kcb : L->kcb);
  if ((u32)(L->kcr < 0 ? -L->kcr : L->kcr) > kmax) kmax = (u32)(L->kcr < 0 ? -L->kcr : L->kcr);
  while ((w >> s) > SMALL_MAX) s++;
  F = 1u << s;
  sw = (w + F - 1) >> s; sh = (h + F - 1) >> s;
  small = (u16 *)k->alloc(sw * sh * 2);
  tmp = (u16 *)k->alloc((sw > sh ? sw : sh) * 2 + 8);
  acc = (u32 *)k->alloc(sw * 4 + 8);
  row = (u16 *)k->alloc(sw * 2 + 8);
  if (!small || !tmp || !acc || !row) goto out;
  sync(k, cache, p, 0);

  /* 1. light above the threshold (0..1024), averaged over F x F blocks; from blocks of 4 x 4 on,
   * every other pixel of every other row is enough (a quarter of the reads of the main picture) */
  q = s >= 2 ? 1 : 0;
  for (y = 0; y < h; y += F) {
    u32 by = y >> s, yy, ylim = y + F > h ? h : y + F;
    for (x = 0; x < sw; x++) acc[x] = 0;
    for (yy = y; yy < ylim; yy += 1u << q) {
      const u8 *yr = p->y + yy * p->stride;
      for (x = 0; x < w; x += 1u << q) {
        s32 e = (s32)yr[x] - (s32)L->threshold;
        if (e > 0) acc[x >> s] += (u32)e * L->escale;
      }
    }
    for (x = 0; x < sw; x++) {
      u32 v = acc[x] >> (2 * (s - q));
      small[by * sw + x] = (u16)(v > 1024 ? 1024 : v);
    }
  }

  /* 2. blur: radius in small pixels */
  r = (L->radius * sw) >> 12;
  if (r < 1) r = 1;
  if (r > 200) r = 200;
  recip = udiv(65536u, 2 * r + 1);
  for (pass = 0; pass < 3; pass++) {
    for (y = 0; y < sh; y++) box(small + y * sw, sw, 1, r, recip, tmp);
    for (x = 0; x < sw; x++) box(small + x, sh, sw, r, recip, tmp);
  }

  /* 3. add back, bilinear from the small picture */
  for (y = 0; y < h; y++) {
    s32 fy = (s32)(((y << 8) + 128) >> s) - 128, sy0, sy1, wy;
    u32 maxv = 0;
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
    /* nothing shows where the largest change would stay below one level */
    if ((((maxv * strength) >> 8) * kmax) >> 18 == 0) continue;
    for (x = 0; x < w; x += 2) {
      s32 fx = (s32)(((x << 8) + 128) >> s) - 128, sx0, sx1, wx;
      u32 l, g, room, y0, y1;
      if (fx < 0) fx = 0;
      sx0 = fx >> 8; wx = fx & 255; sx1 = sx0 + 1;
      if ((u32)sx1 >= sw) sx1 = (s32)sw - 1;
      l = ((u32)row[sx0] * (u32)(256 - wx) + (u32)row[sx1] * (u32)wx) >> 8;
      g = (l * strength) >> 8;                /* glow, 1024 = 1.0 */
      if (!g) continue;
      if (g > 8191) g = 8191;
      y0 = yr[x]; y1 = x + 1 < w ? yr[x + 1] : y0;
      /* screen-like: the glow fades out where the picture is already bright, the cores stay white */
      yr[x] = clamp8((s32)y0 + ((((s32)g * L->ky) >> 18) * (s32)(255 - y0) >> 8));
      if (x + 1 < w) yr[x + 1] = clamp8((s32)y1 + ((((s32)g * L->ky) >> 18) * (s32)(255 - y1) >> 8));
      room = 255 - ((y0 + y1) >> 1);
      cr[x] = clamp8((s32)cr[x] + ((((s32)g * L->kcb) >> 18) * (s32)room >> 8));
      cr[x + 1] = clamp8((s32)cr[x + 1] + ((((s32)g * L->kcr) >> 18) * (s32)room >> 8));
    }
  }
  sync(k, cache, p, 1);
out:
  if (row) k->release(row);
  if (acc) k->release(acc);
  if (tmp) k->release(tmp);
  if (small) k->release(small);
}

/* Entry: k = context, config = JpegEncodeMacroProcess configuration. */
void halation(const struct ctx *k, u32 *config) {
  u32 st = *k->stash, style, level, i, j, strength;
  const struct look *L;
  struct picture *seen[4];
  void *cache;
  if (!(st & STASH_VALID) || !ram(config)) return;
  style = st & 0xff; level = (st >> 8) & 0xff;
  if (style < k->first_style || style >= k->first_style + k->count || style - k->first_style >= MAX_LOOKS) return;
  if (level < 1 || level > 2) return;
  L = &k->looks[style - k->first_style];
  strength = L->strength[level - 1];
  if (!strength || L->threshold > 254) return;
  cache = k->cache();
  /* One picture per buffer (another entry with the same planes describes the whole sensor). */
  for (i = 0; i < 4; i++) {
    struct picture *p = (struct picture *)config[(0x3c >> 2) + i];
    seen[i] = 0;
    if (!ram(p) || !picture_ok(p)) continue;
    for (j = 0; j < i; j++) if (seen[j] && seen[j]->y == p->y) break;
    if (j == i) seen[i] = p;
  }
  for (i = 0; i < 4; i++) if (seen[i]) halate(k, cache, seen[i], L, strength);
}
