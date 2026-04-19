/**
 * @audit-2026-04-19 — Practice clients page flicker regression guard.
 *
 * Reproduces a Next.js client-side router race observed in production:
 * after navigating from /accounting/recurring-transactions to
 * /accounting/practice/clients, the URL updated but the page body
 * briefly painted the previous route's content. The polling loop
 * below samples body text every 100 ms for 2 s immediately after the
 * navigation, which is the only way to catch a sub-second flicker that
 * a single post-networkidle assertion would miss.
 *
 * Auth: storageState from tests/e2e/.auth/session.json, injected by
 * the 'chromium' Playwright project (playwright-test.config.ts).
 * No login fixture import is needed — cookies are loaded automatically.
 *
 * Run with:
 *   bunx playwright test tests/e2e/practice-clients-no-flicker.spec.ts \
 *     --config playwright-test.config.ts
 */
import { test, expect } from '@playwright/test';

const FORBIDDEN = ['Recurring Transactions', 'No recurring templates'];
const POLL_INTERVAL_MS = 100;
const POLL_DURATION_MS = 2_000;

test.describe('@audit-2026-04-19 practice clients flicker', () => {
  test('body must not show recurring-transactions content while URL is /accounting/practice/clients', async ({
    page,
  }) => {
    // ── 1. Land on the New Client form ────────────────────────────────────
    await page.goto('/accounting/practice/clients/new');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: /new client/i })).toBeVisible();

    // ── 2. Navigate to Recurring Transactions to prime the route cache ───
    await page.goto('/accounting/recurring-transactions');
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('heading', { name: /recurring transactions/i }),
    ).toBeVisible();

    // ── 3. Immediately navigate to Practice Clients (no waitUntil) ───────
    //    Do NOT await the goto — we want to start polling during the race.
    const gotoPromise = page.goto('/accounting/practice/clients');

    // ── 4. Poll body text for 2 s; fail on any forbidden string ──────────
    const deadline = Date.now() + POLL_DURATION_MS;
    while (Date.now() < deadline) {
      const url = page.url();
      if (url.includes('/accounting/practice/clients')) {
        const body = await page.locator('body').innerText().catch(() => '');
        for (const forbidden of FORBIDDEN) {
          if (body.includes(forbidden)) {
            throw new Error(
              `Flicker detected: body contained "${forbidden}" while URL was ${url}`,
            );
          }
        }
      }
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }

    // Ensure the goto resolved before we do the final assertions
    await gotoPromise;
    await page.waitForLoadState('networkidle');

    // ── 5. Positive assertion: correct page content is shown ─────────────
    await expect(page.getByRole('heading', { name: /^clients$/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/practice client management/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
