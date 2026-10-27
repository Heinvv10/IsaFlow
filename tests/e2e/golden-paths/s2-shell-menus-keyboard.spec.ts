/**
 * Golden path (s2): the app shell's menus stay on screen and the shell works from the keyboard (master plan W1 PR S,
 * review round 3).
 *
 *  - At 390 every header menu (Create new, Settings, the account menu) opens inside the viewport.
 *  - Enter on the hamburger puts focus inside the drawer (390 and 768).
 *  - A sidebar user never sees the top nav, also across a client-side navigation.
 *  - Sidebar mode at lg: the header fits at 1024; ArrowRight on a sidebar row opens its flyout with focus in it.
 *  - At a 20px root font the header grows instead of clipping its controls, and wraps instead of pushing them off
 *    screen at 390 and 768.
 *
 * Deterministic and read-only (no data is created), so it also runs in the post-deploy check.
 */
import { test, expect, type Page } from '@playwright/test';

const INVOICES = '/accounting/customer-invoices';

/** The shell is loaded: the session check is over and the page content is in. */
async function ready(page: Page): Promise<void> {
  await page.locator('main:not([aria-busy])').waitFor({ timeout: 60_000 });
  await page.locator('header').waitFor();
}

const sideMode = (page: Page) => page.addInitScript(() => localStorage.setItem('accounting-nav-mode', 'side'));

test.describe('390 x 844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  for (const [name, button] of [
    ['Create new', { name: /create new/i }],
    ['Settings', { name: /settings/i }],
    ['Account and display settings', { name: 'Account and display settings' }],
  ] as const) {
    test(`the ${name} menu opens inside the screen`, async ({ page }) => {
      await page.goto(INVOICES);
      await ready(page);
      await page.locator('header').getByRole('button', button).first().click();
      const menu = page.locator('[role="menu"], [role="group"][aria-label="Account and display settings"]').last();
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    });
  }
});

for (const width of [390, 768]) {
  test(`${width} px: Enter on the hamburger puts focus inside the drawer`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/accounting');
    await ready(page);
    await page.getByRole('button', { name: 'Open menu' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="mobile-drawer"]'))).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="mobile-drawer"]'))).toBe(true);
  });
}

test.describe('sidebar mode', () => {
  test.beforeEach(({ page }) => sideMode(page));

  test('a client-side navigation never shows the top nav', async ({ page }) => {
    await page.setViewportSize({ width: 1568, height: 900 });
    await page.goto(INVOICES);
    await ready(page);
    await page.evaluate(() => {
      const w = window as unknown as { __topNavSeen: boolean };
      w.__topNavSeen = !!document.querySelector('[data-tour="nav-dashboard"]');
      new MutationObserver(() => { if (document.querySelector('[data-tour="nav-dashboard"]')) w.__topNavSeen = true; })
        .observe(document.body, { childList: true, subtree: true });
    });
    await page.evaluate(() => (window as unknown as { next: { router: { push: (u: string) => Promise<boolean> } } }).next.router.push('/accounting/customer-quotes'));
    await page.waitForURL(/\/accounting\/customer-quotes$/);
    await ready(page);
    expect(await page.evaluate(() => (window as unknown as { __topNavSeen: boolean }).__topNavSeen)).toBe(false);
  });

  test('1024 px: the header fits', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(INVOICES);
    await ready(page);
    const h = await page.locator('header').evaluate((el) => ({ scroll: el.scrollWidth, width: el.clientWidth, height: el.getBoundingClientRect().height }));
    expect(h.scroll).toBeLessThanOrEqual(h.width);
    expect(h.height).toBe(56); // one row: the bar wraps rather than overflow, so width alone would pass a crowded header
  });

  test('ArrowRight on a sidebar row opens its flyout with focus in it; Escape returns to the row', async ({ page }) => {
    await page.setViewportSize({ width: 1568, height: 900 });
    await page.goto(INVOICES);
    await ready(page);
    const sales = page.getByTestId('sidebar-tab-sales').first();
    await sales.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('link', { name: 'Invoices', exact: true }).last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sales).toBeFocused();
  });
});

test('at a 20px root font the header grows instead of clipping its controls', async ({ page }) => {
  await page.setViewportSize({ width: 1568, height: 900 });
  await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '20px'; }));
  await page.goto(INVOICES);
  await ready(page);
  // Every control sits inside the bar. (scrollHeight is no measure here: the hidden hover tooltips hang below it.)
  const clipped = await page.locator('header').evaluate((el) => {
    const bar = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>('button, a, [data-tour]')]
      .filter((c) => c.offsetParent !== null)
      .filter((c) => { const r = c.getBoundingClientRect(); return r.top < bar.top - 0.5 || r.bottom > bar.bottom + 0.5; })
      .map((c) => c.getAttribute('aria-label') ?? c.getAttribute('title') ?? c.textContent);
  });
  expect(clipped).toEqual([]);
});

for (const width of [390, 768]) {
  test(`${width} px at a 20px root font: every header control is on screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '20px'; }));
    await page.goto(INVOICES);
    await ready(page);
    const off = await page.locator('header').evaluate((el) => [...el.querySelectorAll<HTMLElement>('button, a, [data-tour]')]
      .filter((c) => c.offsetParent !== null)
      .filter((c) => { const r = c.getBoundingClientRect(); return r.left < -0.5 || r.right > window.innerWidth + 0.5; })
      .map((c) => c.getAttribute('aria-label') ?? c.getAttribute('title') ?? c.textContent));
    expect(off).toEqual([]);
  });
}

test('keyboard focus draws a solid ring of at least 2 px on a link and on a button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(INVOICES);
  await ready(page);
  const rings: Record<string, { w: number; style: string }> = {};
  for (let i = 0; i < 60 && !(rings.A && rings.BUTTON); i++) {
    await page.keyboard.press('Tab');
    const seen = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !['A', 'BUTTON'].includes(el.tagName)) return null;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, w: parseFloat(cs.outlineWidth), style: cs.outlineStyle };
    });
    if (seen && !rings[seen.tag]) rings[seen.tag] = { w: seen.w, style: seen.style };
  }
  for (const tag of ['A', 'BUTTON']) {
    expect(rings[tag], `no ${tag} reached by Tab`).toBeDefined();
    expect(rings[tag]!.style).toBe('solid');
    expect(rings[tag]!.w).toBeGreaterThanOrEqual(2);
  }
});
