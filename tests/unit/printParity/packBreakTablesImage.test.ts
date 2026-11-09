/**
 * THE BREAK TABLES ARE PRODUCTION'S IMAGE'S: scanned afresh in a throwaway container of the image production's
 * Gotenberg runs (`breakTablesInImage.ts`), the code points Chromium breaks between (`packBreakRanges.SELF_BREAKING`) and
 * those that hold to a soft hyphen or a zero-width space (`packSoftBreakRanges`) come out as committed. A fallback font
 * decides some of them, so a host with other fonts scans other tables (GitHub's runner disagreed on U+05C3 and U+0605):
 * they are held to the image, velo only. With REGENERATE_BREAK_TABLES=1 it writes them instead. Re-run it whenever the
 * gotenberg image or the pack's fonts change.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SELF_BREAKING } from '@/modules/accounting/services/packs/pages/packBreakRanges';
import { SOFT_HYPHEN_HOLDS, ZERO_WIDTH_SPACE_HOLDS } from '@/modules/accounting/services/packs/pages/packSoftBreakRanges';
import { scanBreakTables, type Ranges } from './breakTablesInImage';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { paritySkip } from './paritySkip';

const PAGES = path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages');
const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

const plain = (ranges: ReadonlyArray<readonly [number, number]>): Ranges => ranges.map(([a, b]) => [a, b]);

/** `source` with the array literal of `name` replaced by `ranges`, and its "N code points in M ranges" count rewritten. */
function withTable(source: string, name: string, ranges: Ranges, perLine: number): string {
  const start = source.indexOf(`export const ${name}`);
  const open = source.indexOf('= [', start) + 3;
  const close = source.indexOf('\n];', open);
  const items = ranges.map(([a, b]) => `[0x${a.toString(16)}, 0x${b.toString(16)}]`);
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += perLine) lines.push(`  ${items.slice(i, i + perLine).join(', ')},`);
  return `${source.slice(0, open)}\n${lines.join('\n')}${source.slice(close)}`;
}
const count = (ranges: Ranges): number => ranges.reduce((s, [a, b]) => s + b - a + 1, 0);

describe.skipIf(unavailable !== null)(`the break tables of production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it(process.env.REGENERATE_BREAK_TABLES === '1' ? 'writes packBreakRanges.ts and packSoftBreakRanges.ts' : 'the committed tables are what the image scans now', async () => {
    const image = await scanBreakTables(gotenberg!);
    if (process.env.REGENERATE_BREAK_TABLES === '1') {
      const breakFile = path.join(PAGES, 'packBreakRanges.ts');
      let b = withTable(readFileSync(breakFile, 'utf8'), 'SELF_BREAKING', image.selfBreaking, 6);
      b = b.replace(/Generated; \d+ code points in \d+ ranges\./, `Generated in the image; ${count(image.selfBreaking)} code points in ${image.selfBreaking.length} ranges.`)
        .replace(/Generated in the image; \d+ code points in \d+ ranges\./, `Generated in the image; ${count(image.selfBreaking)} code points in ${image.selfBreaking.length} ranges.`);
      writeFileSync(breakFile, b);
      const softFile = path.join(PAGES, 'packSoftBreakRanges.ts');
      let s = withTable(readFileSync(softFile, 'utf8'), 'SOFT_HYPHEN_HOLDS', image.softHyphenHolds, 6);
      s = withTable(s, 'ZERO_WIDTH_SPACE_HOLDS', image.zeroWidthSpaceHolds, 6);
      s = s.replace(/Generated(?: in the image)?; \d+ code points in \d+ ranges after a soft hyphen, \d+ in \d+ after a zero-width space\./,
        `Generated in the image; ${count(image.softHyphenHolds)} code points in ${image.softHyphenHolds.length} ranges after a soft hyphen, ${count(image.zeroWidthSpaceHolds)} in ${image.zeroWidthSpaceHolds.length} after a zero-width space.`);
      writeFileSync(softFile, s);
      return;
    }
    expect(image.selfBreaking, 'SELF_BREAKING differs from the image: REGENERATE_BREAK_TABLES=1').toEqual(plain(SELF_BREAKING));
    expect(image.softHyphenHolds, 'SOFT_HYPHEN_HOLDS differs from the image').toEqual(plain(SOFT_HYPHEN_HOLDS));
    expect(image.zeroWidthSpaceHolds, 'ZERO_WIDTH_SPACE_HOLDS differs from the image').toEqual(plain(ZERO_WIDTH_SPACE_HOLDS));
  }, 1_800_000);
});
