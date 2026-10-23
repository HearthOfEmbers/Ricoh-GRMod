// SPDX-License-Identifier: GPL-2.0-only
/**
 * Direct Flash, a fifth Flash Mode (`src/fw/aspect/directflash.ts`). Needs the official firmware in
 * testdata/private for the build tests (skipped without it). What the new code does when it runs is
 * checked in an emulator by `tools/directflash/check.py`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';
import { DIRECTFLASH_SOURCE_SHA256 } from '../src/fw/aspect/directflash-code';
import { createHash } from 'node:crypto';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

describe('Direct Flash: data', () => {
  it('has a name in all 21 languages and a 40x40 icon like the camera\'s Flash Mode icons', () => {
    expect(aspect.DIRECT_FLASH_NAMES.length).toBe(21);
    expect(aspect.DIRECT_FLASH_NAMES[15]).toBe('直闪模式');
    expect(aspect.DIRECT_FLASH_NAMES[2]).toBe('Direct Flash');
    const icon = aspect.drawDirectFlashIcon();
    expect(icon.length).toBe(40 * 40 * 4);
    const at = (x: number, y: number): number[] => Array.from(icon.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
    expect(at(0, 0)).toEqual([255, 255, 255, 0]);
    expect(at(10, 2)).toEqual([255, 255, 255, 255]);
    expect(at(9, 2)).toEqual([0, 0, 0, 255]);
  });
  it('keeps its settings in padding next to each other, apart from soft focus and the date imprint', () => {
    expect(aspect.DIRECT_FLASH_BYTE).toBe(0x55084dd8 + 4 + 0x99b);
    expect(aspect.DIRECT_FLASH_GN_BYTE).toBe(0x55084dd8 + 4 + 0x99a);
    expect([aspect.SOFT_FOCUS_BYTE, aspect.DATESTAMP_BYTE]).not.toContain(aspect.DIRECT_FLASH_BYTE);
    expect(aspect.DIRECT_FLASH_GUIDE_NUMBERS[0]).toBe(3);
    expect(new Float32Array(new Uint32Array([aspect.guideNumberWord(3)]).buffer)[0]).toBeCloseTo(2 * Math.log2(3), 6);
  });
  it('the compiled module is the one of the committed source', () => {
    const src = readFileSync(new URL('../../tools/directflash/directflash.c', import.meta.url));
    expect(createHash('sha256').update(src).digest('hex')).toBe(DIRECTFLASH_SOURCE_SHA256);
  });
});

describe.skipIf(!have)('Direct Flash: firmware files', () => {
  let eng: Engine;
  it('builds a file with Direct Flash only; the engine recognises and verifies it', async () => {
    eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const b = await eng.buildFirmware([], [], [], { directFlash: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features).toEqual({ adjSoftFocus: false, guard: true, directFlash: true });
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    expect(s.directFlash).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    expect(fw.readExtensionFeatures(d.subarray(rtos.offset, rtos.offset + rtos.size))).toEqual({ guard: true, directFlash: true });
  });
  it('combines with soft focus, the date imprint and ratios (the date imprint copies the list table after it)', async () => {
    const b = await eng.buildFirmware([], [{ name: 'XPan', ratio: '65:24' }], [], { directFlash: true, adjSoftFocus: true, dateStamp: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    const s = await eng.inspect(b.file);
    expect(s.verified).toBe(true);
    expect(s.directFlash && s.adjSoftFocus && s.dateStamp).toBe(true);
    // The relocated list table's Flash Mode records (11, 12) carry the Direct Flash count handlers.
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const img = d.subarray(rtos.offset, rtos.offset + rtos.size);
    const word = (va: number): number => new DataView(img.buffer, img.byteOffset).getUint32(va - 0x53000000, true);
    const movwt = (lo: number, hi: number): number => {
      const a = word(lo); const b = word(hi);
      return ((((b >> 4) & 0xf000) | (b & 0xfff)) << 16 | (((a >> 4) & 0xf000) | (a & 0xfff))) >>> 0;
    };
    const table = movwt(0x531d6868, 0x531d6878); // the list table's address (one of its 16 users)
    expect(table).toBeGreaterThan(0x53000000 + aspect.OFFICIAL_RTOS_LENGTH);
    for (const [rec, n] of [[11, 4], [12, 2]] as const) {
      const count = word(table + rec * 0x4c + 0x0c);
      expect(count).toBeGreaterThan(0x53000000 + aspect.OFFICIAL_RTOS_LENGTH);
      expect(word(count)).toBe((0xe3a00000 | n) >>> 0); // mov r0, #n
      expect(word(count + 4)).toBe(0xe2800001); // add r0, r0, #1
    }
  });
});
