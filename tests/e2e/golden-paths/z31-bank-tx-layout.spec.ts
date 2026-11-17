// golden:dev-only
/**
 * Golden path (z31): the bank transactions page shows the list, not its chrome (WP4b layout).
 *
 * Dev only (it measures layout, and needs the Demo company's New tab to hold more than a screen of lines). Read-only.
 *  - At 1920x1080 at least 12 rows, and at 1366x768 at least 8, are fully on screen and not covered by anything (the
 *    point at each row's bottom edge belongs to that row: a sticky footer over the last rows does not count them). The
 *    header's getBoundingClientRect().top and the count are printed, so a regression shows by how much.
 *  - At 1366 the Actions column is on screen with the grid scrolled fully left (no sideways scroll to reach Accept), and
 *    a New row's Accept and "More actions" targets are at least 24px.
 * A dismissable announcement banner (the shell's, data-testid="announcement-banner") is hidden for the measure: it is
 * not part of this page and comes and goes with the platform's notices.
 *  - With a row ticked, the selection bar is still on screen (and uncovered) once the list is scrolled to its last row.
 *  - A status tile is a toggle: pressing it filters the list to that bucket (the list request carries the filter, the
 *    URL keeps it), pressing it again drops the filter.
 * EVIDENCE_DIR=<dir> saves a screenshot at each size.
 */
import { expect, test, type Page } from '@playwright/test';

const BANK = '/accounting/bank-transactions';
const ROWS = '[data-testid="bank-tx-table"] tbody tr';
const EVIDENCE_DIR = process.env.EVIDENCE_DIR;

async function openList(page: Page): Promise<void> {
  await page.goto(BANK, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '[data-testid="announcement-banner"]{display:none!important}' });
  await expect(page.getByTestId('bank-tx-stats-strip')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(ROWS).first()).toBeVisible({ timeout: 60_000 });
}

/** Rows wholly inside the viewport whose bottom edge is not under another element (a sticky bar, a toast). */
async function measure(page: Page): Promise<{ headerTop: number; visible: number; loaded: number }> {
  return page.evaluate((sel) => {
    const head = document.querySelector('[data-testid="bank-tx-table"] thead')!;
    const rows = [...document.querySelectorAll<HTMLElement>(sel)];
    const visible = rows.filter((r) => {
      const b = r.getBoundingClientRect();
      if (b.top < 0 || b.bottom > window.innerHeight) return false;
      const hit = document.elementFromPoint(b.left + Math.min(40, b.width / 2), b.bottom - 2);
      return hit !== null && r.contains(hit);
    }).length;
    return { headerTop: Math.round(head.getBoundingClientRect().top), visible, loaded: rows.length };
  }, ROWS);
}

for (const { width, height, min } of [{ width: 1920, height: 1080, min: 12 }, { width: 1366, height: 768, min: 8 }]) {
  test(`bank transactions: at least ${min} rows on screen at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openList(page);
    const m = await measure(page);
    test.info().annotations.push({ type: 'layout', description: `${width}x${height}: header top ${m.headerTop}px, ${m.visible} rows visible of ${m.loaded}` });
    expect(m.loaded, 'Demo needs more new lines than a screen holds').toBeGreaterThanOrEqual(min);
    expect(m.visible, `rows on screen at ${width}x${height} (header top ${m.headerTop}px)`).toBeGreaterThanOrEqual(min);
    if (width === 1366) {
      const actions = await page.evaluate(() => {
        const th = [...document.querySelectorAll('[data-testid="bank-tx-table"] thead th')].at(-1)!;
        const scroller = document.querySelector('[data-testid="bank-tx-table"]')!.closest('.overflow-x-auto') ?? document.documentElement;
        scroller.scrollLeft = 0;
        const r = th.getBoundingClientRect(), s = scroller.getBoundingClientRect();
        return { text: th.textContent?.trim(), right: Math.round(r.right), limit: Math.round(Math.min(window.innerWidth, s.right)) };
      });
      expect(actions.text).toBe('Actions');
      expect(actions.right, 'the Actions column is reachable without scrolling sideways').toBeLessThanOrEqual(actions.limit);
      const row = page.locator(ROWS).filter({ has: page.getByRole('button', { name: /^Accept, / }) }).first();
      for (const target of [row.getByRole('button', { name: /^Accept, / }), row.getByRole('button', { name: /^More actions, / })]) {
        const box = (await target.boundingBox())!;
        expect(Math.min(box.width, box.height), 'a row target is at least 24px').toBeGreaterThanOrEqual(24);
      }
    }
    if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/bank-tx-layout-${width}.png` });
  });
}

test('bank transactions: the selection bar stays on screen when the list is scrolled to its last row', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await openList(page);
  await page.locator(`${ROWS} input[type="checkbox"]:enabled`).first().check();
  const bar = page.getByTestId('bank-tx-selection-bar');
  await expect(bar).toBeVisible();
  await page.locator(ROWS).last().scrollIntoViewIfNeeded();
  await expect(page.locator(ROWS).first()).not.toBeInViewport();
  await expect(bar).toBeInViewport({ ratio: 1 });
  // Nothing covers it: the point at its middle is the bar's own.
  expect(await bar.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && el.contains(hit);
  })).toBe(true);
});

test('bank transactions: a status tile filters the list and a second press clears it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openList(page);
  // The first status tile with lines in it (Demo always has some to code).
  let bucket = '';
  for (const b of ['unallocated', 'suggested', 'allocated']) {
    if (Number(await page.getByTestId(`tile-${b}`).getAttribute('data-count')) > 0) { bucket = b; break; }
  }
  expect(bucket, 'the account has lines in some status bucket').not.toBe('');
  const tile = page.getByTestId(`tile-${bucket}`);
  await expect(tile).toHaveAttribute('aria-pressed', 'false');

  const filtered = page.waitForResponse((r) => r.url().includes('/api/accounting/bank-transactions?') && r.url().includes(`allocation_filter=${bucket}`));
  await tile.click();
  expect((await filtered).ok()).toBe(true);
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => new URL(page.url()).searchParams.get('alloc')).toBe(bucket);
  await expect(page.getByTestId('active-filters')).toContainText(`Allocation: ${bucket}`);

  const cleared = page.waitForResponse((r) => r.url().includes('/api/accounting/bank-transactions?') && !r.url().includes('allocation_filter='));
  await tile.click();
  expect((await cleared).ok()).toBe(true);
  await expect(tile).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => new URL(page.url()).searchParams.get('alloc')).toBeNull();
});
