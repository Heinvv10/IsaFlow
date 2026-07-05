/**
 * Regression spec for the June-audit / A–Z P3.3 flagship floating-promise
 * defect: pages/accept-invite.tsx ran its invite fetch in an unhandled async
 * IIFE — a network error left `loading` true forever, so an invitee stared
 * at "Loading invitation…" for eternity with no feedback.
 *
 * Run ad hoc (NOT part of the blocking golden gate — not a money path):
 *   BASE_URL=http://localhost:3200 bunx playwright test tests/e2e/accept-invite-network-error.spec.ts --config playwright-standalone.config.ts
 *
 * No login required; the spec aborts its own network calls only.
 */
import { test, expect } from '@playwright/test';

test('accept-invite surfaces a network error instead of hanging on the spinner', async ({
  page,
}) => {
  // Simulate the invite lookup dying on the wire (offline, DNS, proxy 502…).
  await page.route('**/api/invitations/**', (route) => route.abort('connectionfailed'));

  await page.goto('/accept-invite?token=e2e-network-error-drill');

  // The defect: "Loading invitation…" forever. The fix must replace it with
  // a user-visible error within a sane window.
  await expect(page.getByText(/network error/i)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Loading invitation…')).toHaveCount(0);
});

test('accept-invite submit failure re-enables the form instead of wedging on "Accepting…"', async ({
  page,
}) => {
  // Invite lookup succeeds; the ACCEPT call dies on the wire.
  await page.route('**/api/invitations/e2e-submit-drill', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { email: 'drill@example.com', role: 'clerk', company_name: 'Drill Co' },
      }),
    }),
  );
  await page.route('**/api/invitations/e2e-submit-drill/accept', (route) =>
    route.abort('connectionfailed'),
  );

  await page.goto('/accept-invite?token=e2e-submit-drill');
  await expect(page.getByText('Join Drill Co')).toBeVisible({ timeout: 10_000 });

  await page.getByLabel(/password/i).fill('drill-password-123');
  await page.getByRole('button', { name: /accept invitation/i }).click();

  await expect(page.getByText(/network error/i)).toBeVisible({ timeout: 10_000 });
  // Button must recover (not stuck disabled on "Accepting…").
  await expect(page.getByRole('button', { name: /accept invitation/i })).toBeEnabled();
});
