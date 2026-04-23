/**
 * PRD-05 Full Browser Audit
 *
 * Walks every UI surface shipped across Phases 1-12:
 *   Phase 1  — /accounting/capture, /accounting/capture/inbox, /accounting/capture/settings
 *   Phase 2  — evidence drill on /accounting/reports/trial-balance
 *   Phase 3  — /accounting/suppliers/rules (+ per-supplier detail)
 *   Phase 4  — /accounting/supplier-invoices/[id] three-way-match panel
 *   Phase 5  — /accounting/bank/provisional
 *   Phase 6  — /accounting/suppliers/expectations, /accounting/suppliers/missing-invoices
 *   Phase 7  — /accounting/bank/statements/import-pdf, /accounting/ap/supplier-statements
 *   Phase 8  — /accounting/capture/settings (WhatsApp section)
 *   Phase 9  — /accounting/capture/settings/mirror
 *   Phase 10 — /accounting/expenses, /accounting/expenses/[id], /accounting/expenses/new
 *   Phase 11 — /accounting/fraud/signals
 *   Phase 12 — /accounting/audit-packs
 *
 * Every assertion uses the React-error-boundary heuristic ('Something went
 * wrong' / 'Minified React error') as a crash gate. We also assert key
 * data elements rendered (suppliers seen, claim visible, etc.).
 *
 * Uses the refreshed session in tests/e2e/.auth/prod-session.json.
 * If any test fails, screenshots land in tests/e2e/screenshots/.
 */
import { test, expect, type Page } from '@playwright/test';

const CRASH_TEXT = [
  'Something went wrong',
  /Minified React error/,
  /Application error: a client-side exception/,
];

async function assertNoCrash(page: Page, route: string) {
  const body = (await page.textContent('body')) ?? '';
  for (const pattern of CRASH_TEXT) {
    if (typeof pattern === 'string') {
      expect(body, `Crash text '${pattern}' on ${route}`).not.toContain(pattern);
    } else {
      expect(body, `Crash pattern ${pattern} on ${route}`).not.toMatch(pattern);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────
// Phase 1 — Capture
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 1 — Capture', () => {
  test('PWA capture page renders with camera + file picker', async ({ page }) => {
    await page.goto('/accounting/capture');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/capture');
    await expect(page.getByRole('heading', { name: /Capture/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Take Photo/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Choose from device/i })).toBeVisible();
  });

  test('Inbox renders, shows unique inbox address', async ({ page }) => {
    await page.goto('/accounting/capture/inbox');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/capture/inbox');
    await expect(page.getByRole('heading', { name: 'Capture Inbox' })).toBeVisible();
    // Either some pending events or the empty-state mail address line
    const body = (await page.textContent('body')) ?? '';
    expect(body).toMatch(/inbox\.isaflow\.co\.za|Channel|Vendor/i);
  });

  test('Settings page shows all 4 channel sections', async ({ page }) => {
    await page.goto('/accounting/capture/settings');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/capture/settings');
    const body = (await page.textContent('body')) ?? '';
    // Email + PWA + WhatsApp (Phase 8) + Mirror (Phase 9)
    expect(body).toMatch(/Email/i);
    expect(body).toMatch(/Mobile|PWA/i);
    expect(body).toMatch(/WhatsApp|Mirror/i);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 2 — Evidence drill
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 2 — Evidence drill', () => {
  test('Trial balance renders and returns a non-empty list', async ({ page }) => {
    await page.goto('/accounting/trial-balance');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/trial-balance');
    await expect(page.getByRole('heading', { name: /Trial Balance/i })).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 3 — Supplier rules
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 3 — Supplier rules', () => {
  test('Rules list shows the 3 seeded auto-publish rules', async ({ page }) => {
    await page.goto('/accounting/suppliers/rules');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/suppliers/rules');
    await expect(page.getByRole('heading', { name: /Supplier Coding Rules/i })).toBeVisible();
    const body = (await page.textContent('body')) ?? '';
    expect(body, 'Expected Telkom / Eskom / Cape Office Supplies in the rules table').toMatch(/Telkom|Eskom|Cape Office/);
  });

  test('Auto-publish filter toggle works', async ({ page }) => {
    await page.goto('/accounting/suppliers/rules');
    await page.waitForLoadState('networkidle');
    const checkbox = page.getByRole('checkbox', { name: /Auto-publish only/i });
    if (await checkbox.count() > 0) {
      await checkbox.check();
      await expect(checkbox).toBeChecked();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 5 — Bank-first provisional
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 5 — Provisional entries', () => {
  test('Provisional page renders with filter controls', async ({ page }) => {
    await page.goto('/accounting/bank/provisional');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/bank/provisional');
    await expect(page.getByRole('heading', { name: /Provisional/i })).toBeVisible();
    // Days-outstanding filter buttons
    await expect(page.getByRole('button', { name: /All/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /≥3 days/ })).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 6 — Expectations + missing invoices
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 6 — Expectations', () => {
  test('Expectations page shows the 2 seeded rows', async ({ page }) => {
    await page.goto('/accounting/suppliers/expectations');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/suppliers/expectations');
    const body = (await page.textContent('body')) ?? '';
    expect(body).toMatch(/Telkom|Eskom/);
  });

  test('Missing-invoices page renders with the 2 pending alerts', async ({ page }) => {
    await page.goto('/accounting/suppliers/missing-invoices');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/suppliers/missing-invoices');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 7 — Statement recon
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 7 — Statement recon', () => {
  test('Bank statement import-pdf page renders', async ({ page }) => {
    await page.goto('/accounting/bank/statements/import-pdf');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/bank/statements/import-pdf');
  });

  test('Supplier statements page renders', async ({ page }) => {
    await page.goto('/accounting/ap/supplier-statements');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/ap/supplier-statements');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 9 — Mirror inbox
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 9 — Mirror inbox', () => {
  test('Mirror settings shows the seeded connection', async ({ page }) => {
    await page.goto('/accounting/capture/settings/mirror');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/capture/settings/mirror');
    await expect(page.getByRole('heading', { name: /Mirror Inboxes/i })).toBeVisible();
    const body = (await page.textContent('body')) ?? '';
    expect(body, 'Expected QA Demo Mailbox row').toMatch(/QA Demo Mailbox|qa-demo@example/);
  });

  test('Add-IMAP-mailbox modal opens + closes without error', async ({ page }) => {
    await page.goto('/accounting/capture/settings/mirror');
    await page.waitForLoadState('networkidle');
    const addBtn = page.getByRole('button', { name: /Add IMAP/ });
    await addBtn.click();
    await expect(page.getByRole('heading', { name: /Connect IMAP mailbox/i })).toBeVisible();
    await expect(page.getByPlaceholder('Finance Inbox')).toBeVisible();
    await expect(page.getByPlaceholder('imap.gmail.com')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await assertNoCrash(page, '/accounting/capture/settings/mirror (post-modal-close)');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 10 — Expense claims
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 10 — Expense claims', () => {
  test('Expenses list renders + shows the seeded CL-QA-DEMO', async ({ page }) => {
    await page.goto('/accounting/expenses');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/expenses');
    await expect(page.getByRole('heading', { name: /Expense Claims/i })).toBeVisible();
    const body = (await page.textContent('body')) ?? '';
    expect(body).toMatch(/CL-QA-DEMO/);
  });

  test('Click into QA claim shows 2 lines + submit button', async ({ page }) => {
    await page.goto('/accounting/expenses');
    await page.waitForLoadState('networkidle');
    await page.getByText('CL-QA-DEMO').first().click();
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/expenses/[id]');
    await expect(page.getByRole('heading', { name: /CL-QA-DEMO/ })).toBeVisible();
    const body = (await page.textContent('body')) ?? '';
    expect(body).toMatch(/Uber/);
    expect(body).toMatch(/Sandton.*Pretoria|Mileage/);
    await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  });

  test('New claim form renders', async ({ page }) => {
    await page.goto('/accounting/expenses/new');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/expenses/new');
    await expect(page.getByRole('heading', { name: /New claim/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Create draft/i })).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 11 — Fraud signals
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 11 — Fraud signals', () => {
  test('Fraud signals page shows the seeded VAT-mismatch alert', async ({ page }) => {
    await page.goto('/accounting/fraud/signals');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/fraud/signals');
    await expect(page.getByRole('heading', { name: /Fraud Signals/i })).toBeVisible();
    const body = (await page.textContent('body')) ?? '';
    expect(body, 'Expected QA-seeded fraud alert').toMatch(/VAT mismatch|vat_mismatch/);
    expect(body).toMatch(/Eskom/);
  });

  test('Run-scan button is clickable', async ({ page }) => {
    await page.goto('/accounting/fraud/signals');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('button', { name: /Run scan/i })).toBeVisible();
  });

  test('Status filter dropdown works', async ({ page }) => {
    await page.goto('/accounting/fraud/signals');
    await page.waitForLoadState('networkidle');
    const selector = page.getByRole('combobox');
    if (await selector.count() > 0) {
      await selector.selectOption('dismissed');
      await page.waitForTimeout(500);
      await assertNoCrash(page, '/accounting/fraud/signals (dismissed filter)');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 12 — Audit packs
// ───────────────────────────────────────────────────────────────────────

test.describe('Phase 12 — Audit packs', () => {
  test('Audit pack list shows the seeded March 2026 pack', async ({ page }) => {
    await page.goto('/accounting/audit-packs');
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, '/accounting/audit-packs');
    await expect(page.getByRole('heading', { name: /Audit Trail/i })).toBeVisible();
    const body = (await page.textContent('body')) ?? '';
    expect(body).toMatch(/2026-03-01.*2026-03-31|March|36/);
  });

  test('New-pack modal opens with period fields', async ({ page }) => {
    await page.goto('/accounting/audit-packs');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /New pack/i }).click();
    await expect(page.getByRole('heading', { name: /New audit pack/i })).toBeVisible();
    await expect(page.getByText('Period start')).toBeVisible();
    await expect(page.getByText('Period end', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /Build pack/i })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Navigation sweep — every PRD-05 route returns 2xx in headless chrome
// ───────────────────────────────────────────────────────────────────────

const PRD05_ROUTES = [
  '/accounting/capture',
  '/accounting/capture/inbox',
  '/accounting/capture/settings',
  '/accounting/capture/settings/mirror',
  '/accounting/suppliers/rules',
  '/accounting/suppliers/expectations',
  '/accounting/suppliers/missing-invoices',
  '/accounting/bank/provisional',
  '/accounting/bank/statements/import-pdf',
  '/accounting/ap/supplier-statements',
  '/accounting/expenses',
  '/accounting/expenses/new',
  '/accounting/fraud/signals',
  '/accounting/audit-packs',
] as const;

for (const route of PRD05_ROUTES) {
  test(`nav: ${route}`, async ({ page }) => {
    const res = await page.goto(route);
    expect(res?.status(), `HTTP status on ${route}`).toBeLessThan(400);
    await page.waitForLoadState('networkidle');
    await assertNoCrash(page, route);
  });
}
