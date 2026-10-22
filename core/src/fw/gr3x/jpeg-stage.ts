// SPDX-License-Identifier: GPL-2.0-only
/** GR III 2.10 / IIIx 1.60: the still pipeline's JPEG encode step, where GR Mod's picture modules
 * run on the finished YCbCr pictures before compression (GR IV: halation.ts, datestamp.ts).
 *
 * JpegEncodeMacroProcess::Execute is 0x535047d4 (its constructor 0x535049d8 names the class and
 * installs vtable 0x53c629e8; the body matches GR IV's 0x537034b4 instruction for instruction:
 * configuration = [r1+8], pictures at configuration+0x3c..+0x48). Its first word `mov ip,sp`
 * becomes a branch to a chain of stubs, each calling one position-independent module (the GR IV
 * builds of tools/halation/halation.c and tools/datestamp/datestamp.c, unchanged: every firmware
 * address reaches them through their context) and then the next stub, the last one carrying on
 * with Execute. Order as on GR IV: halation, then the date.
 *
 * Halation needs to know the picture's look: the development step that reads the frame's look
 * (0x536db7d8, read at 0x536db7f8, already an adapter of image-control.ts) also stores
 * `look | level << 8 | 0x10000` in the stash word; the level of each film is fixed in the build
 * (GR III has no spare parameter for a per-film slider).
 *
 * The date-imprint module is installed here only in its diagnostic form for now (test builds:
 * its setting points at a constant "on", so it prints the encoder's picture descriptors on every
 * JPEG and, if it accepts the pictures, the date). Pictures it or the halation do not recognise
 * (another format, odd sizes) are left alone, so a wrong guess about GR III's pictures costs the
 * effect, not the photo.
 */
import { FirmwareError } from '../types';
import { branchWord, wordsToBytes } from '../aspect/arm';
import { halationLut, halationModule, paramBytes } from '../aspect/halation';
import type { HalationLight } from '../aspect/halation';
import { GR3X_DATESTAMP_DIAG_CODE } from './datestamp-diag';

export const GR3X_JPEG_EXECUTE = 0x535047d4;
export const GR3X_DEVELOP_LOOK_READ = 0x536db7f8;
export const GR3X_FIRST_FILM = 64;
/** Second word of the 12 bytes between the zero-filled data and the heap (the first is the
 * own-parameters table pointer, the third is kept for the power-off picture setting). */
export const GR3X_HALATION_STASH = 0x55804378;
export const GR3X_MATRIX_CALL = 0x536df3e8;
export const GR3X_MATRIX_PROCESS = 0x536deecc;

const CACHE = 0x536bbc30;
const CACHE_FLUSH_FOR_READ = 0x536bbcc0;
const CACHE_CLEAN = 0x536bbcac;
const HEAP_ALLOC = 0x536af2a8;
const HEAP_FREE = 0x536af2e4;
const PLATFORM = 0x536bd838;
const GET_TIME = 0x536b6510;
const GUARDS: readonly (readonly [number, number])[] = [
  [GR3X_JPEG_EXECUTE, 0xe1a0c00d], [GR3X_JPEG_EXECUTE + 4, 0xe92ddff0], [GR3X_JPEG_EXECUTE + 0x18, 0xe5914008],
  [CACHE, 0xe30d01b4], [CACHE_FLUSH_FOR_READ, 0xe1a0c00d], [CACHE_CLEAN, 0xe1a00001],
  [HEAP_ALLOC, 0xe1a0c00d], [HEAP_FREE, 0xe1a0c00d], [PLATFORM, 0xe1a0c00d], [GET_TIME, 0xe5d0300c],
  [GR3X_MATRIX_CALL, 0xebfffeb7],
];
const HALATION_MAGIC = 0x324c4148; // 'HAL2', as GR IV

export interface Gr3xJpegProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  u32(address: number): number;
}
export interface Gr3xJpegOptions {
  /** Per film (looks 64..72): level 0 off, 1 weak, 2 strong, and the film's light (halationLight). */
  halation?: { levels: readonly number[]; light: readonly HalationLight[] };
  diagnostics?: boolean;
}

const u32le = (words: readonly number[]) => wordsToBytes(words.map(w => w >>> 0));
const addr = (r: string, a: number) => `movw ${r},#${a & 65535};movt ${r},#${a >>> 16};`;

export function installGr3xJpegStage(p: Gr3xJpegProgram, o: Gr3xJpegOptions) {
  if (!o.halation && !o.diagnostics) return undefined;
  for (const [at, word] of GUARDS) if (p.u32(at) !== word) throw new FirmwareError('unexpected-instruction', `IIIx JPEG stage guard at ${at.toString(16)}`);
  // Built back to front: each stub ends by entering the next one (or Execute itself).
  let tail = `mov ip,sp;b #${GR3X_JPEG_EXECUTE + 4};`, first = 0;
  const entries: Record<string, number> = {};
  if (o.diagnostics) {
    const on = p.append(Uint8Array.of(1, 0, 0, 0));
    const ctx = p.append(u32le([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, PLATFORM, GET_TIME, on]));
    // GR III's own diagnostic build: it only draws into planes above the RTOS data and heaps
    // whose CbCr plane has the rows it draws (tools/gr3x/compile_diag.py).
    const module = p.append(Uint8Array.from(atob(GR3X_DATESTAMP_DIAG_CODE), c => c.charCodeAt(0)));
    const stub = p.code(`push {r0-r3,ip,lr};ldr r1,[r1,#8];${addr('r0', ctx)}bl #${module};pop {r0-r3,ip,lr};${tail}`);
    entries.dateDiagnostics = stub; entries.dateModule = module;
    tail = `b #${stub};`; first = stub;
  }
  if (o.halation) {
    const { levels, light } = o.halation;
    if (levels.length !== 9 || light.length !== 9 || levels.some(l => ![0, 1, 2].includes(l)))
      throw new FirmwareError('bad-edit', 'IIIx halation: nine film levels');
    if (light.some(l => !(l.threshold >= 0 && l.threshold <= 254 && l.escale >= 1 && l.escale <= 16384)))
      throw new FirmwareError('internal', 'IIIx halation: light of the films');
    const mask = levels.reduce((m, l, k) => (l > 0 ? m | (1 << k) : m), 0);
    const lut = p.append(halationLut());
    const ctx = p.append(new Uint8Array([
      ...u32le([CACHE, CACHE_FLUSH_FOR_READ, CACHE_CLEAN, HEAP_ALLOC, HEAP_FREE, GR3X_HALATION_STASH, GR3X_FIRST_FILM, 9, mask, lut]),
      ...paramBytes(),
      ...u32le([HALATION_MAGIC, ...light.map(l => (l.threshold | (l.escale << 16)) >>> 0)]),
    ]));
    const module = p.append(halationModule());
    const stub = p.code(`push {r0-r3,ip,lr};ldr r1,[r1,#8];${addr('r0', ctx)}bl #${module};pop {r0-r3,ip,lr};${tail}`);
    entries.halation = stub; entries.halationModule = module; entries.halationContext = ctx;
    tail = `b #${stub};`; first = stub;
  }
  p.patch(GR3X_JPEG_EXECUTE, 0xe1a0c00d, branchWord(GR3X_JPEG_EXECUTE, first), 'JPEG encode step: GR Mod picture modules');
  return entries;
}
