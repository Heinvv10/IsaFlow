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

/**
 * Upper bound for the nav's first paint on a loaded box (auth, companies, then the shell; measured ~35 s for a
 * whole dashboard under a 3 s API delay). It is a ceiling, not an expected time: a passing run returns as soon as
 * the nav shows. The cost is that a genuinely broken page in the post-deploy check (prod verify) goes red up to
 * this long later than with a short timeout, which is accepted so a slow runner cannot roll back a good deploy.
 */
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
 * Wait until the dev server serves `target`, then return. A first request to an uncompiled route can be reset
 * (ERR_EMPTY_RESPONSE) while Next compiles it; that means "not ready yet", so poll for a real response instead of
 * letting page.goto take the reset. This is a readiness probe, not a test retry: the page's own assertions run once.
 *
 * `deadline` (epoch ms) lets a caller share one budget across several waits; default is NAV_READY_MS from now.
 * A 404 or any 4xx is terminal (a wrong path never becomes right), and a 5xx is polled: the server is still compiling.
 * Returns the last error seen so a caller can rethrow the truthful cause.
 */
export async function waitForRoute(page: Page, target: string, deadline = Date.now() + NAV_READY_MS): Promise<void> {
  const path = target.split('#')[0] as string; // a fragment is never sent to the server
  const delays = [500, 1_000, 2_000, 5_000];
  let lastError = 'no response';
  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${path} was not served within ${NAV_READY_MS} ms (last: ${lastError})`);
    try {
      const status = (await page.request.get(path, { maxRedirects: 5, timeout: Math.min(20_000, left) })).status();
      if (status < 400) return;
      if (status < 500) throw new Terminal(`${path} answered ${status}: the route does not exist or is refused; this will not clear by waiting`);
      lastError = `HTTP ${status}`;
    } catch (err) {
      if (err instanceof Terminal) throw err;
      // Only connection resets and timeouts from page.request.get land here: the server is recompiling.
      lastError = String(err).split('\n')[0] as string;
    }
    await page.waitForTimeout(Math.min(delays[Math.min(attempt, delays.length - 1)] as number, Math.max(0, deadline - Date.now())));
  }
}

class Terminal extends Error {}

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
      } catch {
        throw err;
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
  const deadline = Date.now() + NAV_READY_MS;
  try {
    await page.waitForURL(expected, { timeout: NAV_READY_MS });
  } catch (err) {
    const text = String(err);
    const failedUrl = /net::ERR_[A-Z_]+ at (\S+)/.exec(text)?.[1];
    if (!DROPPED.test(text) || !failedUrl || new URL(failedUrl).pathname !== targetHref.split(/[?#]/)[0]) throw err;
    await waitForRoute(page, targetHref, deadline);
    await gotoServed(page, targetHref, deadline);
    await expect(page).toHaveURL(expected);
  }
}
