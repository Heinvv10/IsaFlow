/**
 * Golden path Z39 - on a phone, the closed-period warning under the invoice date is readable right after typing: the
 * sticky action bar covers under 5% of it, none of it once the bar has grown by its autosave line, and the bar is
 * opaque. iPhone 14 and Pixel 7 profiles (viewport, scale,
 * touch, user agent), both on Chromium, the only browser the golden job installs.
 * The fiscal periods are mocked in the browser, so nothing depends on the company's calendar and nothing is saved.
 */
// golden:dev-only
// Dev only: a layout check of the build; the post-deploy run has nothing to learn from it that CI did not.
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { settle } from '../helpers/themeSpec';
import { todayInSast } from '../../../src/lib/saDateParser';
import { warmInvoiceRoutes } from './helpers/warmInvoiceRoutes';

test.beforeAll(warmInvoiceRoutes);

const lockedNow = () => {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  // The month the app calls "today" (SAST), so a typed day lands in it also just after midnight on the 1st.
  const [y, month] = todayInSast().split('-').map(Number) as [number, number];
  const m = month - 1;
  return [{ periodName: 'Locked month', fiscalYear: y, periodNumber: 1, startDate: iso(new Date(Date.UTC(y, m, 1))), endDate: iso(new Date(Date.UTC(y, m + 1, 0))), status: 'locked' }];
};

/**
 * Late parts of the page (the Scan Invoice button, and more within the first second) push the form down after the date
 * field is already there; typing waits until the field has not moved for a second.
 */
async function layoutStill(page: Page, field: Locator): Promise<void> {
  await expect(page.getByRole('button', { name: 'Scan Invoice' })).toBeVisible({ timeout: 30_000 });
  await settle(page);
  let last = Number.NaN; let since = Date.now();
  await expect.poll(async () => {
    const y = (await field.boundingBox())?.y ?? Number.NaN;
    if (y !== last) { last = y; since = Date.now(); }
    return Date.now() - since;
  }, { timeout: 30_000, intervals: [100] }).toBeGreaterThanOrEqual(1_000);
}

/** The share of the warning's text that is off screen or under something else, sampled on a grid over each line. */
async function coveredPct(page: Page): Promise<number> {
  return page.getByRole('status').filter({ hasText: 'save a draft' }).evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el);
    let total = 0; let covered = 0;
    for (const r of Array.from(range.getClientRects())) {
      for (let y = r.top + 1; y < r.bottom; y += 2) {
        for (let x = r.left + 1; x < r.right; x += 8) {
          total++;
          const top = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
          if (!top || !el.contains(top)) covered++;
        }
      }
    }
    return total === 0 ? 100 : (100 * covered) / total;
  });
}

for (const name of ['iPhone 14', 'Pixel 7'] as const) {
  const { defaultBrowserType: _webkitOrChromium, ...profile } = devices[name];
  test.describe(name, () => {
    test.use({ ...profile, serviceWorkers: 'block' });
    test(`${name}: the closed-period warning is clear of the action bar right after typing`, async ({ page }) => {
      await page.route(/\/api\/accounting\/fiscal-periods(\?|$)/, (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: lockedNow() }) }));
      const periods = page.waitForResponse(/\/api\/accounting\/fiscal-periods/, { timeout: 60_000 });
      await page.goto('/accounting/customer-invoices/new', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Customer Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
      await periods;
      const date = page.getByRole('textbox', { name: /Invoice date/ });
      await layoutStill(page, date);
      await date.tap();
      await date.fill('');
      await date.pressSequentially('15', { delay: 60 }); // day of the current (locked) month
      const warning = page.getByRole('status').filter({ hasText: 'save a draft' });
      await expect(warning).toBeAttached();
      await expect.poll(() => coveredPct(page), { timeout: 2_000, message: 'right after typing' }).toBeLessThan(5);
      // Leaving the field keeps the draft on the device: the autosave line appears and can make the bar taller.
      await date.blur();
      const bar = page.getByRole('group', { name: 'Invoice actions' });
      await expect(bar.getByText(/Saved on this device/)).toBeVisible({ timeout: 15_000 });
      // Not even the descenders of the last line: the warning is placed with room for the bar to grow.
      await expect.poll(() => coveredPct(page), { timeout: 2_000, message: 'after the autosave line appears' }).toBe(0);
      const paint = await bar.evaluate((el) => {
        const s = getComputedStyle(el);
        const a = s.backgroundColor.match(/rgba\([^)]*[,/]\s*([\d.]+)\)$/);
        return { color: s.backgroundColor, alpha: a ? Number(a[1]) : 1, opacity: s.opacity, image: s.backgroundImage };
      });
      expect(paint.alpha, `bar background ${paint.color}`).toBe(1);
      expect(paint.opacity).toBe('1');
      await expect(date).toBeInViewport({ ratio: 1 });
      expect(await coveredPct(page), 'still clear at the end').toBe(0);
    });
  });
}
