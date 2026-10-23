// SPDX-License-Identifier: GPL-2.0-only
/**
 * Date imprint and its camera-menu entry (`src/fw/aspect/datestamp.ts`, `datestamp-menu.ts`).
 * Needs the official firmware in testdata/private for the build tests (skipped without it). What
 * the new code does when it runs is checked in an emulator by `tools/datestamp/menu_check.py`
 * (menu), `tools/datestamp/render_check.py` (imprint) and `tools/datestamp/orient_check.py` (imprint
 * on photos taken with the camera held upright or upside down; unchanged for level shots).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { Engine, fw } from '../src';

const P = new URL('../testdata/private/', import.meta.url).pathname;
const have = existsSync(P + 'official.bin');
const { aspect } = fw;

describe('date imprint menu: data', () => {
  it('two 40x40 style icons on the menu tile', () => {
    for (const long of [false, true]) {
      const icon = aspect.drawStyleIcon(long);
      expect(icon.length).toBe(40 * 40 * 4);
      const at = (x: number, y: number): number[] => Array.from(icon.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
      expect(at(0, 0)).toEqual([255, 255, 255, 0]);
      expect(at(1, 5)).toEqual([128, 128, 128, 255]);
      expect(at(3, 3)).toEqual([53, 53, 54, 255]);
      let orange = 0;
      for (let i = 0; i < 1600; i++) if (icon[i * 4] === 255 && icon[i * 4 + 1] === 128) orange++;
      expect(orange).toBeGreaterThan(100);
    }
    expect(aspect.drawStyleIcon(false)).not.toEqual(aspect.drawStyleIcon(true));
  });
  it('setting bits', () => {
    expect(aspect.DATESTAMP_ON).toBe(1);
    expect(aspect.DATESTAMP_LONG).toBe(2);
  });
});

describe.skipIf(!have)('date imprint: firmware files', () => {
  it('builds a file with the imprint and its menu entry; the engine recognises and verifies it', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const b = await eng.buildFirmware([], [], [], { dateStamp: true });
    expect(Object.values(b.checks).every((v) => v === true)).toBe(true);
    expect(b.features).toEqual({ adjSoftFocus: false, dateStamp: true, guard: true });
    const s = await eng.inspect(b.file);
    expect(s.kind).toBe('modified');
    expect(s.verified).toBe(true);
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const data = d.subarray(rtos.offset, rtos.offset + rtos.size);
    expect(fw.readExtensionFeatures(data)).toEqual({ dateStamp: true, guard: true });
    const word = (va: number): number => new DataView(data.buffer, data.byteOffset).getUint32(va - 0x53000000, true);
    // The hooks: still-menu builder, controller factory, the two SetCurrentMenu.
    for (const at of [0x531b3ecc, 0x53185f7c, 0x531e1bd0, 0x531d5e8c, 0x537034b4]) expect(word(at) >>> 24).toBe(0xea);
    // 0.8.3: the development step's hook also leaves the orientation the EXIF writer records
    // (shooting record at r1 + 0x2D0: byte 0x71E84 if 0x71E83 is set, else 0xD8) in bits 24..25.
    const hook = word(0x539113f8);
    expect(hook >>> 24).toBe(0xea);
    const stub = 0x539113f8 + 8 + (((hook & 0xffffff) << 8) >> 6);
    const code = Array.from({ length: 32 }, (_, i) => word(stub + 4 * i));
    expect(code.slice(0, 9)).toEqual([0xe59122d0, 0xe92d0003, 0xe2820a71, 0xe5d01e83, 0xe3510000, 0x15d02e84, 0x05d220d8, 0xe3520003, 0x83a02000]);
    expect(code).toContain(0xe1800c02); // orr r0, r0, r2, lsl #24
    expect(aspect.STASH_ORIENT_SHIFT).toBe(24);
  });
  it('a test build with a fixed setting has no menu entry', async () => {
    const eng = await Engine.open(new Uint8Array(readFileSync(P + 'official.bin')));
    const b = await eng.buildFirmware([], [], [], { adjSoftFocus: true, dateStamp: true, dateStampFixed: 3 });
    const d = new fw.Firmware(b.file).decoded;
    const rtos = fw.sectionsOf(d).find((x) => x.name === 'RTOS')!;
    const data = d.subarray(rtos.offset, rtos.offset + rtos.size);
    const word = (va: number): number => new DataView(data.buffer, data.byteOffset).getUint32(va - 0x53000000, true);
    expect(word(0x531b3ecc)).toBe(0xe1a0c00d);
    expect(word(0x537034b4) >>> 24).toBe(0xea);
  });
});
