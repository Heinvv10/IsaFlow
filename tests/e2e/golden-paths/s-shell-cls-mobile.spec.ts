/**
 * Golden path (s): the app shell holds still while it loads, names the tab, and works on a phone and a tablet
 * (master plan W1 PR S).
 *
 *  - No layout shift moves the shell (`main` itself, the header bar or a nav bar) on /accounting and the invoice list,
 *    cold (new context) and warm (reload), in top-nav and in sidebar mode. The invoice list's total stays < 0.05.
 *    /accounting is gated on shell shifts only: its total (0.069 warm on dev) is the dashboard's own hero and tiles
 *    growing as their numbers load, which PR K's files own.
 *  - The document title names the page and its module.
 *  - At 390 the hamburger drawer reaches Invoices and a section-only page (Sales Orders) inside the screen, and Escape
 *    closes it with focus back on the hamburger (also at 768). The header fits at 390, 768 and 1024.
 *  - EVIDENCE=1 saves 390 and 1568 px screenshots in both themes to docs/evidence.
 *
 * Layout-shift numbers depend on the machine and the data, so this is a dev/CI gate: playwright-golden.config.ts
 * ignores it for the post-deploy run against production (GOLDEN_SKIP_A11Y=1). Read-only: no data is created.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';
import { SHELL_HEIGHTS } from '../../../src/components/layout/shellHeights';

const EVIDENCE_DIR = 'docs/evidence/master-plan/wave1/shell';
const INVOICES = '/accounting/customer-invoices';
/** What "the page has loaded" means on each page: its content, not a timer. */
const LOADED: Record<string, string> = { '/accounting': '[data-tour="dashboard"]', [INVOICES]: 'main table tbody tr' };

interface Shift { value: number; shell: boolean; sources: string[] }

/**
 * Records every layout shift not caused by input, and whether it moved the shell: `main` (everything on the page
 * moves with it), the header bar or a nav bar. A control inside the header settling its own width (the company
 * switcher's placeholder giving way to the company name) moves nothing else and is not counted here.
 */
async function recordShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __shifts: Shift[] };
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node: Node | null }> }>) {
        if (e.hadRecentInput) continue;
        const nodes = (e.sources ?? []).map((s) => s.node).filter((n): n is Element => n instanceof Element);
        w.__shifts.push({
          value: e.value,
          shell: nodes.some((n) => n.matches('main, header') || (!!n.closest('nav') && !n.closest('main'))),
          sources: nodes.map((n) => `${n.nodeName}.${String(n.className).slice(0, 50)}`),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

/**
 * Counts /api requests still waiting for their response, so a test can wait until the page has no data left to
 * load. Counted to the response, not to `requestfinished`: some calls (page-visit beacons, preferences) never report
 * a finished body to Playwright.
 */
function trackApi(page: Page): () => number {
  const waiting = new Set<object>();
  page.on('request', (r) => { if (r.url().includes('/api/')) waiting.add(r); });
  page.on('response', (r) => waiting.delete(r.request()));
  page.on('requestfailed', (r) => waiting.delete(r));
  return () => waiting.size;
}

/** Load (or reload), wait for the page's content and for no /api request in flight, then read the shifts. */
async function shiftsOf(page: Page, path: string, inflight: () => number, load: () => Promise<unknown>): Promise<Shift[]> {
  await load();
  await settle(page);
  await page.locator(LOADED[path]!).first().waitFor();
  await expect.poll(inflight, { timeout: 30_000 }).toBe(0);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts);
}

const total = (s: Shift[]) => s.reduce((sum, x) => sum + x.value, 0);

for (const mode of ['top', 'side'] as const) {
  for (const path of ['/accounting', INVOICES]) {
    test(`${path}, ${mode} nav: the shell does not move while it loads, cold and warm`, async ({ page }) => {
      await page.setViewportSize({ width: 1568, height: 900 });
      if (mode === 'side') await page.addInitScript(() => localStorage.setItem('accounting-nav-mode', 'side'));
      await recordShifts(page);
      const inflight = trackApi(page);
      const cold = await shiftsOf(page, path, inflight, () => page.goto(path));
      const warm = await shiftsOf(page, path, inflight, () => page.reload());
      for (const run of [cold, warm]) {
        expect(run.filter((s) => s.shell), JSON.stringify(run)).toEqual([]);
        if (path === INVOICES) expect(total(run), JSON.stringify(run)).toBeLessThan(0.05);
      }
    });
  }
}

// The skeleton's <main> and the shell's are different elements, so the layout-shift API cannot see a jump between
// them: compare where each one starts instead.
for (const mode of ['top', 'side'] as const) {
  test(`${mode} nav: the loading skeleton's content area starts where the shell's does`, async ({ page }) => {
    await page.setViewportSize({ width: 1568, height: 900 });
    if (mode === 'side') await page.addInitScript(() => localStorage.setItem('accounting-nav-mode', 'side'));
    let release = () => undefined as void;
    const held = new Promise<void>((r) => { release = r; });
    await page.route('**/api/auth/me*', async (route) => { await held; await route.continue(); });
    await page.goto(INVOICES);
    const skeleton = page.locator('main[aria-busy="true"]');
    await skeleton.waitFor();
    const before = await skeleton.boundingBox();
    if (mode === 'side') await expect(page.getByTestId('shell-side')).toBeVisible();
    else await expect(page.getByTestId('shell-side')).toBeHidden();
    release();
    await page.locator('main:not([aria-busy])').waitFor();
    const after = await page.locator('main').boundingBox();
    expect({ x: before!.x, y: before!.y }).toEqual({ x: after!.x, y: after!.y });
  });
}

test('the header and nav bars are exactly as tall as the slots ShellSkeleton reserves for them', async ({ page }) => {
  await page.setViewportSize({ width: 1568, height: 844 });
  await page.goto(INVOICES);
  await settle(page);
  const h = await page.evaluate(() => {
    const height = (el: Element | null | undefined) => (el ? el.getBoundingClientRect().height : -1);
    const navs = [...document.querySelectorAll('nav')].filter((n) => !n.closest('aside, main'));
    return {
      header: height(document.querySelector('header')),
      topNav: height(navs[0]),
      moduleNav: height(navs[1]?.closest('div.border-b')),
      mainTop: document.querySelector('main')!.getBoundingClientRect().top,
    };
  });
  expect(h).toEqual({ ...SHELL_HEIGHTS, mainTop: SHELL_HEIGHTS.header + SHELL_HEIGHTS.topNav + SHELL_HEIGHTS.moduleNav });
});

test('at 200% text size the nav bars grow instead of running into the page (WCAG 1.4.4)', async ({ page }) => {
  await page.setViewportSize({ width: 1568, height: 900 });
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; }));
  await page.goto(INVOICES);
  await settle(page);
  const r = await page.evaluate(() => {
    const navs = [...document.querySelectorAll('nav')].filter((n) => !n.closest('aside, main'));
    const box = (el: Element | null | undefined) => el!.getBoundingClientRect();
    return { top: box(navs[0]), module: box(navs[1]?.closest('div.border-b')), main: box(document.querySelector('main')) };
  });
  expect(r.top.height).toBeGreaterThan(SHELL_HEIGHTS.topNav);
  expect(r.top.bottom).toBeLessThanOrEqual(r.module.top + 0.5);
  expect(r.module.bottom).toBeLessThanOrEqual(r.main.top + 0.5);
});

test('the document title names the page and its module', async ({ page }) => {
  await page.goto(INVOICES);
  await settle(page);
  await expect(page).toHaveTitle('Tax Invoices · Sales · IsaFlow');
});

for (const width of [390, 768, 1024]) {
  test(`${width} px: the header fits`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(INVOICES);
    await settle(page);
    const header = await page.locator('header').evaluate((el) => ({ scroll: el.scrollWidth, width: window.innerWidth }));
    expect(header.scroll).toBeLessThanOrEqual(header.width);
  });
}

for (const width of [390, 768]) {
  test(`${width} px: Escape closes the drawer and focus returns to the hamburger`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/accounting');
    await settle(page);
    const hamburger = page.getByRole('button', { name: 'Open menu' });
    await hamburger.click();
    const drawer = page.getByTestId('mobile-drawer');
    await drawer.getByRole('button', { name: 'Sales', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    await expect(hamburger).toBeFocused();
  });
}

test.describe('390 x 844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  const openSales = async (page: Page) => {
    await page.goto('/accounting');
    await settle(page);
    await expect(page.locator('[data-tour="nav-dashboard"]')).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).tap();
    const drawer = page.getByTestId('mobile-drawer');
    await drawer.getByRole('button', { name: 'Sales', exact: true }).tap();
    return drawer;
  };

  test('Invoices is reachable through the drawer, and the list is usable and fits', async ({ page }) => {
    const drawer = await openSales(page);
    await drawer.getByRole('link', { name: 'Invoices', exact: true }).tap();
    await page.waitForURL(/\/accounting\/customer-invoices$/, { timeout: 30_000 });
    await settle(page);

    await expect(page.getByRole('heading', { name: 'Tax Invoices' })).toBeInViewport();
    await expect(page.getByRole('link', { name: /New Invoice/ }).first()).toBeInViewport();
    await expect(page.getByPlaceholder(/Search invoice/)).toBeVisible();
    const fit = await page.evaluate(() => {
      const main = document.querySelector('main')!;
      const wideNavs = [...document.querySelectorAll('nav')].filter((n) => n.offsetParent !== null && n.scrollWidth > n.clientWidth + 1);
      return { doc: document.documentElement.scrollWidth, main: main.scrollWidth - main.clientWidth, wideNavs: wideNavs.length };
    });
    expect(fit).toEqual({ doc: 390, main: 0, wideNavs: 0 });
  });

  test('a section-only page (Sales > Transactions > Sales Orders) is reachable inside the screen', async ({ page }) => {
    const drawer = await openSales(page);
    await drawer.getByRole('button', { name: 'Transactions', exact: true }).tap();
    const link = drawer.getByRole('link', { name: 'Sales Orders', exact: true });
    await link.scrollIntoViewIfNeeded();
    const box = (await link.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await link.tap();
    await page.waitForURL(/\/accounting\/customer-sales-orders$/, { timeout: 30_000 });
  });
});

test.describe('screenshots', () => {
  test.skip(process.env.EVIDENCE !== '1', 'EVIDENCE=1 saves the shell screenshots');
  for (const theme of THEMES) {
    for (const width of [390, 1568]) {
      test(`${width} px, ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await seedTheme(page, theme);
        await page.goto(INVOICES);
        await settle(page);
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: `${EVIDENCE_DIR}/invoices-${width}-${theme}.png` });
      });
    }
    test(`390 px drawer, ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await seedTheme(page, theme);
      await page.goto('/accounting');
      await settle(page);
      await page.getByRole('button', { name: 'Open menu' }).click();
      const drawer = page.getByTestId('mobile-drawer');
      await drawer.getByRole('button', { name: 'Sales', exact: true }).click();
      await drawer.getByRole('button', { name: 'Transactions', exact: true }).click();
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${EVIDENCE_DIR}/390-drawer-sales-${theme}.png` });
    });
  }
});
