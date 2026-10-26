/**
 * Golden path O3 - titles on an always-dark banner are readable in both themes (master plan 3b.1 follow-up).
 *
 * About 20 "New Document" / list pages draw their header on `bg-gradient-to-br from-slate-900 via-slate-800
 * to-slate-900` and set the h1 to `text-slate-900 dark:text-white`: in the light theme that is near-black on
 * near-black (1.0-1.2:1). styles/themeContrast.css turns slate-900/gray-900 text on a dark-gradient surface
 * white. This spec loads a sample of those pages in both themes, reads the banner's own text colours against
 * the banner's own background, and requires >= 4.5:1 for every text node inside the banner. It also checks the
 * rule does not leak: a slate-900 title on an ordinary (light) surface stays dark in the light theme.
 *
 * Evidence mode: BANNER_EVIDENCE_DIR=<dir> writes a screenshot per page and theme and banner-contrast-<page>.json.
 * Read-only: writes no data.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { THEMES, rootTheme, seedTheme, settle } from '../helpers/themeSpec';

/** The pages that draw an always-dark gradient banner (customer-invoices/edit/[invoiceId] needs a record id and is left out). */
const PAGES = [
  { slug: 'assets-new', path: '/accounting/assets/new' },
  { slug: 'bank-transactions-new', path: '/accounting/bank-transactions/new' },
  { slug: 'batch-payments-new', path: '/accounting/batch-payments/new' },
  { slug: 'credit-notes', path: '/accounting/credit-notes' },
  { slug: 'credit-notes-new', path: '/accounting/credit-notes/new' },
  { slug: 'customer-payments-new', path: '/accounting/customer-payments/new' },
  { slug: 'delivery-notes', path: '/accounting/delivery-notes' },
  { slug: 'delivery-notes-new', path: '/accounting/delivery-notes/new' },
  { slug: 'goods-received-new', path: '/accounting/goods-received/new' },
  { slug: 'items-new', path: '/accounting/items/new' },
  { slug: 'journal-entries-new', path: '/accounting/journal-entries/new' },
  { slug: 'purchase-orders', path: '/accounting/purchase-orders' },
  { slug: 'purchase-orders-new', path: '/accounting/purchase-orders/new' },
  { slug: 'recurring-invoices', path: '/accounting/recurring-invoices' },
  { slug: 'recurring-invoices-new', path: '/accounting/recurring-invoices/new' },
  { slug: 'supplier-credit-notes', path: '/accounting/supplier-credit-notes' },
  { slug: 'supplier-credit-notes-new', path: '/accounting/supplier-credit-notes/new' },
  { slug: 'supplier-invoices', path: '/accounting/supplier-invoices' },
  { slug: 'supplier-invoices-new', path: '/accounting/supplier-invoices/new' },
  { slug: 'supplier-payments-new', path: '/accounting/supplier-payments/new' },
] as const;

const evidenceDir = process.env.BANNER_EVIDENCE_DIR;
const results: Record<string, unknown> = {};

test.setTimeout(240_000);

interface BannerRow { text: string; el: string; fg: string; ratio: number }

/**
 * Every visible text node inside the first dark-gradient banner, against what is really behind it: each of the
 * banner's gradient stops, with every translucent painted ancestor between the text and the banner (bg-white/10
 * buttons, amber chips, tinted pills) composited over it, outermost first. The worst stop decides.
 */
function measureBanner(): { found: boolean; rows: BannerRow[] } {
  const banner = document.querySelector<HTMLElement>('main [class*="bg-gradient-to-br"][class*="from-slate-900"]');
  if (!banner) return { found: false, rows: [] };
  type RGBA = [number, number, number, number];
  const parse = (c: string): RGBA => {
    const m = c.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?\s*\)/);
    if (!m) return [0, 0, 0, 0];
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1]!, +m[2]!, +m[3]!, a];
  };
  const over = (top: RGBA, base: RGBA): RGBA => {
    const a = top[3] + base[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i: 0 | 1 | 2) => (top[i] * top[3] + base[i] * base[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const lum = (c: RGBA) => {
    const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: RGBA, b: RGBA) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  const stops = (getComputedStyle(banner).backgroundImage.match(/rgba?\([^)]*\)/g) ?? []).map(parse);
  const rows: BannerRow[] = [];
  const walker = document.createTreeWalker(banner, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || !(n.textContent ?? '').trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // painted layers from the banner's child down to the text's own element
    const layers: RGBA[] = [];
    for (let a: HTMLElement | null = el; a && a !== banner; a = a.parentElement) {
      const bg = parse(getComputedStyle(a).backgroundColor);
      if (bg[3] > 0) layers.unshift(bg);
    }
    let worst = Infinity;
    for (const stop of stops) {
      const behind = layers.reduce<RGBA>((under, layer) => over(layer, under), stop);
      worst = Math.min(worst, ratio(over(parse(cs.color), behind), behind));
    }
    rows.push({ text: (n.textContent ?? '').trim().slice(0, 40), el: `${el.tagName.toLowerCase()}${layers.length > 0 ? '+bg' : ''}`, fg: cs.color, ratio: Math.round(worst * 100) / 100 });
  }
  return { found: true, rows };
}

for (const page of PAGES) {
  test(`${page.slug}: banner text >= 4.5:1 in light and dark`, async ({ page: pw }) => {
    for (const theme of THEMES) {
      await seedTheme(pw, theme);
      await pw.goto(page.path, { waitUntil: 'domcontentloaded' });
      await settle(pw);
      await pw.waitForSelector(`html[data-theme-applied="${theme}"]`);
      const { found, rows } = await pw.evaluate(measureBanner);
      expect(found, `${page.slug} ${theme}: the dark banner is on the page`).toBe(true);
      expect(rows.some((r) => r.el.startsWith('h1')), `${page.slug} ${theme}: the banner holds the h1`).toBe(true);
      results[`${page.slug}.${theme}`] = rows;
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        await pw.screenshot({ path: join(evidenceDir, `${page.slug}-${theme}.png`), clip: { x: 0, y: 0, width: 1280, height: 330 } });
        // one file per page: a failed test restarts Playwright's worker, which would drop a shared accumulator
        writeFileSync(join(evidenceDir, `banner-contrast-${page.slug}.json`), JSON.stringify(Object.fromEntries(Object.entries(results).filter(([k]) => k.startsWith(`${page.slug}.`))), null, 1));
      }
      const low = rows.filter((r) => r.ratio < 4.5).map((r) => `${r.ratio}:1 ${r.el} "${r.text}" ${r.fg}`);
      expect(low, `${page.slug} ${theme}: banner text below AA`).toEqual([]);
    }
  });
}

test('the rule is scoped: slate-900 text off a dark banner stays dark in light and is unchanged in dark', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const colours: Record<string, Record<string, string>> = {};
  for (const theme of THEMES) {
    await seedTheme(page, theme);
    await page.goto('/accounting/customer-invoices', { waitUntil: 'domcontentloaded' });
    await settle(page);
    await page.waitForSelector(`html[data-theme-applied="${theme}"]`);
    colours[theme] = await page.evaluate(() => {
      const host = document.createElement('div');
      host.innerHTML = [
        '<div id="b" class="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900"><h1 id="onBanner" class="text-slate-900 dark:text-white">t</h1><p id="gray" class="text-gray-900">t</p></div>',
        '<div class="bg-white"><h1 id="onWhite" class="text-slate-900 dark:text-white">t</h1></div>',
        '<div class="bg-slate-50"><h1 id="onPage" class="text-slate-900">t</h1></div>',
        '<div class="bg-gradient-to-br from-slate-50 to-white"><h1 id="onLightGradient" class="text-slate-900">t</h1></div>',
        // a light card inside a dark banner opts out: the element that carries data-surface="light" AND what is inside it
        '<div class="bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900"><h1 id="selfLight" data-surface="light" class="text-slate-900">t</h1>' +
          '<div data-surface="light" class="bg-white"><h1 id="insideLight" class="text-slate-900">t</h1><p id="insideLightMuted" class="text-slate-500">t</p></div>' +
          '<p id="bannerMuted" class="text-slate-500">t</p></div>',
      ].join('');
      document.body.appendChild(host);
      const c = (id: string) => getComputedStyle(document.getElementById(id)!).color;
      return {
        onBanner: c('onBanner'), gray: c('gray'), onWhite: c('onWhite'), onPage: c('onPage'), onLightGradient: c('onLightGradient'),
        selfLight: c('selfLight'), insideLight: c('insideLight'), insideLightMuted: c('insideLightMuted'), bannerMuted: c('bannerMuted'),
      };
    });
  }
  const WHITE = 'rgb(255, 255, 255)';
  const SLATE_900 = 'rgb(15, 23, 42)';
  expect(colours.light!.onBanner, 'light: title on the dark banner').toBe(WHITE);
  expect(colours.light!.gray, 'light: gray-900 text on the dark banner').toBe(WHITE);
  expect(colours.light!.onWhite, 'light: title on white is untouched').toBe(SLATE_900);
  expect(colours.light!.onPage, 'light: title on the page is untouched').toBe(SLATE_900);
  expect(colours.light!.onLightGradient, 'light: a LIGHT gradient is not a banner').toBe(SLATE_900);
  expect(colours.light!.selfLight, 'light: an element carrying data-surface="light" opts itself out').toBe(SLATE_900);
  expect(colours.light!.insideLight, 'light: a light card inside the banner opts its title out').toBe(SLATE_900);
  // The banner is a dark panel for the page-wide remap, so slate-500 keeps its palette value (4.76:1 on white: AA).
  expect(colours.light!.insideLightMuted, 'light: and its muted text is left as the palette slate-500, not the banner grey').toBe('rgb(100, 116, 139)');
  expect(colours.light!.bannerMuted, 'light: muted text directly on the banner is the light grey').toBe('rgb(169, 182, 201)');
  expect(colours.dark!.onBanner, 'dark: dark:text-white already wins on the banner').toBe(WHITE);
  expect(colours.dark!.onWhite, 'dark: dark:text-white wins').toBe(WHITE);
  expect((await rootTheme(page)).dark).toBe(true);
});
