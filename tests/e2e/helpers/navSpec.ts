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
import { NAV_READY_MS, TERMINAL_STATUS, Terminal, waitForRoute } from './routeProbe';

export { NAV_READY_MS, TERMINAL_STATUS, waitForRoute };

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

/** Open `path` and wait for the top nav to render (not for the page body). One NAV_READY_MS budget covers it all. */
export async function openWithNav(page: Page, path: string): Promise<void> {
  const deadline = Date.now() + NAV_READY_MS;
  await waitForRoute(page, path, deadline);
  await gotoServed(page, path, deadline);
  await expect(page.locator('[data-tour="nav-dashboard"]')).toBeVisible({ timeout: Math.max(1_000, deadline - Date.now()) });
}

/** A dropped connection, as the loaded CI dev server gives while it recompiles: the server's state, not the page's. */
const DROPPED = /net::ERR_(EMPTY_RESPONSE|CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED)/;

/**
 * page.goto that waits out a dropped connection. The probe above can see the route served and the dev server can
 * still drop the next connection while it disposes and recompiles entries. Only a dropped connection is waited out,
 * and only until `deadline`; any other error, or any HTTP status, goes straight to the caller. When the re-probe
 * itself gives up, the original net::ERR is rethrown, because that is what the page actually saw.
 */
export async function gotoServed(page: Page, path: string, deadline = Date.now() + NAV_READY_MS): Promise<void> {
  for (;;) {
    try {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      return;
    } catch (err) {
      if (!DROPPED.test(String(err)) || Date.now() > deadline) throw err;
      try {
        await waitForRoute(page, path, deadline);
      } catch (probeErr) {
        // A 404 is the truthful cause; otherwise the page's own connection error is.
        throw probeErr instanceof Terminal ? probeErr : err;
      }
    }
  }
}

/**
 * After a click that navigates: wait for the URL. If the dev server dropped the connection while it recompiled,
 * waitForURL throws net::ERR_*; accept that only when the failed URL is the click's own target (so a wrong
 * destination still fails), re-probe the route, and load it directly.
 */
export async function waitForClickNavigation(page: Page, expected: RegExp, targetHref: string): Promise<void> {
  try {
    await page.waitForURL(expected, { timeout: NAV_READY_MS });
  } catch (err) {
    const text = String(err);
    const failedUrl = /net::ERR_[A-Z_]+ at (\S+)/.exec(text)?.[1];
    if (!DROPPED.test(text) || !failedUrl || new URL(failedUrl).pathname !== targetHref.split(/[?#]/)[0]) throw err;
    const deadline = Date.now() + NAV_READY_MS; // the budget starts at the drop, not before the click's own wait
    await waitForRoute(page, targetHref, deadline);
    await gotoServed(page, targetHref, deadline);
    await expect(page).toHaveURL(expected);
  }
}
