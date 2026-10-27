/**
 * The route-readiness probe, free of any Playwright import so it can be unit-tested (tests/unit/e2e/routeProbe.test.ts).
 */

/** The slice of Playwright's Page the probe uses. */
export interface ProbePage {
  request: { get(url: string, opts: { maxRedirects: number; timeout: number }): Promise<{ status(): number }> };
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * Upper bound for the nav's first paint on a loaded box (auth, companies, then the shell; measured ~35 s for a
 * whole dashboard under a 3 s API delay). It is a ceiling, not an expected time: a passing run returns as soon as
 * the nav shows. The cost is that a genuinely broken page in the post-deploy check (prod verify) goes red up to
 * this long later than with a short timeout, which is accepted so a slow runner cannot roll back a good deploy.
 */
export const NAV_READY_MS = 60_000;


/**
 * Wait until the dev server serves `target`, then return. A first request to an uncompiled route can be reset
 * (ERR_EMPTY_RESPONSE) while Next compiles it; that means "not ready yet", so poll for a real response instead of
 * letting page.goto take the reset. This is a readiness probe, not a test retry: the page's own assertions run once.
 *
 * `deadline` (epoch ms) lets a caller share one budget across several waits; default is NAV_READY_MS from now.
 * 404 and 410 are terminal (a wrong path never becomes right). Everything else, 408 and 429 and every 5xx included,
 * is the server being busy and is polled; so is a reset or timeout.
 */
export async function waitForRoute(page: ProbePage, target: string, deadline = Date.now() + NAV_READY_MS): Promise<void> {
  const budget = deadline - Date.now();
  const path = target.split('#')[0] as string; // a fragment is never sent to the server
  const delays = [500, 1_000, 2_000, 5_000];
  let lastError = 'no response';
  for (let attempt = 0; ; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${path} was not served within ${budget} ms (last: ${lastError})`);
    try {
      const status = (await page.request.get(path, { maxRedirects: 5, timeout: Math.min(20_000, left) })).status();
      if (status < 400) return;
      if (TERMINAL_STATUS.has(status)) throw new Terminal(`${path} answered ${status}: the route does not exist or is refused; this will not clear by waiting`);
      lastError = `HTTP ${status}`;
    } catch (err) {
      if (err instanceof Terminal) throw err;
      // Only connection resets and timeouts from page.request.get land here: the server is recompiling.
      lastError = String(err).split('\n')[0] as string;
    }
    await page.waitForTimeout(Math.min(delays[Math.min(attempt, delays.length - 1)] as number, Math.max(0, deadline - Date.now())));
  }
}

/** Only these will not clear by waiting. 408 and 429 (timeout, rate limit) and every 5xx are the server being busy. */
export const TERMINAL_STATUS: ReadonlySet<number> = new Set([404, 410]);

export class Terminal extends Error {}

