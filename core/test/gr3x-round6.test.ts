// SPDX-License-Identifier: GPL-2.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/app/engine';
import { GR3X_T4_CUSTOM } from '../src/fw/gr3x/geometry';
import { buildGr3xAdjResearch } from '../src/fw/gr3x/adj';
import { buildGr3xTestFirmware } from '../src/fw/gr3x/research-package';
import { GR3X_DATE_MENU_ID, GR3X_DATE_STYLE_ID, GR3X_DATE_SWITCH_ID } from '../src/fw/gr3x/datestamp';

const input = process.env.GRMOD_GR3_FIRMWARE;
const ratios = GR3X_T4_CUSTOM.map(r => ({ ratio: r.ratio, name: r.name! }));

describe.skipIf(!input)('GR III round 6: date imprint menu as GR IV', () => {
  let raw: Uint8Array, engine: Engine;
  beforeAll(async () => { raw = new Uint8Array(readFileSync(input!)); engine = await Engine.open(raw); });
  it('builds the submenu form with its five texts and recognises both forms', async () => {
    const sub = await buildGr3xAdjResearch(raw, undefined, { dateImprint: true, dateMenu: 'submenu' });
    expect(sub.dateImprint).toMatchObject({ name: 793, short: 794, long: 795, onOff: 796, style: 797, form: 'submenu' });
    expect(sub.entries).toHaveProperty('submenuTable');
    const reasons = sub.sites.map(s => s.reason);
    expect(reasons.filter(r => r.startsWith('added menus: submenu records')).length).toBe(10);
    const list = await buildGr3xAdjResearch(raw, undefined, { dateImprint: true });
    expect(list.dateImprint).toMatchObject({ form: 'list' });
    expect(list.entries).not.toHaveProperty('submenuTable');
    expect([GR3X_DATE_MENU_ID, GR3X_DATE_SWITCH_ID, GR3X_DATE_STYLE_ID]).toEqual([0x020001a0, 0x020001a1, 0x020001a2]);
    // The app builds the submenu form; a round-4 file (list) is still recognised.
    const built = await engine.buildFirmware([], ratios, [], { dateStamp: true });
    expect(await (await Engine.open(raw)).inspect(built.file)).toMatchObject({ verified: true, dateStamp: true });
    const old = await buildGr3xTestFirmware(raw, [], undefined, undefined, { dateImprint: true });
    expect(await (await Engine.open(raw)).inspect(old.bytes)).toMatchObject({ verified: true, dateStamp: true });
    expect(old.report.outputSha256).not.toBe(built.sha256);
  }, 300000);
});
