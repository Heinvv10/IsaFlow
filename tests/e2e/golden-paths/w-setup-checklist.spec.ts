/**
 * Golden path (w): the per-module setup checklist on Home (master-plan W1 PR C).
 *
 * 1. A dedicated sandbox company (created once through self-serve onboarding with a
 *    fixed requestKey, like the migration sandbox, then reused) has no
 *    customers at first: its Sales "Add a customer" task is open. Creating a customer marks
 *    Sales 1 done, and Home shows the card. A customer cannot be deleted, so the
 *    strict "Sales has nothing yet" start is asserted on the first run only; later runs
 *    assert the same rule from the other side (done <=> a customer exists).
 * 2. Demo: the card and the Action Items "All caught up" state follow the data.
 *    The card is hidden exactly when the API says every task is done.
 */
import { test, expect } from '@playwright/test';
import { Api } from './_api';
import { activeCompanyId, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';

// Creates a sandbox company and a permanent customer, so it is a dev/CI gate only:
// playwright-golden.config.ts leaves it out of the production post-deploy verify.
const PROD_HOST = /(^|\.)app\.isaflow\.co\.za$/;

test.beforeAll(({}, testInfo) => {
  const host = new URL(String(testInfo.project.use.baseURL ?? 'http://localhost')).hostname;
  if (PROD_HOST.test(host)) throw new Error('w-setup-checklist writes a sandbox company and a customer: never run it against production');
});

const SANDBOX_NAME = '0GP Golden Checklist Sandbox';
const SANDBOX_ONBOARDING_ID = '3b9f1c7e-52d4-4a8b-9e61-7c0d2f4a6b18';
const CUSTOMER_NAME = '0GP-Checklist-Customer';

interface Checklist {
  doneCount: number;
  totalCount: number;
  allComplete: boolean;
  modules: Array<{ id: string; doneCount: number; complete: boolean; tasks: Array<{ id: string; done: boolean }> }>;
}
interface UserCompanies { items: Array<{ companyId: string; companyName: string }> }

async function findOrCreateSandbox(api: Api): Promise<string> {
  const find = async () => (await api.get<UserCompanies>('/api/accounting/companies?action=user-companies'))
    .items.find((c) => c.companyName === SANDBOX_NAME)?.companyId;
  const found = await find();
  if (found) return found;
  const setup = await api.postRaw('/api/onboarding/complete-setup', {
    requestKey: SANDBOX_ONBOARDING_ID,
    entityType: 'other',
    coaTemplate: 'isaflow_standard',
    company: { name: SANDBOX_NAME, vatPeriod: 'bi-monthly', vatNumber: '4000000001' },
    people: [],
    documents: [],
  });
  expect(setup.status, setup.status === 409
    ? `"${SANDBOX_NAME}" was deactivated or deleted; reactivate it or change SANDBOX_ONBOARDING_ID`
    : JSON.stringify(setup.json)).toBe(200);
  const created = await find();
  expect(created, 'onboarding must have created the checklist sandbox').toBeTruthy();
  return created!;
}

const salesCustomerTask = (c: Checklist) =>
  c.modules.find((m) => m.id === 'sales')!.tasks.find((t) => t.id === 'customers')!.done;

test('setup checklist: a company with no customers has Sales open; adding one marks Sales 1 done', async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  const api = await Api.login(baseURL!);
  const home = await activeCompanyId(api);
  let browserSwitched = false;
  try {
    const sandbox = await findOrCreateSandbox(api);
    await switchApiCompany(api, sandbox);

    const existing = await api.get<any[]>(`/api/accounting/customers?q=${encodeURIComponent(CUSTOMER_NAME)}`);
    const hasCustomer = Array.isArray(existing) && existing.some((r) => r?.name === CUSTOMER_NAME);
    const before = await api.get<Checklist>('/api/accounting/setup-checklist');
    expect(salesCustomerTask(before), 'the customers task is done exactly when a customer exists').toBe(hasCustomer);
    if (!hasCustomer) {
      // Onboarding itself sets the VAT number/period and a bank account; the sales trade has nothing yet.
      expect(before.modules.find((m) => m.id === 'sales')!.doneCount).toBe(0);
      expect(before.allComplete).toBe(false);
    }

    if (!hasCustomer) await api.post('/api/accounting/customers', { name: CUSTOMER_NAME });
    const after = await api.get<Checklist>('/api/accounting/setup-checklist');
    expect(salesCustomerTask(after)).toBe(true);
    expect(after.modules.find((m) => m.id === 'sales')!.doneCount).toBeGreaterThanOrEqual(1);
    if (!hasCustomer) {
      expect(after.modules.find((m) => m.id === 'sales')!.doneCount).toBe(1);
      expect(after.doneCount).toBe(before.doneCount + 1);
    }

    await switchBrowserCompany(page.context(), sandbox);
    browserSwitched = true;
    await page.goto('/accounting');
    // The overview renders after its KPI load (slow on a loaded runner); wait for it, then for the card,
    // and say where the page ended up if the card is missing.
    await expect(page.getByRole('heading', { name: 'Action Items' })).toBeVisible({ timeout: 90_000 });
    const card = page.getByRole('region', { name: 'Finish setting up' });
    await card.waitFor({ state: 'visible', timeout: 60_000 }).catch(async (err: unknown) => {
      const text = (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600);
      throw new Error(`checklist card missing on ${page.url()}: ${String(err)}\nmain: ${text}`);
    });
    await expect(card).toBeVisible();
    await expect(card).toContainText(`${after.doneCount} of ${after.totalCount} done`);
    await expect(card.getByRole('button', { name: /Sales/ })).toContainText(`${after.modules[0]!.doneCount}/`);
  } finally {
    if (browserSwitched) await switchBrowserCompany(page.context(), home);
    await switchApiCompany(api, home);
    await api.dispose();
  }
});

test('setup checklist: on Demo the card hides exactly when every task is done', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const api = await Api.login(baseURL!);
  try {
    const checklist = await api.get<Checklist>('/api/accounting/setup-checklist');
    const todos = await api.get<{
      overdueInvoiceCount: number; pendingSupplierPayments: unknown[]; uncategorizedBankTxns: number; draftInvoices: number;
    }>('/api/accounting/dashboard-todos');
    const noActions = todos.overdueInvoiceCount === 0 && todos.pendingSupplierPayments.length === 0
      && todos.uncategorizedBankTxns === 0 && todos.draftInvoices === 0;

    expect(checklist.allComplete).toBe(checklist.modules.every((m) => m.complete));
    expect(checklist.doneCount).toBe(checklist.modules.reduce((n, m) => n + m.tasks.filter((t) => t.done).length, 0));

    await page.goto('/accounting');
    await expect(page.getByRole('heading', { name: 'Action Items' })).toBeVisible({ timeout: 30_000 });
    const card = page.getByRole('region', { name: 'Finish setting up' });
    await expect(card).toHaveCount(checklist.allComplete ? 0 : 1);
    await expect(page.getByText('All caught up!')).toHaveCount(noActions ? 1 : 0);
  } finally {
    await api.dispose();
  }
});
