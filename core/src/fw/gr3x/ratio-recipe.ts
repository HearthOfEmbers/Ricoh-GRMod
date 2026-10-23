// SPDX-License-Identifier: GPL-2.0-only
// The ratio list of a build, recorded after the code like the film recipe. Never executable:
// inspection rebuilds from the official image with this list and requires byte identity.
// The T4 list writes no recipe, so every build made before custom ratios stays byte-identical.
import { FirmwareError } from '../types';
import { gr3xCustoms } from './geometry';
import type { Gr3xMenuRatio } from './geometry';

export const GR3X_RATIO_RECIPE_MAGIC = new TextEncoder().encode('GR3X-RATIO-RECIPE\0');
const LIMIT = 4096;

export function encodeGr3xRatioRecipe(menu: readonly Gr3xMenuRatio[], features: { adjSoftFocus?: boolean; dateImprint?: boolean; dateMenu?: string; pictures?: readonly { name: string; id?: number }[]; pictureMenu?: string } = {}): Uint8Array {
  const data = new TextEncoder().encode(JSON.stringify({
    schema: 1, ratios: gr3xCustoms(menu).map(r => ({ ratio: r.ratio, name: r.name })),
    ...(features.adjSoftFocus ? { adjSoftFocus: true } : {}),
    ...(features.dateImprint ? { dateImprint: true } : {}),
    ...(features.dateImprint && features.dateMenu === 'submenu' ? { dateMenu: 'submenu' } : {}),
    ...(features.pictures?.length ? { pictures: features.pictures.map(p => p.name) } : {}),
    // Round 6: the End Screen submenu and the pictures' stable identities.
    ...(features.pictures?.length && features.pictureMenu === 'submenu' ? { pictureMenu: 'submenu', pictureIds: features.pictures.map(p => p.id) } : {}),
  }));
  if (data.length > LIMIT) throw new FirmwareError('bad-edit', 'IIIx ratio recipe is too large');
  const out = new Uint8Array(GR3X_RATIO_RECIPE_MAGIC.length + 4 + data.length);
  out.set(GR3X_RATIO_RECIPE_MAGIC);
  new DataView(out.buffer).setUint32(GR3X_RATIO_RECIPE_MAGIC.length, data.length, true);
  out.set(data, GR3X_RATIO_RECIPE_MAGIC.length + 4);
  return out;
}

/** The added ratios (in identity order) recorded in an appended RTOS area, or null for none. */
export function readGr3xRatioRecipe(appendedRtos: Uint8Array): { ratio: string; name: string }[] | null {
  return readGr3xBuildRecipe(appendedRtos)?.ratios ?? null;
}

/** The ratio list and the ADJ features recorded in an appended RTOS area, or null for none. */
export function readGr3xBuildRecipe(appendedRtos: Uint8Array): { ratios: { ratio: string; name: string }[]; adjSoftFocus: boolean; dateImprint: boolean; dateMenu: 'list' | 'submenu'; pictures: string[]; pictureMenu: 'list' | 'submenu'; pictureIds: number[] } | null {
  const magic = GR3X_RATIO_RECIPE_MAGIC;
  for (let at = 0; at + magic.length + 4 <= appendedRtos.length; at++) {
    if (!magic.every((v, i) => appendedRtos[at + i] === v)) continue;
    const start = at + magic.length + 4;
    const size = new DataView(appendedRtos.buffer, appendedRtos.byteOffset).getUint32(at + magic.length, true);
    if (size > LIMIT || start + size > appendedRtos.length) throw new FirmwareError('bad-edit', 'invalid IIIx ratio recipe extent');
    const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(appendedRtos.subarray(start, start + size)));
    if (r?.schema !== 1 || !Array.isArray(r.ratios) || (r.adjSoftFocus !== undefined && r.adjSoftFocus !== true) || (r.dateImprint !== undefined && r.dateImprint !== true) || (r.dateMenu !== undefined && r.dateMenu !== 'submenu') ||
        (r.pictures !== undefined && (!Array.isArray(r.pictures) || r.pictures.some((x: unknown) => typeof x !== 'string'))) ||
        (r.pictureMenu !== undefined && (r.pictureMenu !== 'submenu' || !Array.isArray(r.pictureIds) || r.pictureIds.length !== r.pictures?.length ||
          r.pictureIds.some((x: unknown) => !Number.isInteger(x) || (x as number) < 1 || (x as number) > 0xffffffff))) || r.ratios.some((x: unknown) => typeof x !== 'object' || x === null ||
        typeof (x as Record<string, unknown>).ratio !== 'string' || typeof (x as Record<string, unknown>).name !== 'string'))
      throw new FirmwareError('bad-edit', 'invalid IIIx ratio recipe');
    return { ratios: r.ratios.map((x: { ratio: string; name: string }) => ({ ratio: x.ratio, name: x.name })), adjSoftFocus: r.adjSoftFocus === true, dateImprint: r.dateImprint === true, dateMenu: r.dateMenu === 'submenu' ? 'submenu' : 'list', pictures: r.pictures ?? [],
      pictureMenu: r.pictureMenu === 'submenu' ? 'submenu' : 'list', pictureIds: r.pictureIds ?? [] };
  }
  return null;
}
