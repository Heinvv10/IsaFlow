import type { Page } from '@playwright/test';

/**
 * Wait for the page's finite animations to end, so axe reads settled colours. A modal fades and zooms in (Modal.tsx:
 * ~300 ms), and axe run mid-animation blends the opacity into its contrast (z24 measured 1.12:1 at 40 ms on a button
 * that is 11.9:1 settled). Infinite animations (spinners) are skipped, a cancelled one (AbortError) counts as ended, and
 * the wait gives up after `capMs` so a paused animation cannot hang the spec: axe then reports what it sees.
 */
export async function settleAnimations(page: Page, capMs = 2_000): Promise<void> {
  await page.evaluate((cap) => Promise.race([
    Promise.all(document.getAnimations()
      .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
      .map((a) => a.finished.catch(() => {}))),
    new Promise((resolve) => { setTimeout(resolve, cap); }),
  ]), capMs);
}
