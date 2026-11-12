/**
 * The wordmark artwork spells the brand "IsaFlow". The old raster read "ISAFlow": a capital S and A whose ink
 * reached the cap line between the "I" and the "F". Lowercase "s" and "a" stop at the x-height, so the band
 * above the x-height between the two (x 250..680, y 0..55 of the 1405x289 master) must be empty.
 *
 * Also pins the files that pages, emails and the OG tag load: same size, format and alpha channel as before.
 *
 * The blog og.webp/hero.webp images carry the same wordmark (white "Isa", 160 px wide at 66,52 on the 1200x630
 * OG, 214 px wide at 88,70 on the 1600x900 hero). The same band, scaled, must be dark there.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readFileSync, readdirSync, existsSync } from 'fs';

const ROOT = process.cwd();
const WORDMARKS = ['public/logo.png', 'public/logo-email.png', 'public/BI/logo-primary-transparent.png'];
const BAND = { x0: 250, x1: 680, y0: 0, y1: 55 };

// Blog images with the wordmark. The draft placeholder post has plain text, no wordmark.
const BLOG_LOGO = { 'og.webp': { w: 160, x: 66, y: 52, width: 1200, height: 630 }, 'hero.webp': { w: 214, x: 88, y: 70, width: 1600, height: 900 } };
const BLOG_IMAGES = readdirSync(`${ROOT}/public/blog`)
  .filter((dir) => dir !== 'placeholder-component-showcase')
  .flatMap((dir) => (['og.webp', 'hero.webp'] as const).map((name) => ({ file: `public/blog/${dir}/${name}`, name })))
  .filter(({ file }) => existsSync(`${ROOT}/${file}`));

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

  it('finds the blog images to check', () => {
    expect(BLOG_IMAGES.length).toBeGreaterThanOrEqual(16);
  });

  it.each(BLOG_IMAGES)('$file keeps its size and has no cap-height ink between "I" and "F"', async ({ file, name }) => {
    const pos = BLOG_LOGO[name];
    const { data, info } = await decode(file);
    expect({ width: info.width, height: info.height }).toEqual({ width: pos.width, height: pos.height });
    const s = pos.w / 1405;
    const x0 = pos.x + Math.floor(260 * s) + 1;
    const x1 = pos.x + Math.floor(670 * s);
    const y1 = pos.y + Math.floor(50 * s);
    let bright = 0;
    for (let y = pos.y; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * info.width + x) * info.channels;
        if ((data[i] + data[i + 1] + data[i + 2]) / 3 > 100) bright++;
      }
    }
    expect(bright).toBe(0);
  });
});
