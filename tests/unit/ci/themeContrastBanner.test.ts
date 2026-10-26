// @vitest-environment happy-dom
/**
 * styles/themeContrast.css, the dark-banner rule: ~20 pages draw their header on an always-dark gradient
 * (`from-slate-900 via-slate-800 to-slate-900`) with an h1 of `text-slate-900 dark:text-white`, which in the
 * light theme is near-black on near-black. One generated rule makes slate/gray-900 text white there (and the
 * mid greys a light grey), in the light theme only. A browser run (o3-banner-titles.spec.ts) measures the real
 * pages; this holds the CSS itself: the committed file is the generator's output, the rule exists, it is
 * scoped to the light theme and to dark surfaces, and its two colours are AA on the banner's gradient stops.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module, no declaration file
import { themeContrastCss } from '../../../scripts/generateThemeContrast.mjs';

const css = readFileSync(join(process.cwd(), 'styles/themeContrast.css'), 'utf8');

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The banner rules: those whose selector list names a `.from-*` surface. */
function bannerRules(): { selectors: string[]; color: string }[] {
  const rules: { selectors: string[]; color: string }[] = [];
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of bare.matchAll(/([^{}]+)\{\s*color:\s*(#[0-9a-f]{6});\s*\}/gi)) {
    const selectors = m[1]!.trim().split(/,\n/).map((s) => s.trim());
    if (selectors.every((s) => s.includes(':where(.from-'))) rules.push({ selectors, color: m[2]!.toLowerCase() });
  }
  return rules;
}

describe('themeContrast.css banner rule', () => {
  it('is exactly what scripts/generateThemeContrast.mjs generates (never hand-edited)', () => {
    expect(css).toBe(themeContrastCss);
  });

  it('turns slate-900 and gray-900 text white on a dark gradient surface', () => {
    const ink = bannerRules().find((r) => r.color === '#ffffff');
    expect(ink, 'a rule that makes banner titles white').toBeDefined();
    for (const cls of ['.text-slate-900', '.text-gray-900']) {
      expect(ink!.selectors.some((s) => s.includes(`) ${cls}`)), cls).toBe(true);
    }
    for (const surface of ['.from-slate-900', '.from-slate-800', '.from-gray-900', '.from-black']) {
      expect(ink!.selectors.every((s) => s.includes(surface)), surface).toBe(true);
    }
  });

  it('gives the mid greys on the banner a light grey', () => {
    const muted = bannerRules().find((r) => r.color !== '#ffffff');
    expect(muted, 'a rule for the muted text on the banner').toBeDefined();
    for (const cls of ['.text-slate-500', '.text-gray-600', '.text-slate-700']) {
      expect(muted!.selectors.some((s) => s.includes(`) ${cls}`)), cls).toBe(true);
    }
  });

  it('applies in the light theme only, so the dark theme renders exactly as before', () => {
    const rules = bannerRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      for (const s of r.selectors) expect(s.startsWith(':where(html:not(.dark)) '), s.slice(0, 60)).toBe(true);
    }
  });

  it('lets a light card inside a banner opt out, and keeps the (0,1,0) specificity of the utilities it overrides', () => {
    for (const r of bannerRules()) {
      for (const s of r.selectors) {
        expect(s).toContain(':not(:where([data-surface="light"], [data-surface="light"] *))');
        // one class outside :where(): the target. A second one would outrank hover: and focus: variants.
        const outside = s.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, '');
        expect((outside.match(/\./g) ?? []).length, s.slice(0, 60)).toBe(1);
      }
    }
  });

  it('the two colours clear AA on every stop of the banner gradient (slate-900 / slate-800)', () => {
    for (const r of bannerRules()) {
      for (const stop of ['#0f172a', '#1e293b']) expect(ratio(r.color, stop), `${r.color} on ${stop}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

/**
 * The rules applied to a real element tree. happy-dom matches the selectors the CSS actually contains (with
 * html:not(.dark) and :where() resolved), so these are behaviour, not text. It cannot tell `:not(:where(X *))` from
 * `:not(:where(X, X *))` (it drops an element carrying X in both), so the data-surface="light" opt-out - on the
 * element itself and on a descendant - is checked in Chrome by o3-banner-titles.spec.ts.
 */
describe('themeContrast.css banner rule on a DOM', () => {
  const ink = () => bannerRules().find((r) => r.color === '#ffffff')!.selectors;
  const muted = () => bannerRules().find((r) => r.color !== '#ffffff')!.selectors;
  const hits = (selectors: string[], el: Element) => selectors.some((s) => el.matches(s));

  function mount(html: string, dark = false): void {
    document.documentElement.className = dark ? 'dark' : '';
    document.body.innerHTML = html;
  }
  const banner = (inner: string) => `<div class="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">${inner}</div>`;

  it('a title on the banner is remapped to white, and so is a gray-900 one', () => {
    mount(banner('<h1 id="t" class="text-slate-900 dark:text-white">T</h1><p id="g" class="text-gray-900">g</p>'));
    expect(hits(ink(), document.getElementById('t')!)).toBe(true);
    expect(hits(ink(), document.getElementById('g')!)).toBe(true);
  });

  it('the muted text on the banner (back link, counts) is remapped to the light grey, not to white', () => {
    mount(banner('<p id="p" class="text-slate-500 dark:text-slate-400">n</p><a id="a" class="text-gray-600">b</a>'));
    expect(hits(muted(), document.getElementById('p')!)).toBe(true);
    expect(hits(muted(), document.getElementById('a')!)).toBe(true);
    expect(hits(ink(), document.getElementById('p')!)).toBe(false);
    expect(bannerRules().find((r) => r.color !== '#ffffff')!.color).toBe('#a9b6c9');
  });

  it('nothing outside a dark banner is touched: a light gradient, a white card and the bare page', () => {
    mount('<div class="from-slate-50 to-white"><h1 id="a" class="text-slate-900">a</h1></div><div class="bg-white"><h1 id="b" class="text-slate-900">b</h1></div><h1 id="c" class="text-slate-900">c</h1>');
    for (const id of ['a', 'b', 'c']) expect(hits(ink(), document.getElementById(id)!), id).toBe(false);
  });

  it('nothing matches in the dark theme: it renders exactly as before', () => {
    mount(banner('<h1 id="t" class="text-slate-900">T</h1><p id="p" class="text-slate-500">n</p>'), true);
    expect(hits(ink(), document.getElementById('t')!)).toBe(false);
    expect(hits(muted(), document.getElementById('p')!)).toBe(false);
  });
});

