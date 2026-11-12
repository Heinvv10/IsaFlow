/**
 * The wordmark artwork spells the brand "IsaFlow". The old raster read "ISAFlow": a capital S and A whose ink
 * reached the cap line between the "I" and the "F". Lowercase "s" and "a" stop at the x-height, so the band
 * above the x-height between the two (x 250..680, y 0..55 of the 1405x289 master) must be empty.
 *
 * Also pins the files that pages, emails and the OG tag load: same size, format and alpha channel as before.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readFileSync } from 'fs';

const ROOT = process.cwd();
const WORDMARKS = ['public/logo.png', 'public/logo-email.png', 'public/BI/logo-primary-transparent.png'];
const BAND = { x0: 250, x1: 680, y0: 0, y1: 55 };

async function decode(file: string) {
  const { data, info } = await sharp(`${ROOT}/${file}`).raw().toBuffer({ resolveWithObject: true });
  return { data, info };
}

describe('IsaFlow wordmark assets', () => {
  it.each(WORDMARKS)('%s keeps its 1405x289 RGBA PNG shape', async (file) => {
    const meta = await sharp(`${ROOT}/${file}`).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height, channels: meta.channels, hasAlpha: meta.hasAlpha })
      .toEqual({ format: 'png', width: 1405, height: 289, channels: 4, hasAlpha: true });
  });

  it.each(WORDMARKS)('%s has no cap-height ink between "I" and "F" (lowercase "sa")', async (file) => {
    const { data, info } = await decode(file);
    let opaque = 0;
    for (let y = BAND.y0; y < BAND.y1; y++) {
      for (let x = BAND.x0; x < BAND.x1; x++) {
        if (data[(y * info.width + x) * info.channels + 3] > 0) opaque++;
      }
    }
    expect(opaque).toBe(0);
  });

  it.each(WORDMARKS)('%s still carries the "Flow" letters right of x=686', async (file) => {
    const { data, info } = await decode(file);
    let teal = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 686; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels;
        if (data[i + 3] > 0 && data[i] < 90 && data[i + 1] > 90 && data[i + 1] < 180 && data[i + 2] > 90) teal++;
      }
    }
    expect(teal).toBeGreaterThan(50_000);
  });

  it('the hero copy in public/BI is the same file as public/logo.png', () => {
    expect(readFileSync(`${ROOT}/public/BI/logo-primary-transparent.png`).equals(readFileSync(`${ROOT}/public/logo.png`))).toBe(true);
  });
});
