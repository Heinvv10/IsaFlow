/**
 * Fonts are self-hosted. The Google-hosted loader fetches the font over the network at BUILD time, and a flaky network
 * failed the CI build and the production deploy more than once. Use `next/font/local` with a file under
 * src/assets/fonts (and its OFL text) instead.
 *
 * Reads the working tree (tracked and untracked files), so a new file cannot slip past before it is added.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';

const ROOT = process.cwd();
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'pages'], {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => /\.(tsx?|jsx?|mjs|css)$/.test(f));

const GOOGLE = /next\/font\/google|@next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/;

describe('self-hosted fonts', () => {
  it('has no next/font/google import or Google Fonts URL under src/ or pages/', () => {
    const found = files.filter((f) => f !== 'tests/unit/guards/noGoogleFonts.test.ts' && GOOGLE.test(readFileSync(`${ROOT}/${f}`, 'utf8')));
    expect(found).toEqual([]);
  });

  it('flags the shapes it is meant to flag', () => {
    expect(GOOGLE.test("import { DM_Sans } from 'next/font/google';")).toBe(true);
    expect(GOOGLE.test('@import url(https://fonts.googleapis.com/css2?family=Inter)')).toBe(true);
    expect(GOOGLE.test("import localFont from 'next/font/local';")).toBe(false);
  });

  it('ships both faces and their OFL texts', () => {
    for (const f of ['DMSans-latin-variable.woff2', 'DMSerifDisplay-latin-regular.woff2']) {
      const path = `${ROOT}/src/assets/fonts/${f}`;
      expect(existsSync(path), f).toBe(true);
      expect(readFileSync(path).subarray(0, 4).toString('latin1'), `${f} is a woff2`).toBe('wOF2');
      expect(statSync(path).size, f).toBeGreaterThan(10_000);
    }
    for (const f of ['OFL-DMSans.txt', 'OFL-DMSerifDisplay.txt']) {
      expect(readFileSync(`${ROOT}/src/assets/fonts/${f}`, 'utf8')).toContain('SIL Open Font License');
    }
  });

  it('keeps the CSS variable the Tailwind sans stack reads', () => {
    expect(readFileSync(`${ROOT}/src/lib/fonts.ts`, 'utf8')).toContain("variable: '--font-dm-sans'");
    expect(readFileSync(`${ROOT}/tailwind.config.mjs`, 'utf8')).toContain('var(--font-dm-sans');
  });
});
