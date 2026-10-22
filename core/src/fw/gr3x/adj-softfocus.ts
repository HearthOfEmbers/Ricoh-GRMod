// SPDX-License-Identifier: GPL-2.0-only
/**
 * GR III 2.10 / IIIx 1.60: soft focus on the ADJ lever (GR IV: ../aspect/softfocus.ts).
 *
 * GR III has a flash, so GR IV's choice (the flash function 0x0A) is not free. Function 0x13,
 * "GF-2 Flash Mode" (the external flash), becomes "Soft focus" with Off / Low / Medium / High:
 * it is already in every slot's list of the ADJ mode setting menu, nothing in the ADJ controller
 * tests for it, it is not in the fixed movie layout (0xC, 1, 6, 0xF, 0xE), and its availability
 * check has Crop's body. GF-2 Flash Mode itself stays in the camera's menu (its setter has two
 * other callers); only its place on the ADJ lever is taken. The table keeps its 20 records (the
 * constructor walks exactly 0x550 bytes; GR IV froze when its table was extended).
 *
 *  - ADJ table 0x53b39a14 (20 records of 0x44 bytes): record 0x13 becomes Crop's (0x10) with
 *    four handlers of its own: draw value i, is i current, set i, count (4). The draw loop asks
 *    for every index up to the largest count of all functions (32), so indices above 3 get no text.
 *  - Name: the name lookup's case for 0x13 (0x532928b8 `moveq r0,#0x49`) gives the new text, a
 *    column added after the ratio texts in all 21 language rows.
 *  - Icon: the icon lookup's tail for 0x13 (0x53293ad0.., `sub/clz/lsr/bx`, icon 1 "GF-2")
 *    gives the new 40x40 icon (8-byte descriptor {w, h, offset/4}, as the ADJ icons have).
 *  - Value: byte 0x9a1 of the settings record (*0x55063f34): padding after SetupMovieTransmit's
 *    flag (0x9a0) and before the word SetupAutoPowerOff (0x9a4). The default builder clears the
 *    whole block, the default merge only copies flagged fields, nothing reads or writes 0x9a1..3,
 *    and the record is saved, loaded and copied to U1-U3 whole. The pointer is 0 before the
 *    settings are loaded, so every reader checks it. A byte above 3 counts as (and is reset to) off.
 *  - Pictures: the per-picture decision 0x535131c0 reads Clarity at 0x53513218 and 0x53513240
 *    (looks 11/12/17/18/19/21 and 13/15/16/22; look 14 always runs the step, look 20 decides on
 *    another field and gets no soft focus); while soft focus is on, those reads give "not
 *    neutral" (only while an ADJ slot holds soft focus). SetEffectParameter (0x5350304c) stores Clarity at 0x53503184 `strh r3,[r4,#2]`;
 *    while soft focus is on it stores 5..7 instead. The clarity function's bound (0x5367c1b0
 *    `cmp r8,#8`) becomes 11 and its row selection (0x5367c7e4) takes rows 9..11 from a table of
 *    the three soft-focus rows. Clarity itself and its table stay as they are.
 */
import { assembleWords, wordsToBytes } from '../aspect/arm';
import { softFocusRows } from '../aspect/softfocus';
import { FirmwareError } from '../types';

export const GR3X_ADJ_SOFT_FOCUS = 0x13;
export const GR3X_SETTINGS_POINTER = 0x55063f34;
export const GR3X_SOFT_FOCUS_OFFSET = 0x9a1;
const TABLE = 0x53b39a14, RECORD = 0x44, CROP = 0x10;
const H_DRAW = 0x18, H_IS_CURRENT = 0x20, H_SET = 0x28, H_COUNT = 0x30;
const OFFICIAL_0X13: readonly (readonly [number, number])[] = [[0x10, 0x531a0448], [0x18, 0x531a3638], [0x20, 0x531a1490],
  [0x28, 0x531a0ee0], [0x30, 0x5319feec], [0x3c, 0x531a4d74]];
const CROP_HANDLERS: readonly (readonly [number, number])[] = [[0x10, 0x5319fe80], [0x18, 0x531a3468], [0x20, 0x531a1250],
  [0x28, 0x531a0e08], [0x30, 0x5319fea8], [0x3c, 0x531a4d68]];
const LIST_ITEM = 0x53394758, ITEM_SET_TEXT = 0x533a1808;
const VALUE_TEXTS = [2, 9, 10, 11];
const NAME_SITE = 0x532928b8, ICON_TAIL = 0x53293ad0;
const GATES = [0x53513218, 0x53513240];
const PARAM_STORE = 0x53503184, BOUND = 0x5367c1b0, ROW = 0x5367c7e4;

export interface Gr3xSoftFocusProgram {
  code(source: string): number;
  append(bytes: Uint8Array): number;
  patch(address: number, expected: number, replacement: number, reason: string): void;
  word(address: number): number;
}

const lo = (v: number) => v & 0xffff, hi = (v: number) => v >>> 16;
const ptr = (r: string) => `movw ${r},#${lo(GR3X_SETTINGS_POINTER)};movt ${r},#${hi(GR3X_SETTINGS_POINTER)};ldr ${r},[${r}];`;
const one = (source: string, at: number): number => {
  const w = assembleWords(source, at);
  if (w.length !== 1) throw new FirmwareError('internal', 'one instruction expected');
  return w[0];
};
const bl = (at: number, target: number) => (0xeb000000 | (((target - (at + 8)) >> 2) & 0xffffff)) >>> 0;
const b = (at: number, target: number) => (0xea000000 | (((target - (at + 8)) >> 2) & 0xffffff)) >>> 0;

export function installGr3xAdjSoftFocus(p: Gr3xSoftFocusProgram, textId: number, iconId: number) {
  const record = TABLE + GR3X_ADJ_SOFT_FOCUS * RECORD, crop = TABLE + CROP * RECORD;
  for (const [off, v] of OFFICIAL_0X13) if (p.word(record + off) !== v) throw new FirmwareError('unexpected-layout', 'IIIx ADJ record 0x13');
  for (const [off, v] of CROP_HANDLERS) if (p.word(crop + off) !== v) throw new FirmwareError('unexpected-layout', 'IIIx ADJ Crop record');
  const O = GR3X_SOFT_FOCUS_OFFSET;
  // --- the four handlers (this = r0, value index = r1)
  const draw = p.code(`push {r4,r5,r6,lr};mov r5,r0;mov r4,r1;mov r6,#0;
    cmp r4,#3;bhi item;cmp r4,#0;moveq r6,#${VALUE_TEXTS[0]};addne r6,r4,#${VALUE_TEXTS[1] - 1};
    item:ldr r0,[r5,#0x1f0];uxtb r1,r4;bl #${LIST_ITEM};
    mov r1,r6;pop {r4,r5,r6,lr};b #${ITEM_SET_TEXT};`);
  // Exactly one value must be current, or the list keeps a stale cursor (GR IV: the camera froze).
  const isCurrent = p.code(`${ptr('r3')}cmp r3,#0;moveq r2,#0;beq compare;
    ldrb r2,[r3,#${O}];cmp r2,#3;movhi r2,#0;strbhi r2,[r3,#${O}];
    compare:cmp r2,r1;moveq r0,#1;movne r0,#0;bx lr;`);
  const set = p.code(`cmp r1,#3;bxhi lr;${ptr('r2')}cmp r2,#0;strbne r1,[r2,#${O}];bx lr;`);
  const count = p.code('mov r0,#4;bx lr;');
  // --- record 0x13: Crop's record with these handlers, in place
  const handlers = new Map([[H_DRAW, draw], [H_IS_CURRENT, isCurrent], [H_SET, set], [H_COUNT, count]]);
  for (let off = 0; off < RECORD; off += 4) {
    const want = handlers.get(off) ?? p.word(crop + off), have = p.word(record + off);
    if (want !== have) p.patch(record + off, have, want, 'ADJ soft focus: record of function 0x13');
  }
  // --- name and icon of function 0x13
  p.patch(NAME_SITE, 0x03a00049, one(`movweq r0,#${textId}`, NAME_SITE), 'ADJ soft focus: name');
  const tail = assembleWords(`cmp r1,#0x13;movweq r0,#${iconId};movne r0,#0;bx lr`, ICON_TAIL);
  [0xe2410013, 0xe16f0f10, 0xe1a002a0, 0xe12fff1e].forEach((w, i) => p.patch(ICON_TAIL + i * 4, w, tail[i], 'ADJ soft focus: icon'));
  // --- pictures. The level counts only while one of the five ADJ slots holds soft focus
  // (bytes 0x918 + 2i): taken off the lever, it cannot stay on unseen. Returns it in r2;
  // every other register is kept (flags are not).
  const level = p.code(`push {r0,r1,r3,lr};${ptr('r0')}mov r2,#0;cmp r0,#0;beq done;
    ldrb r1,[r0,#${O}];cmp r1,#3;bhi done;` +
    [0x918, 0x91a, 0x91c, 0x91e, 0x920].map(f => `ldrb r3,[r0,#${f}];cmp r3,#${GR3X_ADJ_SOFT_FOCUS};beq on;`).join('') +
    `b done;on:mov r2,r1;done:pop {r0,r1,r3,pc};`);
  const gates = GATES.map(site => {
    const at = p.code(`ldrb r3,[r1,#0x794];push {lr};bl #${level};pop {lr};
      sub r2,r2,#1;cmp r2,#2;movls r3,#9;b #${site + 4};`);
    if (p.word(site + 4) !== 0xe5d12793) throw new FirmwareError('unexpected-instruction', 'IIIx clarity gate'); // ldrb r2,[r1,#0x793]: r2 is free
    p.patch(site, 0xe5d13794, b(site, at), 'ADJ soft focus: run the digital-filter step');
    return at;
  });
  const param = p.code(`strh r3,[r4,#2];push {lr};bl #${level};pop {lr};
    cmp r2,#0;bxeq lr;add r2,r2,#4;strh r2,[r4,#2];bx lr;`);
  p.patch(PARAM_STORE, 0xe1c430b2, bl(PARAM_STORE, param), 'ADJ soft focus: clarity parameter');
  p.patch(BOUND, 0xe3580008, 0xe358000b, 'ADJ soft focus: clarity rows up to 11');
  const rows = p.append(softFocusRows());
  const row = p.code(`cmp r8,#8;bhi soft;mul r8,r3,r8;add r8,r8,r1;bx lr;
    soft:sub r8,r8,#9;mul r8,r3,r8;movw ip,#${lo(rows)};movt ip,#${hi(rows)};add r8,r8,ip;bx lr;`);
  p.patch(ROW, 0xe0281893, bl(ROW, row), 'ADJ soft focus: clarity row');
  void wordsToBytes;
  return { softFocusLevel: level, softFocusDraw: draw, softFocusIsCurrent: isCurrent, softFocusSet: set, softFocusCount: count,
    softFocusGates: gates, softFocusParam: param, softFocusRows: rows, softFocusRow: row, softFocusText: textId, softFocusIcon: iconId };
}
