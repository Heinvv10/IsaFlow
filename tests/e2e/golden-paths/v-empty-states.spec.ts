/**
 * Golden path (v): main-screen skeletons and signature empty states (master plan wave 1, K).
 *
 * Runs in ONE dedicated empty company ("0GP Golden Empty Sandbox", created on first use through
 * self-serve onboarding with a fixed key, like the migration sandbox) so the lists are a true first run:
 *   - each main list shows its signature empty state with "Try the demo company";
 *   - a search with no match shows "No results" and never the demo offer;
 *   - "Try the demo company" lands on the demo company (found by isDemo) with data;
 *   - a slow list paints a skeleton, not a spinner.
 * Needs the demo company to carry companies.is_demo = true (a platform-admin flag): without it the
 * spec fails on the missing offer, which is the point.
 * Read-only apart from the sandbox's creation. Light and dark screenshots.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'fs';
import { Api } from './_api';
import { activeCompanyId, findOrCreateSandbox, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const SHOTS = 'docs/evidence/master-plan/wave1/empty-states';
const SANDBOX_NAME = '0GP Golden Empty Sandbox';
const SANDBOX_ONBOARDING_ID = '7d3e9a14-2b6c-4f58-9a01-c3e5b7d9f102';
const OFFER = 'Try the demo company';

const LISTS = [
  { slug: 'customer-invoices', path: '/accounting/customer-invoices', title: 'No invoices yet' },
  { slug: 'supplier-invoices', path: '/accounting/supplier-invoices', title: 'No supplier invoices yet' },
  { slug: 'customers', path: '/accounting/customers', title: 'No customers yet' },
  { slug: 'suppliers', path: '/accounting/suppliers', title: 'No suppliers yet' },
  { slug: 'employees', path: '/payroll/employees', title: 'No employees yet' },
  { slug: 'pay-runs', path: '/payroll/runs', title: 'No payroll runs yet' },
] as const;

let sandboxId = '';
let demoId = '';
let startedOn = '';

test.beforeAll(async ({ baseURL }) => {
  // Creates a company and relies on a dev-only data flag: never against production.
  expect(new URL(baseURL!).hostname, 'v-empty-states is a dev/CI spec, not a production check').not.toMatch(/(^|\.)isaflow\.co\.za$/);
  const api = await Api.login(baseURL!);
  try {
    const uc = await api.get<{ items: Array<{ companyId: string; isDemo?: boolean }>; activeCompanyId: string }>(
      '/api/accounting/companies?action=user-companies');
    startedOn = uc.activeCompanyId;
    demoId = uc.items.find((c) => c.isDemo)?.companyId ?? '';
    expect(demoId, 'the user needs a membership in the demo company (companies.is_demo = true)').toBeTruthy();
    sandboxId = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ context }) => {
  await switchBrowserCompany(context, sandboxId);
});

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await settle(page);
}

for (const list of LISTS) {
  test(`${list.slug}: a true first run shows the signature empty state and the demo offer`, async ({ page }) => {
    mkdirSync(SHOTS, { recursive: true });
    for (const theme of THEMES) {
      await seedTheme(page, theme);
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(page, list.path);
      await expect(page.getByRole('heading', { name: list.title })).toBeVisible();
      await expect(page.getByRole('button', { name: OFFER })).toBeVisible();
      await page.waitForSelector(`html[data-theme-applied="${theme}"]`);
      const contrast = await new AxeBuilder({ page }).include('[data-testid="empty-state"]').withRules(['color-contrast']).analyze();
      expect(contrast.violations.flatMap((v) => v.nodes.map((n) => n.target.join(' '))), `${theme} empty-state contrast`).toEqual([]);
      await page.screenshot({ path: `${SHOTS}/${list.slug}-empty-${theme}.png` });
    }
  });
}

test('customers: a search with no match says No results and never offers the demo', async ({ page }) => {
  await open(page, '/accounting/customers');
  await page.getByPlaceholder(/search by name/i).fill('zz-no-such-customer');
  await expect(page.getByRole('heading', { name: 'No results' })).toBeVisible();
  await expect(page.getByRole('button', { name: OFFER })).toHaveCount(0);
  // Keyboard: the next Tab stop after the search box is "Clear filters", and Enter clears.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Clear filters' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'No customers yet' })).toBeVisible();
});

test('"Try the demo company" lands on the demo company with data', async ({ page, context }) => {
  await open(page, '/accounting/customers');
  await page.getByRole('button', { name: OFFER }).click();
  await expect.poll(async () => {
    const res = await context.request.get('/api/accounting/companies?action=user-companies');
    return (await res.json())?.data?.activeCompanyId;
  }, { timeout: 30_000 }).toBe(demoId);
  await page.goto('/accounting/customers');
  await settle(page);
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  await expect(page.getByRole('button', { name: OFFER })).toHaveCount(0);
});

test('a slow list paints a skeleton, not a spinner', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await seedTheme(page, theme);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.route('**/api/accounting/customers*', async (route) => {
      await new Promise((r) => setTimeout(r, 4_000));
      await route.continue();
    });
    await page.goto('/accounting/customers');
    const skeleton = page.getByRole('status', { name: 'Loading customers' });
    await expect(skeleton).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('main .animate-spin')).toHaveCount(0);
    await page.waitForSelector(`html[data-theme-applied="${theme}"]`);
    await page.screenshot({ path: `${SHOTS}/customers-skeleton-${theme}.png` });
    await page.unroute('**/api/accounting/customers*');
    await expect(skeleton).toBeHidden({ timeout: 30_000 });
  }
});

test('the shared session is still on the company the suite started on', async () => {
  // switchBrowserCompany only moves each test's own context: the shared session file still points where it did.
  const api = await Api.login(test.info().project.use.baseURL!);
  try {
    expect(await activeCompanyId(api)).toBe(startedOn);
  } finally {
    await api.dispose();
  }
});
