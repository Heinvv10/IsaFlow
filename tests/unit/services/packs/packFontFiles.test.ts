/**
 * THE FONT FILES THE FIT MODEL SHAPES FROM ARE THE ONES THE PRINT PARITY WAS PROVEN ON, AND THEY ARE THERE.
 *
 * The figure fit shapes text from the pack's own woff2 files (`packGlyphRuler.ts`), and production prints with the
 * same files. A changed file moves every width, and with it what production prints: it must not land without the
 * print parity re-run against the production image (`tests/unit/printParity/*`, on velo) and these hashes re-pinned.
 * A face that cannot be read fails the fit loudly; there is no per-character table to fall back to. The deploy copies
 * `public/` into the release folder the standalone server runs in, which is where the fit reads the faces.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILES, fontsDir, loadFace, runPx } from '@/modules/accounting/services/packs/pages/packGlyphRuler';

const ROOT = path.resolve(__dirname, '../../../..');
const PINNED: Readonly<Record<string, string>> = {
  'IBMPlexSans-Regular.woff2': 'ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a',
  'IBMPlexSans-Medium.woff2': '5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d',
  'IBMPlexSans-SemiBold.woff2': 'f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205',
  'figures/IBMPlexSans-Digits-Medium.woff2': '9f89ca34a7f9c9aceecd03a53d0d2968fd82823b28b26dbccdc47a12ae768285',
  'figures/IBMPlexSans-Digits-Regular.woff2': '9d943ea64bdb70ed8974f2caa4b89e0bf3e8d029c3e5b536bc4bde3d7a2ca196',
  'figures/IBMPlexSans-Digits-SemiBold.woff2': '66e347de21b717e51f2893f942c4b9d4f3e348f3a82bfb69bd58cbf13e71ccb8',
};

describe('the pack\'s font files', () => {
  it.each(Object.entries(PINNED))('%s is the file the print parity was proven on (re-run tests/unit/printParity and re-pin if it changes)', (file, sha) => {
    expect(createHash('sha256').update(readFileSync(path.join(ROOT, 'public/fonts', file))).digest('hex')).toBe(sha);
  });

  it('the fit reads every face it shapes from, from public/fonts under the working directory', () => {
    expect(fontsDir()).toBe(path.join(process.cwd(), 'public', 'fonts'));
    for (const weight of [400, 500, 600] as const) expect(Object.keys(PINNED)).toContain(FILES[weight]);
    expect(runPx('Revenue', 12, 500, () => { throw new Error('in the face'); })).toBeGreaterThan(40);
  });

  it('a face that cannot be read fails loudly: the fit never guesses a width', () => {
    expect(() => loadFace('/nonexistent/fonts', 400)).toThrow(/cannot read the pack's face .*refuses to guess/);
  });

  it('the deploy copies public/ into the release folder the standalone server runs in', () => {
    expect(readFileSync(path.join(ROOT, 'scripts/deploy/bluegreen.sh'), 'utf8')).toMatch(/rsync -a --delete "\$src\/public\/" "\$dir\/public\/"/);
  });
});
