/**
 * Golden path Z39 - on a phone, the closed-period warning under the invoice date is readable right after typing: the
 * sticky action bar covers none of it (the requirement is under 5%), also once the bar has grown by its autosave
 * line, and the bar is opaque in both themes. iPhone 14 and Pixel 7 profiles (viewport, scale,
 * touch, user agent), both on Chromium, the only browser the golden job installs.
 * The fiscal periods and the scanner status are answered in the browser, so nothing depends on the company's calendar
 * or the machine's services, and nothing is saved.
 */
// golden:dev-only
// Dev only: a layout check of the build; the post-deploy run has nothing to learn from it that CI did not.
import { devices, expect, test, type Locator, type Page } from '@playwright/test';
import { settle } from '../helpers/themeSpec';
import { todayInSast } from '../../../src/lib/saDateParser';
import { warmDevRoutes } from './helpers/warmDevRoutes';

// The one page this spec loads and the read its shell needs; its other two answers are mocked.
test.beforeAll(() => warmDevRoutes([
  { kind: 'api', path: '/api/accounting/companies?action=user-companies', status: 200 },
  { kind: 'page', path: '/accounting/customer-invoices/new' },
]));

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

/** What lets the page show through the bar: a translucent or image background, or opacity on it or anything above it. */
function seeThrough(bar: Element): string[] {
  const found: string[] = [];
  const s = getComputedStyle(bar);
  const alpha = s.backgroundColor.match(/(?:rgba\([^)]*,|\/)\s*([\d.]+)\)$/);
  if (s.backgroundColor === 'transparent' || (alpha && Number(alpha[1]) < 1)) found.push(`background ${s.backgroundColor}`);
  if (s.backgroundImage !== 'none') found.push(`background image ${s.backgroundImage}`);
  for (let e: Element | null = bar; e; e = e.parentElement) {
    const o = getComputedStyle(e).opacity;
    if (o !== '1') found.push(`opacity ${o} on ${e.tagName}`);
  }
  return found;
}

for (const name of ['iPhone 14', 'Pixel 7'] as const) {
  const { defaultBrowserType: _webkitOrChromium, ...profile } = devices[name];
  test.describe(name, () => {
    test.use({ ...profile, serviceWorkers: 'block' });
    test(`${name}: the closed-period warning is clear of the action bar right after typing`, async ({ page }) => {
      const answer = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      await page.route(/\/api\/accounting\/fiscal-periods(\?|$)/, (r) => r.fulfill(answer(lockedNow())));
      // The Scan Invoice button shows only where the document scanner is up (CI has none); answered here, the page has
      // the production layout everywhere.
      await page.route(/\/api\/accounting\/vlm-status(\?|$)/, (r) => r.fulfill(answer({ available: true })));
      const periods = page.waitForResponse(/\/api\/accounting\/fiscal-periods/, { timeout: 60_000 });
      await page.goto('/accounting/customer-invoices/new', { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Customer Invoice', level: 1 })).toBeVisible({ timeout: 60_000 });
      await periods;
      const date = page.getByRole('textbox', { name: /Invoice date/ });
      await layoutStill(page, date);
      // Where the field is only just clear of the bar, so everything under it starts behind the bar (the worst case a
      // user scrolls to). Without this Chromium centres the iPhone field on typing and shows the warning by itself.
      await date.evaluate((el) => el.scrollIntoView({ block: 'end' }));
      await date.tap();
      await date.fill('');
      await date.pressSequentially('15', { delay: 60 }); // day of the current (locked) month
      const warning = page.getByRole('status').filter({ hasText: 'save a draft' });
      await expect(warning).toBeAttached();
      // The requirement is under 5%; the placement leaves none covered, so a few pixels short is already a failure.
      await expect.poll(() => coveredPct(page), { timeout: 2_000, message: 'right after typing' }).toBe(0);
      // Leaving the field keeps the draft on the device: the autosave line appears and can make the bar taller.
      await date.blur();
      const bar = page.getByRole('group', { name: 'Invoice actions' });
      await expect(bar.getByText(/Saved on this device/)).toBeVisible({ timeout: 15_000 });
      // Not even the descenders of the last line: the warning is placed with room for the bar to grow.
      await expect.poll(() => coveredPct(page), { timeout: 2_000, message: 'after the autosave line appears' }).toBe(0);
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
        await expect.poll(() => bar.evaluate(seeThrough), { timeout: 2_000, message: `${theme}: the bar is opaque` }).toEqual([]);
      }
      await expect(date).toBeInViewport({ ratio: 1 });
      expect(await coveredPct(page), 'still clear at the end').toBe(0);
    });
  });
}
