/**
 * The always-dark banner census (master plan wave 3, V). 16 pages drew their header on a dark gradient with an h1 of
 * `text-slate-900 dark:text-white`, kept readable by a rule in styles/themeContrast.css. All 16 now use the
 * token-based PageHeader and the rule is gone, so a banner drawn again would be near-black on near-black in the
 * light theme. A dark gradient is refused everywhere but the files below, which set their own light text.
 * o3-banner-titles.spec.ts measures the rendered pages; this reads `git ls-files`, so it needs no browser.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module, no declaration file
import { themeContrastCss } from '../../../scripts/generateThemeContrast.mjs';

const ROOT = process.cwd();
const css = readFileSync(join(ROOT, 'styles/themeContrast.css'), 'utf8');

/** A gradient that is dark in both themes. A `dark:` variant does not count: that one follows the theme. */
const DARK_GRADIENT = /(?<![\w:-])from-(?:(?:slate|gray)-(?:800|900|950)|black)(?:\/\d+)?(?![\w-])/;

/**
 * Dark-only surfaces whose text is set light by its own class, so a dark gradient behind it is not the always-dark
 * banner. `pages/oauth/authorize.tsx` is a signed-in consent screen, not a landing page: it is dark in both themes on
 * purpose (page bg-slate-950, text-slate-100/300). `LandingFeatures.tsx` carries a `display:none` screenshot
 * placeholder (shown only if the image fails to load), whose text was gray-500 and is slate-300. `PricingPageSections.tsx`
 * has dark sections with white text. Shrink-only.
 */
const KEEPS_ITS_OWN_LIGHT_TEXT = [
  'pages/oauth/authorize.tsx',
  'src/components/landing/LandingFeatures.tsx',
  'src/components/landing/PricingPageSections.tsx',
];

function darkGradientFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'pages', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => DARK_GRADIENT.test(readFileSync(join(ROOT, f), 'utf8')))
    .sort();
}

describe('the always-dark banner census', () => {
  it('finds a dark gradient only in the files that keep their own light text', () => {
    expect(darkGradientFiles()).toEqual(KEEPS_ITS_OWN_LIGHT_TEXT);
  });

  it('recognises the banner in the forms it was written, and leaves a light or dark-theme gradient alone', () => {
    expect(DARK_GRADIENT.test('bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900')).toBe(true);
    expect(DARK_GRADIENT.test('bg-gradient-to-b from-slate-800/80 to-slate-900')).toBe(true);
    expect(DARK_GRADIENT.test('from-black to-gray-900')).toBe(true);
    expect(DARK_GRADIENT.test('from-slate-50 to-white dark:from-slate-900')).toBe(false);
    expect(DARK_GRADIENT.test('from-slate-900-ish')).toBe(false);
  });
});

describe('styles/themeContrast.css', () => {
  it('is exactly what scripts/generateThemeContrast.mjs generates (never hand-edited)', () => {
    expect(css).toBe(themeContrastCss);
  });

  it('no longer remaps text on a dark gradient: nothing is left that needs it', () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(bare.match(/[^{}]*:where\(\.from-[^{}]*\{\s*color:\s*#[0-9a-f]{6}/gi)).toBeNull();
  });
});
