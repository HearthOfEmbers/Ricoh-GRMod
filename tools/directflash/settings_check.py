# SPDX-License-Identifier: GPL-2.0-only
"""Emulator checks of Direct Flash's settings in the camera menu (core/src/fw/aspect/directflash-menu.ts).

NOT part of the program. Runs the firmware's own functions, as patched, in Unicorn, next to the
official ones (the harness of tools/datestamp/menu_check.py):

 1. The controller factory gives the list controller (Horizon Correction's) for the three new ids,
    and every other id what it gives officially; SelectMenuController::SetCurrentMenu maps the new
    ids to the new records and every official id (and the date imprint's) as before.
 2. Flash Mode's submenu (record 5, in the table where it is now): five lines, the camera's two
    unchanged, then the three new texts, ids, value-icon places (540) and value-draw functions;
    every other field as officially.
 3. Every handler for every value of its field, with the other bits of the byte random: list count,
    row draw (icon and text of each value), is-current (exactly one value, the fallback for a field
    no value has), set (only its field changes), the submenu line's value icon.
 4. SelectMenuController's list building on the three records (rows, one marked current, cursor)
    and SubMenuController's drawing of record 5 (five lines: texts, value icons), placed as the
    camera's own five-line submenu (record 10, ADJ settings).
 5. The list constructor's scan still ends after the 124 official records with the same result.
 6. Texts (line names in 21 languages, value names), every official text kept in the widened
    language rows, icons (catalog, bounds) and a picture of all icons (ICONS.png).
 7. The settings guard keeps bytes 0x99A and 0x99B.

    python3 settings_check.py BUILT-RTOS OFFICIAL-RTOS [ICONS.png|-] [EARLIER-BUILT-RTOS]

EARLIER-BUILT-RTOS: a build of the same project without these lines (test 055): every text it has
is still there.
"""
import random
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'datestamp'))
import menu_check as dm  # noqa: E402
from menu_check import Image, Emu, factory_class, set_current, views, text  # noqa: E402

failures = dm.failures
check = dm.check
BASE = 0x53000000
OFFICIAL_LEN = 0x13d2ac0
CURRENT = 0x55084dd8
BYTE = CURRENT + 4 + 0x99b
GN_BYTE = CURRENT + 4 + 0x99a
IDS = [0x020001b0, 0x020001b1, 0x020001b2]
T0 = 910
I0 = 663
GNS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 25, 28, 32, 36]
THIRDS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
SLOWEST = [('1/125', 7), ('1/60', 6), ('1/30', 0), ('1/15', 1), ('1/8', 2), ('1/4', 3), ('1/2', 4), ('1"', 5)]
# (byte, shift, mask, codes, names)
LISTS = [
    (GN_BYTE, 0, 0xff, [0 if g == 3 else g for g in GNS], [f'GN {g}' for g in GNS]),
    (BYTE, 1, 15, [0 if k == 3 else k for k in THIRDS], [f'-{k / 3:.1f} EV' for k in THIRDS]),
    (BYTE, 5, 7, [c for _, c in SLOWEST], [n for n, _ in SLOWEST]),
]
FIRST_TEXT = [T0 + 3, T0 + 3 + 21, T0 + 3 + 30]
FIRST_ICON = [I0, I0 + 21, I0 + 30]
NAMES = {  # language row -> the three line names (rows as the program indexes languages)
    1: ['Direct Flash GN', 'Direct Flash Background', 'Direct Flash Min Shutter'],
    0: ['ダイレクト GN', 'ダイレクト 背景明るさ', 'ダイレクト 低速限界'],
    19: ['直闪 GN', '直闪背景亮度', '直闪最低快门'],
    18: ['直閃 GN', '直閃背景亮度', '直閃最低快門'],
}
SUB_SITES = [(0x531e2064, 0x531e206c), (0x531e20cc, 0x531e20d4), (0x531e2438, 0x531e2444), (0x531e2668, 0x531e266c), (0x531e2734, 0x531e2740)]
SEL_SITE = (0x531d6d54, 0x531d6d64)


def tables(new):
    return new.movw_movt(*SUB_SITES[0]), new.movw_movt(*SEL_SITE)


def field(raw, shift, mask):
    return (raw >> shift) & mask


def expected_index(raw, shift, mask, codes):
    f = field(raw, shift, mask)
    return codes.index(f) if f in codes else codes.index(0)


def check_factory_current(new, off):
    lst = factory_class(off, 0x02000094)
    for cid in IDS:
        check(factory_class(new, cid) == lst, f'factory: {cid:#x} is not the list controller')
    for cid in (0x020001af, 0x020001b3, 0x020001b4):
        check(factory_class(new, cid) == factory_class(off, cid), f'factory: {cid:#x} (not ours) changed')
    dm.check_set_current(new, off)
    recs = [set_current(new, 0x531d5e8c, 0x1a4, cid) for cid in IDS]
    check(recs == [128, 129, 130], f'list SetCurrentMenu of the new ids: {recs}')
    for cid in (0x020001af, 0x020001b3):
        check(set_current(new, 0x531d5e8c, 0x1a4, cid) == set_current(off, 0x531d5e8c, 0x1a4, cid), f'list SetCurrentMenu({cid:#x}) not ours')
    print('  list controller for', [hex(i) for i in IDS], '; records', recs)
    return recs


def check_submenu_record(new, off):
    st, _ = tables(new)
    r = st + 5 * 0x64
    o = 0x53da6718 + 5 * 0x64
    check(new.rd(r + 6, 1)[0] == 5, 'record 5: line count')
    check([new.u16(r + 8 + 2 * k) for k in range(6)] == [127, 137, T0, T0 + 1, T0 + 2, 0], 'record 5: line texts')
    check([new.u32(r + 0x14 + 4 * k) for k in range(5)] == [0x020000f3, 0x020000f6] + IDS, 'record 5: line ids')
    check([new.u32(r + 0x28 + 4 * k) for k in range(5)] == [540] * 5, 'record 5: value icon places')
    check(new.u32(r + 0x3c) == off.u32(o + 0x3c) and new.u32(r + 0x44) == off.u32(o + 0x44), 'record 5: the camera lines\' value draws')
    draws = [new.u32(r + 0x4c + 8 * k) for k in range(3)]
    check(all(d >= BASE + OFFICIAL_LEN for d in draws) and all(new.u32(r + 0x50 + 8 * k) == 0 for k in range(3)), 'record 5: new value draws')
    changed = set(range(6, 7)) | set(range(12, 0x14)) | set(range(0x1c, 0x28)) | set(range(0x30, 0x3c)) | set(range(0x4c, 0x64))
    diff = [hex(k) for k in range(0x64) if k not in changed and new.rd(r + k, 1) != off.rd(o + k, 1)]
    check(not diff, f'record 5: other fields changed {diff}')
    return draws


def check_handlers(new, recs, draws):
    _, lt = tables(new)
    rnd = random.Random(5)
    item = 0x70800000
    for which, ((byte, shift, mask, codes, names), rec) in enumerate(zip(LISTS, recs)):
        q = lt + rec * 0x4c
        h = {name: new.u32(q + o) for name, o in (('count', 0x0c), ('draw', 0x14), ('set', 0x24), ('current', 0x2c))}
        check(new.u16(q + 4) == T0 + which, f'list {which}: title')
        horizon = 0x53da2d20 + 45 * 0x4c
        same = [o for o in range(0, 0x4c, 4) if o not in (0x04, 0x0c, 0x14, 0x24, 0x2c)]
        check(all(new.u32(q + o) == dm.Image.u32(OFF, horizon + o) for o in same), f'list {which}: other fields differ from Horizon Correction')
        n = len(codes)
        e = Emu(new)
        check(e.call(h['count'], (0x70000000,)) == n, f'list {which}: count')
        out = []
        for i in range(n + 1):
            e.calls.clear()
            e.call(h['draw'], (0x70000000, item, i))
            out.append(e.calls[0][1:] if e.calls else None)
        want = [(item, FIRST_ICON[which] + i, FIRST_TEXT[which] + i) for i in range(n)] + [None]
        check(out == want, f'list {which}: draw {out}')
        cases = 0
        values = sorted(set(range(mask + 1)) if mask < 0xff else set(range(256)))
        for f in values:
            other = rnd.randrange(256)
            raw = (other & ~(mask << shift) & 0xff) | (f << shift)
            want_i = expected_index(raw, shift, mask, codes)
            e = Emu(new)
            e.mu.mem_write(byte, bytes([raw]))
            cur = [e.call(h['current'], (0x70000000, i)) for i in range(n)]
            check(cur == [int(i == want_i) for i in range(n)], f'list {which}, byte {raw:#x}: current {cur}')
            check(e.byte(byte) == raw, f'list {which}, byte {raw:#x}: changed by is-current')
            e.calls.clear()
            e.call(draws[which], (0x70000000, item))
            check(e.calls == [('sub-icon', item, FIRST_ICON[which] + want_i, e.calls[0][3] if e.calls else 0)], f'line {which}, byte {raw:#x}: {e.calls}')
            for i in list(range(n)) + [n]:
                e2 = Emu(new)
                e2.mu.mem_write(byte, bytes([raw]))
                e2.call(h['set'], (0x70000000, i))
                got = e2.byte(byte)
                exp = raw if i == n else (raw & ~(mask << shift) & 0xff) | (codes[i] << shift)
                check(got == exp, f'list {which} set {i}, byte {raw:#x}: {got:#x} want {exp:#x}')
                if i < n:
                    check(expected_index(got, shift, mask, codes) == i, f'list {which} set {i}: reads back as {expected_index(got, shift, mask, codes)}')
                cases += 1
        print(f'  list {which}: {n} values, {cases} set cases over {len(values)} field values')


def check_views(new, off, recs):
    for which, ((byte, shift, mask, codes, names), rec) in enumerate(zip(LISTS, recs)):
        for f in (0, codes[0], codes[-1], mask):
            raw = f << shift

            def setup(e, this, rec=rec):
                e.mu.mem_write(this + 0x198, struct.pack('<I', 0x70700000))
                e.mu.mem_write(this + 0x1a4, bytes([rec]))
                e.mu.mem_write(this + 0x124, struct.pack('<I', 0x020000f3))
                return 0x531da9d4
            e = Emu(new)
            # views() writes the date imprint's byte; write ours in its emulator through setup.
            def setup2(e, this, rec=rec, raw=raw):
                e.mu.mem_write(byte, bytes([raw]))
                return setup(e, this)
            e, seen = views(new, 0, setup2)
            items = [c for c in e.calls if c[0] == 'list-item']
            marks = [c[1] for c in seen if c[0] == hex(0x5357ad40)]
            cur = expected_index(raw, shift, mask, codes)
            check(len(items) == len(codes), f'list {which}, field {f}: {len(items)} rows drawn')
            check(marks == [int(i == cur) for i in range(len(codes))], f'list {which}, field {f}: marks {marks}')
            check(e.byte(0x70000000 + 0x1a6) == cur, f'list {which}, field {f}: cursor {e.byte(0x70000000 + 0x1a6)}')
        print(f'  list {which}: rows', [(c[2], c[3]) for c in items][:4], '...')

    def sub_setup(e, this):
        for o in (0x15c, 0x160, 0x164, 0x168, 0x16c, 0x170):
            e.mu.mem_write(this + o, struct.pack('<I', 0x70700000 + o * 0x100))
        e.mu.mem_write(this + 0x174, bytes([5]))
        e.mu.mem_write(GN_BYTE, bytes([12]))
        e.mu.mem_write(BYTE, bytes([1 | (6 << 1) | (1 << 5)]))
        return 0x531e271c
    e, seen = views(new, 0, sub_setup)
    icons = [c[2] for c in e.calls if c[0] == 'sub-icon']
    texts = [c[1] for c in seen if c[0] == hex(0x53583014)]
    titles = [c[1] for c in seen if c[0] == hex(0x5357f2b0)]
    check(texts == [127, 137, T0, T0 + 1, T0 + 2] and titles == [127], f'submenu: texts {texts} titles {titles}')
    check(icons[-3:] == [I0 + GNS.index(12), I0 + 21 + 5, I0 + 30 + 3], f'submenu: value icons {icons}')
    print('  submenu: title', titles, 'lines', texts, 'value icons', icons)
    # Placed as the camera's own five-line submenu (record 10).
    PLACE = {hex(0x535712b0), hex(0x5358304c), hex(0x53570a9c), hex(0x53582fb4), hex(0x53571788)}
    out = []
    for img, rec in ((new, 5), (off, 10)):
        def setup(e, this, rec=rec):
            for o in (0x15c, 0x160, 0x164, 0x168, 0x16c, 0x170):
                e.mu.mem_write(this + o, struct.pack('<I', 0x70700000 + o * 0x100))
            e.mu.mem_write(this + 0x174, bytes([rec]))
            return 0x531e271c
        e, seen = views(img, 0, setup)
        out.append([(c[0], c[1]) for c in seen if c[0] in PLACE])
    print('  lines shown: ours', [c for c in out[0] if c[0] == hex(0x535712b0)], 'ADJ settings', [c for c in out[1] if c[0] == hex(0x535712b0)])
    check(out[0] == out[1], 'submenu: lines placed differently from the five-line ADJ settings submenu')


def check_texts_icons(new, earlier, png):
    for row, want in NAMES.items():
        got = [text(new, row, T0 + k) for k in range(3)]
        check(got == want, f'line names, row {row}: {got}')
    for l in range(21):
        for k in range(3):
            check(text(new, l, T0 + k), f'line name {k} missing in row {l}')
        for which, (_, _, _, codes, names) in enumerate(LISTS):
            got = [text(new, l, FIRST_TEXT[which] + i) for i in range(len(codes))]
            check(got == names, f'value names {which}, row {l}: {got}')
        # Every text of a build without these lines kept in the widened rows.
        if earlier:
            lost = [t for t in range(0, 896) if text(new, l, t) != text(earlier, l, t)]
            check(not lost, f'row {l}: texts changed {lost[:5]}')
    for t in (882, 841, 853):
        check(text(new, 1, t) is not None or t == 853, f'text {t} lost')
    for low in (0x5323dbb4, 0x5323e40c):
        w = new.u32(low)
        check((((w >> 4) & 0xf000) | (w & 0xfff)) >= I0 + 37, f'icon bound at {low:#x}')
    pics = []
    for k in range(38):
        d = new.u32(dm.ICON_CATALOG + (I0 + k) * 4)
        check(d != 0 and struct.unpack('<4H', new.rd(d, 8)) == (1, 40, 40, 0), f'icon {I0 + k} descriptor')
        pics.append(d)
    print('  texts: rows 1 / 19:', [text(new, 1, T0 + k) for k in range(3)], [text(new, 19, T0 + k) for k in range(3)])
    print('  values:', [text(new, 1, FIRST_TEXT[w]) + ' .. ' + text(new, 1, FIRST_TEXT[w] + len(LISTS[w][3]) - 1) for w in range(3)])
    if png:
        render_icons(png)


def render_icons(png):
    """The icons as the build draws them (core: drawValueIcon), via the program itself."""
    import subprocess
    import json
    root = Path(__file__).resolve().parents[2]
    import tempfile
    js = (f"import {{ directFlashLists }} from '{root}/core/src/fw/aspect/directflash-menu';"
          "console.log(JSON.stringify(directFlashLists().flatMap((l) => l.icons.map((p) => Array.from(p)))));")
    with tempfile.NamedTemporaryFile('w', suffix='.ts', dir=root / 'tools' / 'directflash', delete=False) as f:
        f.write(js)
    try:
        r = subprocess.run(['npx', 'vite-node', f.name], cwd=root, capture_output=True, text=True)
    finally:
        Path(f.name).unlink()
    if r.returncode:
        print('  (icons not rendered:', r.stderr[-200:], ')')
        return
    icons = json.loads(r.stdout.strip().splitlines()[-1])
    from PIL import Image as P
    cols = 8
    sheet = P.new('RGBA', (cols * 44 * 3, ((len(icons) + cols - 1) // cols) * 44 * 3), (40, 40, 40, 255))
    for k, px in enumerate(icons):
        im = P.frombytes('RGBA', (40, 40), bytes(px)).resize((120, 120), P.NEAREST)
        sheet.paste(im, ((k % cols) * 132 + 6, (k // cols) * 132 + 6), im)
    sheet.save(png)
    print('  icons drawn to', png)


def check_guard(new):
    save = 0x533e1c04
    w = new.u32(save)
    if w >> 24 != 0xea:
        print('  no settings guard in this build')
        return
    stub = save + 8 + (((w & 0xffffff) ^ 0x800000) - 0x800000) * 4
    bls = []
    for k in range(12):
        x = new.u32(stub + 4 * k)
        if (x >> 24) == 0xeb:
            bls.append(stub + 4 * k + 8 + (((x & 0xffffff) ^ 0x800000) - 0x800000) * 4)
    fix = bls[1]
    for raw in range(256):
        e = Emu(new)
        settings = 0x70400000
        e.mu.mem_write(settings + 0x99a, bytes([raw, 255 - raw]))
        e.call(fix, (settings, 0))
        check(bytes(e.mu.mem_read(settings + 0x99a, 2)) == bytes([raw, 255 - raw]), f'guard fix changed bytes 0x99A/B ({raw})')
    print('  guard fix', hex(fix), 'keeps bytes 0x99A and 0x99B')


OFF = None


def main():
    global OFF
    new, off = Image(sys.argv[1]), Image(sys.argv[2])
    OFF = off
    print('1. factory and SetCurrentMenu')
    recs = check_factory_current(new, off)
    print('2. Flash Mode submenu record')
    draws = check_submenu_record(new, off)
    print('3. handlers')
    check_handlers(new, recs, draws)
    print('4. list building and submenu drawing')
    check_views(new, off, recs)
    print('5. list constructor scan')
    dm.check_constructor_scan(new, off)
    print('6. texts and icons')
    earlier = Image(sys.argv[4]) if len(sys.argv) > 4 else None
    check_texts_icons(new, earlier, sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != '-' else None)
    print('7. settings guard')
    check_guard(new)
    print('FAILED:\n  ' + '\n  '.join(failures) if failures else 'all checks passed')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
