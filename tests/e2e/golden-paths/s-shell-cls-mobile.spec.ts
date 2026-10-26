/**
 * Golden path (s): the app shell holds still while it loads, names the tab, and works at 390 px (master plan W1 PR S).
 *
 *  - Layout shift on /accounting/customer-invoices stays under 0.05, cold (new context) and warm (reload).
 *  - On /accounting and /accounting/customer-invoices no layout shift moves the shell: `main` itself, the header bar
 *    or a nav bar. (The dashboard's own hero and tiles still shift while their numbers load; that is the page's, PR K.)
 *  - The document title names the page and its module.
 *  - At 390x844 the top nav strips give way to the hamburger drawer: Invoices is reachable through it, the invoice
 *    list is usable, and nothing is wider than the screen.
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

/** Load (or reload) and let the page finish loading, then read the shifts recorded since the navigation. */
async function shiftsOf(page: Page, load: () => Promise<unknown>): Promise<Shift[]> {
  await load();
  await settle(page);
  await page.waitForTimeout(2_000);
  return page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts);
}

const total = (s: Shift[]) => s.reduce((sum, x) => sum + x.value, 0);

for (const path of ['/accounting', INVOICES]) {
  test(`${path}: the shell does not move while it loads, cold and warm`, async ({ page }) => {
    await recordShifts(page);
    const cold = await shiftsOf(page, () => page.goto(path));
    const warm = await shiftsOf(page, () => page.reload());
    for (const run of [cold, warm]) {
      expect(run.filter((s) => s.shell), JSON.stringify(run)).toEqual([]);
      if (path === INVOICES) expect(total(run), JSON.stringify(run)).toBeLessThan(0.05);
    }
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

test('the document title names the page and its module', async ({ page }) => {
  await page.goto(INVOICES);
  await settle(page);
  await expect(page).toHaveTitle('Tax Invoices · Sales · IsaFlow');
});

test.describe('390 x 844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('Invoices is reachable through the hamburger drawer, and the list is usable and fits', async ({ page }) => {
    await page.goto('/accounting');
    await settle(page);
    await expect(page.locator('[data-tour="nav-dashboard"]')).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).tap();
    const drawer = page.locator('aside.fixed');
    await drawer.getByText('Sales', { exact: true }).first().tap();
    await page.getByRole('link', { name: 'Invoices', exact: true }).last().tap();
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
  }
});
