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
    // 0.8.3: the camera's direction at the start of each exposure (SetShootingInfoResultBeforeExpose)
    // and, in RAW development, the developed record's orientation go to ORIENT_WORD.
    const target = (at: number): number => at + 8 + (((word(at) & 0xffffff) << 8) >> 6);
    expect(word(0x53628cd8) >>> 24).toBe(0xea);
    const exposure = Array.from({ length: 40 }, (_, i) => word(target(0x53628cd8) + 4 * i));
    expect(exposure).toContain(0xe5900518); // ldr r0, [r0, #0x518]
    expect(exposure).toContain(0xe5d000d8); // ldrb r0, [r0, #0xd8]
    expect(exposure).toContain(0xe1a0c00d); // mov ip, sp (after the registers are back)
    expect(word(0x539113f8) >>> 24).toBe(0xea);
    const dev = Array.from({ length: 40 }, (_, i) => word(target(0x539113f8) + 4 * i));
    expect(dev.slice(0, 5)).toEqual([0xe59122d0, 0xe92d0003, 0xe5d102ac, 0xe3500000, 0x1a00000a]); // only when r1 + 0x2ac is 0
    expect(dev).not.toContain(0xe1800c02); // the look word has no orientation bits any more
    expect([aspect.ORIENT_WORD, aspect.ORIENT_VALID]).toEqual([0x558372f4, 0x100]);
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
