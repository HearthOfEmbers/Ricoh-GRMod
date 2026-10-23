/* SPDX-License-Identifier: GPL-2.0-only
 *
 * GR Mod: Direct Flash ("直闪模式") for the Ricoh GR IV (firmware 1.11).
 *
 * Flash at a fixed power; the exposure is planned from the subject distance and the flash's guide
 * number, in the way of the GR III's GF-2 Flash Mode (its behaviour as Ricoh describes it, not
 * its code): f-number = GN x sqrt(ISO / 100) / distance.
 *
 * `df_plan(ae, ctx)` runs right after the camera's own still exposure for flash pictures
 * (0x5367A7B4, called from 0x5367AAA8) and replaces its result when Direct Flash applies. `ae` is
 * that function's object: ae + 0x28 is the exposure record, ae + 4 the flash program diagram
 * whose word at + 4 is the object the flash-sync limit (0x536792E0) takes.
 *
 * Exposure record fields, as the camera's own code uses them (APEX values in float):
 *   0x10 / 0x14   Sv upper / lower limit of the camera   0x64  Ev of the scene at ISO 100
 *   0x39 (u8)     exposure program: 0 P, 1 Tv, 2 Av, 3 M with ISO Auto, 4 M, 5 / 6 bulb / time
 *   0x3E (u16)    flash kind: 0 none detected, 1..4 flashes that communicate (P-TTL), 0x10 GF-2
 *   0x40 (u16)    exposure mode setting: 7 Snap Distance Priority
 *   0x70 / 0x74   Tv upper / lower limit                 0x9C (u8)  ISO Auto
 *   0xA0 / 0xA4   ISO Auto range (Sv)                    0x10C      the fixed ISO (Sv)
 *   0xEC / 0xF0   Av lower / upper limit                 0x55D (u8) ND setting: 0 auto, 1 on, 2 off
 *                                                                  (the camera sets 2 on the HDF model)
 *   results: 0xD0 Tv, 0xD4 Av, 0xD8 Sv, 0x560 (u8) ND in      0x584 (u32) subject distance in mm
 *
 * Hard-float ABI (VFPv3), position independent, no global data, no library calls.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

struct ctx {
  const volatile u8 *direct;        /* setting byte: 1 = Direct Flash chosen (with Flash On) */
  const volatile u8 *flash_mode;    /* live Flash Mode: 0 Flash On */
  const volatile u8 *flash_output;  /* Flash Output setting: 0 Auto, 1 1/1, 2 1/4 */
  float (*sync_tv)(void *apex, u32 flag, float av); /* 0x536792E0: fastest Tv the flash syncs with */
  const volatile u8 *gn_choice;     /* setting byte: which guide number (0 = the GF-2's); for a
                                     * camera-menu choice of the guide number */
  const float *gn_table;            /* per choice: 2 log2(GN), GN at ISO 100 in metres, full power */
  u32 gn_count;                     /* entries in gn_table (at least 1); a choice beyond is 0 */
};

#define F(o) (*(volatile float *)(info + (o)))
#define B(o) (*(volatile u8 *)(info + (o)))
#define H(o) (*(volatile u16 *)(info + (o)))
#define W(o) (*(volatile u32 *)(info + (o)))

#define AV_F28 2.9708536f   /* f/2.8 */
#define AV_F16 8.0f         /* f/16 */
#define TV_SLOWEST 5.0f     /* 1/32 s: no slower than this for a flash picture */

/* log2(x) for x > 0, to well within 1/100 EV. */
static float log2_(float x)
{
  union { float f; u32 u; } v;
  float m, t, t2, s;
  int e;
  v.f = x;
  e = (int)((v.u >> 23) & 255) - 127;
  v.u = (v.u & 0x7fffffu) | 0x3f800000u; /* 1 <= m < 2 */
  m = v.f;
  t = (m - 1.0f) / (m + 1.0f);
  t2 = t * t;
  s = t * (1.0f + t2 * (1.0f / 3 + t2 * (1.0f / 5 + t2 * (1.0f / 7 + t2 * (1.0f / 9)))));
  return (float)e + s * 2.8853900817779268f; /* 2 / ln 2 */
}

static float clamp(float v, float lo, float hi)
{
  if (v < lo) v = lo;
  if (v > hi) v = hi;
  return v;
}

struct plan {
  float tv, av, sv;
  float flash_err; /* EV the subject is lit above (+) or below (-) a correct exposure */
  float amb_err;   /* EV the ambient light is above a correct exposure at the chosen Tv */
};

struct limits {
  float sv_lo, sv_hi, av_lo, av_hi, tv_lo, tv_hi, ev;
  void *apex;
  const struct ctx *k;
};

/* f0: the Av that gives a correct flash exposure at ISO 100 without ND. */
static void solve(const struct limits *l, float f0, int nd, struct plan *p)
{
  float f = f0 - 2.0f * (float)nd; /* the ND takes two stops of the flash too */
  float sv = clamp(l->av_lo - f + 5.0f, l->sv_lo, l->sv_hi);
  float need = f + sv - 5.0f;
  float av = clamp(need, l->av_lo, l->av_hi);
  float tv_hi = l->k->sync_tv(l->apex, 1, av);
  float amb, tv;
  if (tv_hi > l->tv_hi) tv_hi = l->tv_hi;
  amb = l->ev + sv - 5.0f - 2.0f * (float)nd - av;
  tv = amb;
  if (tv < l->tv_lo) tv = l->tv_lo;
  if (tv > tv_hi) tv = tv_hi;
  p->tv = tv;
  p->av = av;
  p->sv = sv;
  p->flash_err = need - av;
  p->amb_err = amb - tv;
}

static float worst(const struct plan *p)
{
  float a = p->flash_err < 0 ? -p->flash_err : p->flash_err;
  return p->amb_err > a ? p->amb_err : a;
}

void df_plan(u8 *ae, const struct ctx *k)
{
  u8 *info;
  void *apex;
  struct limits l;
  struct plan p, q;
  u32 mm, kind, nd_mode, i;
  float f0, a, b;
  int nd;

  if (*k->direct != 1 || *k->flash_mode != 0) return;
  info = *(u8 **)(ae + 0x28);
  if (!info || !*(u8 **)(ae + 4)) return;
  apex = *(void **)(*(u8 **)(ae + 4) + 4);
  if (!apex) return;
  if (B(0x39) > 4) return;          /* bulb, time */
  if (H(0x40) == 7) return;         /* Snap Distance Priority */
  kind = H(0x3e);
  if (kind >= 1 && kind <= 4) return; /* a P-TTL flash: Flash On as it is */
  mm = W(0x584);
  if (mm == 0) return;              /* no distance */
  if (mm < 100) mm = 100;
  if (mm > 8000) mm = 8000;          /* as the camera's own use of it */

  i = *k->gn_choice;
  if (i >= k->gn_count) i = 0;
  f0 = k->gn_table[i] - 2.0f * (log2_((float)mm) - 9.965784284662087f); /* - 2 log2(mm / 1000) */
  if (*k->flash_output == 2) f0 -= 2.0f; /* 1/4 power */

  l.k = k;
  l.apex = apex;
  l.ev = F(0x64);
  l.sv_lo = F(0x14);
  l.sv_hi = F(0x10);
  if (B(0x9c)) {
    a = F(0xa0);
    b = F(0xa4);
    if (a > b) { float t = a; a = b; b = t; }
    if (a > l.sv_lo) l.sv_lo = a;
    if (b < l.sv_hi) l.sv_hi = b;
    if (l.sv_lo > l.sv_hi) l.sv_hi = l.sv_lo;
  } else {
    l.sv_lo = l.sv_hi = clamp(F(0x10c), l.sv_lo, l.sv_hi);
  }
  l.av_lo = F(0xec);
  l.av_hi = F(0xf0);
  if (l.av_lo < AV_F28) l.av_lo = AV_F28;
  if (l.av_hi > AV_F16) l.av_hi = AV_F16;
  if (l.av_lo > l.av_hi) l.av_lo = l.av_hi;
  l.tv_lo = F(0x74);
  l.tv_hi = F(0x70);
  if (l.tv_lo < TV_SLOWEST) l.tv_lo = TV_SLOWEST;
  if (l.tv_lo > l.tv_hi) l.tv_lo = l.tv_hi;

  nd_mode = B(0x55d);
  nd = nd_mode == 1;
  solve(&l, f0, nd, &p);
  if (nd_mode == 0 && (p.flash_err >= 1.0f || p.amb_err >= 1.0f)) {
    /* ND Auto: put the ND in when the subject is too close for f/16 at the lowest ISO, or the
     * scene too bright for the fastest shutter speed the flash syncs with, and it helps. */
    solve(&l, f0, 1, &q);
    if (q.flash_err > -1.0f && worst(&q) < worst(&p) - 0.5f) {
      p = q;
      nd = 1;
    }
  }
  F(0xd0) = p.tv;
  F(0xd4) = p.av;
  F(0xd8) = p.sv;
  B(0x560) = (u8)nd;
}
