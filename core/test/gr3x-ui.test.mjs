// SPDX-License-Identifier: GPL-2.0-only
// Exercise the real UI state/actions with an in-memory host. No camera or disk writes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LANGS } from '../src/fw/names';

const mocks = vi.hoisted(() => ({
  engine: { open: vi.fn(), reset: vi.fn(), build: vi.fn(), ratio: vi.fn(), bridge: vi.fn(), script: vi.fn(), heartbeat: vi.fn() },
  host: {
    available: false, info: { token: 'test', kind: 'test' },
    storeGet: vi.fn(), storeSet: vi.fn(), pickDirectory: vi.fn(), write: vi.fn(),
    volumes: vi.fn(), sidecar: vi.fn(), join: (...p) => p.join('/'),
  },
}));
vi.mock('../../ui/src/engine', () => ({ engine: mocks.engine, EngineError: class extends Error {} }));
vi.mock('../../ui/src/host', () => ({ host: mocks.host, HostError: class extends Error {}, sha256Hex: async () => 'test-hash' }));
vi.mock('../../ui/src/pixels', () => ({ ensureIconFont: vi.fn() }));
vi.mock('../../ui/src/preview', () => ({ decodePreview: vi.fn() }));

const info = () => ({
  family: 'gr3x', version: '1.60', filename: 'fwdc243b.bin', models: ['GR3X_HDF'],
  capabilities: { build: true, presets: false, wallpaper: false, factoryEntry: false, bridge: false },
  features: { softFocus: 'clarity', dateStamp: false, monoUnlock: false },
  slots: [], factoryRatios: ['3:2', '1:1'], factoryEntry: { files: [] },
});
let store;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.host.available = false;
  mocks.engine.open.mockReset().mockResolvedValue(info());
  mocks.engine.reset.mockResolvedValue(true);
  mocks.engine.ratio.mockImplementation(async ratio => ({ label: ratio, actual: ratio, sizes: [[6000, 4000]] }));
  mocks.engine.build.mockResolvedValue({ file: new Uint8Array([9, 2]), checks: { integrity: true } });
  mocks.host.storeSet.mockResolvedValue();
  mocks.host.storeGet.mockReset().mockResolvedValue(null);
  mocks.host.pickDirectory.mockReset().mockResolvedValue('/chosen');
  mocks.host.write.mockImplementation(async (_p, data) => ({ size: data.length, sha256: 'test-hash' }));
  mocks.host.volumes.mockResolvedValue([]);
  vi.stubGlobal('document', { hidden: true });
  store = await import('../../ui/src/store');
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('GR IIIx UI family isolation', () => {
  it('selects IIIx and the ratio page when opening its firmware', async () => {
    expect(await store.adoptFirmware('arbitrary.bin', '1.60', new Uint8Array([1]))).toBe(true);
    expect(store.getState()).toMatchObject({ model: 'GR3X_HDF', page: 'ratio', fwName: 'fwdc243b.bin' });
  });
  it('blocks all unported output actions before a destination can be selected', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    await store.outputBridge({ kind: 'folder' });
    expect(store.outputEntry).toBeUndefined();
    expect(store.outputWallpaper).toBeUndefined();
    store.setBridgeOpen(true);
    expect(store.getState().bridgeOpen).toBe(false);
    for (const fn of [mocks.host.pickDirectory, mocks.host.write, mocks.engine.build, mocks.engine.bridge, mocks.engine.script]) expect(fn).not.toHaveBeenCalled();
  });
  it('exports exactly the fixed ADJ9 recipe through the real build action', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().ratios.map(r => r.ratio)).toEqual(['4:3', '16:9', '65:24', '17:6', '3:4', '7:6', '5:4']);
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build).toHaveBeenCalledWith([], ['4:3', '16:9', '65:24', '17:6', '3:4', '7:6', '5:4'].map(ratio => ({ ratio, name: ratio })), [], { adjSoftFocus: false, dateStamp: false, monoUnlock: false });
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc243b.bin', new Uint8Array([9, 2]));
  });
  it('exports IIIx negative-clarity soft focus while preserving the ADJ function list', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setSoft(true);
    store.setDateStamp(true); store.setMonoUnlock(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState()).toMatchObject({ soft: true, dateStamp: false, monoUnlock: false });
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build.mock.calls[0].slice(2)).toEqual([
      [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }],
      { adjSoftFocus: false, dateStamp: false, monoUnlock: false },
    ]);
  });
  it('retains the selected IIIx page and soft-focus choice when reopening its firmware', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setPage('script'); store.setSoft(true);
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    expect(store.getState()).toMatchObject({ page: 'script', soft: true });
  });
  it('exports T5 film data, uniform names and replicas together with SF1 and the nine-ratio recipe', async () => {
    const current = info();
    current.capabilities.presets = true; current.features.monoUnlock = true;
    current.allowed = Object.fromEntries(LANGS.map(l => [l, ' Film1WarmDemo']));
    current.slots = ['CY','CG'].map((id, i) => ({ id, defaultName: `Film ${i+1}`,
      names: Object.fromEntries(LANGS.map(l => [l, { text: `Film ${i+1}`, capacity: 24 }])) }));
    mocks.engine.open.mockResolvedValue(current);
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setName('CY', 'zh-CN', 'Warm Demo');
    const preset = { matrixQ13: new Int16Array(9), curves: [new Uint16Array(256),new Uint16Array(256),new Uint16Array(256)] };
    store.getState().slots.CY.preset = { fileName: 'demo.cube', kind: 'cube', text: '', result: preset };
    store.setSoft(true); store.setMonoUnlock(true);
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    expect(store.getState()).toMatchObject({ soft: true, monoUnlock: true });
    await vi.advanceTimersByTimeAsync(1);
    await store.outputFirmware({ kind: 'folder' });
    const [requests, ratios, soft, options] = mocks.engine.build.mock.calls.at(-1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ slot: 'CY', preset });
    expect(new Set(Object.values(requests[0].names))).toEqual(new Set(['Warm Demo']));
    expect(ratios).toHaveLength(7); expect(soft.map(s => s.level)).toEqual([-1,-2,-3]);
    expect(options).toEqual({ adjSoftFocus: false, dateStamp: false, monoUnlock: true });
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc243b.bin', new Uint8Array([9,2]));
  });
  it('exports the ninth film and suppresses retired replicas with the T6 capabilities', async () => {
    const current = info(); current.capabilities.presets = true;
    const ids = ['CY','CG','F3','F4','F5','F6','F7','F8','F9'];
    current.allowed = Object.fromEntries(LANGS.map(l => [l, 'Film 123456789CineStl80T']));
    current.slots = ids.map((id, i) => ({ id, defaultName: `Film ${i+1}`,
      names: Object.fromEntries(LANGS.map(l => [l, { text: `Film ${i+1}`, capacity: 24 }])) }));
    mocks.engine.open.mockResolvedValue(current);
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setName('F9', 'zh-CN', 'CineStill 800T'); store.setMonoUnlock(true);
    const preset = { matrixQ13: new Int16Array(9), curves: [new Uint16Array(256),new Uint16Array(256),new Uint16Array(256)] };
    store.getState().slots.F9.preset = { fileName: 'CineStill-800T.cube', kind: 'cube', text: '', result: preset };
    store.setActiveSlot('F9');
    await vi.advanceTimersByTimeAsync(1);
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build.mock.calls.at(-1)[0][0]).toMatchObject({ slot: 'F9', preset });
    expect(mocks.engine.build.mock.calls.at(-1)[3].monoUnlock).toBe(false);
    store.setModel('HDF');
    expect(store.getState().activeSlot).toBe('CY');
    expect(store.getState().slots.F9.preset).toBeUndefined();
  });
  it('discards another camera family’s fitted preset and names when switching or opening a different model', async () => {
    store.getState().slots.CY = { ...store.getState().slots.CY, names: { en: 'GR IV film' }, preset: { result: {} } };
    store.setModel('GR3X_HDF');
    expect(store.getState().slots.CY.preset).toBeUndefined();
    expect(store.getState().slots.CY.names).toEqual({});
    store.setModel('HDF');
    store.getState().slots.CY.preset = { result: {} };
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    expect(store.getState().slots.CY.preset).toBeUndefined();
  });
  it('exports only the unchanged original using the IIIx update filename', async () => {
    const original = new Uint8Array([1, 2, 3]);
    await store.adoptFirmware('fwdc243b.bin', '1.60', original);
    const pending = store.outputFirmware({ kind: 'folder' }, true);
    await vi.advanceTimersByTimeAsync(0);
    // the factory firmware is only written after confirming the camera's settings were reset
    expect(store.getState().confirm).toMatchObject({ reset: true });
    store.answerConfirm(true); await pending;
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc243b.bin', original);
    expect(mocks.engine.build).not.toHaveBeenCalled();
  });
  it('clears the engine and prevents output after switching to a GR IV model', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setModel('HDF');
    expect(store.getState()).toMatchObject({ model: 'HDF', info: undefined, raw: undefined, fwName: undefined });
    expect(mocks.engine.reset).toHaveBeenCalledOnce();
    await store.outputFirmware({ kind: 'folder' }, true);
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('cancels an export if the family changes while the folder picker is open', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    let finish;
    mocks.host.pickDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = store.outputFirmware({ kind: 'folder' }, true);
    await vi.advanceTimersByTimeAsync(0); store.answerConfirm(true); await vi.advanceTimersByTimeAsync(0);
    store.setModel('HDF'); finish('/chosen'); await pending;
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('invalidates the previous firmware when opening another one fails', async () => {
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    mocks.engine.open.mockRejectedValueOnce(new Error('unsupported firmware'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await store.adoptFirmware('other.bin', '1.50', new Uint8Array([2]))).toBe(false);
    expect(store.getState()).toMatchObject({ info: undefined, raw: undefined, fwName: undefined });
    await store.outputFirmware({ kind: 'folder' }, true); // nothing open: returns before asking
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it.each(['outputBridge'])('cancels GR IV %s when the user switches to IIIx in the folder picker', async action => {
    const gr4 = { ...info(), family: 'gr4', models: ['HDF'], filename: 'fwdc248b.bin' };
    gr4.capabilities = { ...gr4.capabilities, factoryEntry: true, bridge: true };
    mocks.engine.open.mockResolvedValueOnce(gr4);
    await store.adoptFirmware('fwdc248b.bin', '1.11', new Uint8Array([1]));
    let finish;
    mocks.host.pickDirectory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = store[action]({ kind: 'folder' });
    store.setModel('GR3X_HDF'); finish('/chosen'); await pending;
    expect(mocks.host.write).not.toHaveBeenCalled();
    expect(mocks.engine.bridge).not.toHaveBeenCalled();
  });
  it('opens GR III 2.10 (experimental) as its own model in the same family and writes fwdc239b.bin', async () => {
    mocks.engine.open.mockResolvedValue({ ...info(), version: '2.10', filename: 'fwdc239b.bin', models: ['GR3_HDF'], experimental: true });
    expect(await store.adoptFirmware('fwdc239b.bin', '2.10', new Uint8Array([1]))).toBe(true);
    expect(store.getState()).toMatchObject({ model: 'GR3_HDF', page: 'ratio', fwName: 'fwdc239b.bin' });
    expect(store.isGr3('GR3_HDF') && store.isGr3('GR3X_HDF') && !store.isGr3('HDF')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getState().ratios.map(r => r.ratio)).toEqual(['4:3', '16:9', '65:24', '17:6', '3:4', '7:6', '5:4']);
    store.setSoft(true);
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.engine.build.mock.calls.at(-1).slice(2)).toEqual([
      [{ level: -1, strength: 'weak' }, { level: -2, strength: 'medium' }, { level: -3, strength: 'strong' }],
      { adjSoftFocus: false, dateStamp: false, monoUnlock: false },
    ]);
    expect(mocks.host.write).toHaveBeenCalledWith('/chosen/fwdc239b.bin', new Uint8Array([9, 2]));
    // no bridge firmware for this family
    store.setBridgeOpen(true);
    expect(store.getState().bridgeOpen).toBe(false);
  });
  it('switching between GR III and GR IIIx closes the other camera\'s firmware', async () => {
    mocks.engine.open.mockResolvedValue({ ...info(), version: '2.10', filename: 'fwdc239b.bin', models: ['GR3_HDF'], experimental: true });
    await store.adoptFirmware('fwdc239b.bin', '2.10', new Uint8Array([1]));
    store.setModel('GR3X_HDF');
    expect(store.getState()).toMatchObject({ model: 'GR3X_HDF', info: undefined, raw: undefined, fwName: undefined });
    await store.outputFirmware({ kind: 'folder' });
    expect(mocks.host.write).not.toHaveBeenCalled();
  });
  it('does not reopen stale cached firmware after a persisted family switch', async () => {
    await store.init(); // no host: mark the project ready without side effects
    mocks.host.available = true;
    let saved;
    mocks.host.storeSet.mockImplementation(async (key, value) => { if (key === 'project.json') saved = value; });
    await store.adoptFirmware('fwdc243b.bin', '1.60', new Uint8Array([1]));
    store.setModel('HDF');
    await vi.advanceTimersByTimeAsync(401);
    expect(JSON.parse(saved)).toMatchObject({ model: 'HDF' });
    expect(JSON.parse(saved).fwName).toBeUndefined();
    vi.resetModules(); mocks.engine.open.mockClear();
    mocks.host.storeGet.mockImplementation(async key => key === 'project.json' ? new TextEncoder().encode(saved) : key === 'firmware.bin' || key === 'preview.jpg' ? new Uint8Array([1]) : null);
    const restarted = await import('../../ui/src/store');
    await restarted.init();
    expect(restarted.getState().model).toBe('HDF');
    expect(restarted.getState().info).toBeUndefined();
    expect(mocks.engine.open).not.toHaveBeenCalled();
  });
});
