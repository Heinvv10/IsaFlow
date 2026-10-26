/**
 * Readiness helpers for the top-nav golden specs (q-top-nav-hover, q2-top-nav-axe).
 *
 * Why these exist: on a loaded runner the dev server compiles a route on its first hit and the app then chains
 * several API rounds (companies, preferences, KPIs, todos) before the page stops showing skeletons. Measured on
 * dev with a 3 s delay on every /api call, the dashboard needs about 35 s to stop spinning, and nothing spins
 * forever: every request resolves. So the specs wait for what they need (the nav, the theme) and never for
 * "no spinner anywhere", and never rely on the default 5 s expect timeout for the nav to render.
 *
 * Must not import @axe-core/playwright: q-top-nav-hover runs in the post-deploy check with the a11y specs unloaded.
 *
 * E2E_API_DELAY_MS=3000 delays every /api response, to prove the specs under load.
 */
import { test as base, expect, type Page } from '@playwright/test';

/** What the nav's first paint costs on a loaded box: auth, companies, then the shell. Not a retry budget. */
export const NAV_READY_MS = 60_000;

export const test = base.extend<{ apiDelay: void }>({
  apiDelay: [async ({ page }, use) => {
    const ms = Number(process.env.E2E_API_DELAY_MS ?? 0);
    if (ms > 0) {
      await page.route('**/api/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        await route.continue();
      });
    }
    await use();
  }, { auto: true }],
});

export { expect };

/**
 * Wait until the dev server serves `path`, then return. A first request to an uncompiled route can be reset
 * (ERR_EMPTY_RESPONSE) while Next compiles it; that means "not ready yet", so poll for a real response instead of
 * letting page.goto take the reset. This is a readiness probe, not a test retry: the page's own assertions run once.
 */
export async function waitForRoute(page: Page, target: string): Promise<void> {
  const path = target.split('#')[0] as string; // a fragment is never sent to the server
  await expect.poll(async () => {
    try {
      return (await page.request.get(path, { maxRedirects: 5, timeout: 20_000 })).status();
    } catch {
      return 999; // connection reset or timeout while compiling: not ready
    }
  }, { message: `${path} is served`, timeout: NAV_READY_MS, intervals: [500, 1_000, 2_000, 5_000] }).toBeLessThan(500);
}

/** Open `path` and wait for the top nav to render (not for the page body). */
export async function openWithNav(page: Page, path: string): Promise<void> {
  await waitForRoute(page, path);
  await gotoServed(page, path);
  await expect(page.locator('[data-tour="nav-dashboard"]')).toBeVisible({ timeout: NAV_READY_MS });
}

/** A dropped connection, as the loaded CI dev server gives while it recompiles: the server's state, not the page's. */
const DROPPED = /net::ERR_(EMPTY_RESPONSE|CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED)/;

/**
 * page.goto that waits out a dropped connection. The probe above can see the route served and the dev server can
 * still drop the next connection while it disposes and recompiles entries (master run on #877, q2 light theme:
 * ERR_EMPTY_RESPONSE on /accounting right after it served). Only a dropped connection is waited out, and only
 * until NAV_READY_MS; any other error, or any HTTP status, goes straight to the caller.
 */
async function gotoServed(page: Page, path: string): Promise<void> {
  const deadline = Date.now() + NAV_READY_MS;
  for (;;) {
    try {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      return;
    } catch (err) {
      if (!DROPPED.test(String(err)) || Date.now() > deadline) throw err;
      await waitForRoute(page, path);
    }
  }
}
