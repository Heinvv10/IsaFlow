/**
 * The migration-wizard spec's own company (m-migration-wizard.spec.ts).
 *
 * A take-on writes company-wide state — an opening trial balance, a migration
 * session and its step flags — that no supported API fully removes (reversing
 * the journal leaves the session and its flags). So the spec never runs the
 * wizard in Demo: it runs it in ONE dedicated company, found by name and
 * created on first use through the self-serve onboarding route
 * (POST /api/onboarding/complete-setup, entity 'other', standard chart), and
 * reused forever, like the payroll sandbox month and the 0GP fixture masters.
 *
 * One company per environment, never one per run: a per-run company could
 * only be soft-deleted (admin DELETE sets status='deleted'; the row and its
 * books stay), so a per-run sandbox would leave a dead company behind on every
 * post-deploy run against prod. The fixed requestKey makes creation
 * idempotent: a second complete-setup with it replays the first company. If
 * an admin deactivates or deletes the sandbox, the key 409s; the spec then
 * fails with the remedy rather than a bare status.
 *
 * Switching is per request context: POST /api/auth/switch-company sets the
 * active_company_id cookie of the context that called it, nothing server-side,
 * so the shared golden session file other specs load still points at Demo.
 */
import { expect, type BrowserContext } from '@playwright/test';
import { ApiError, type Api } from './_api';

export const MIGRATION_SANDBOX_NAME = '0GP Golden Migration Sandbox';
/** Fixed onboarding key: a repeat create returns the same company (migration 895). */
const MIGRATION_SANDBOX_ONBOARDING_ID = '6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

interface UserCompanies {
  items: Array<{ companyId: string; companyName: string }>;
  activeCompanyId: string;
}

export async function activeCompanyId(api: Api): Promise<string> {
  return (await api.get<UserCompanies>('/api/accounting/companies?action=user-companies')).activeCompanyId;
}

export async function findOrCreateMigrationSandbox(api: Api): Promise<string> {
  const find = async () => {
    const uc = await api.get<UserCompanies>('/api/accounting/companies?action=user-companies');
    return uc.items.find((c) => c.companyName === MIGRATION_SANDBOX_NAME)?.companyId;
  };
  const found = await find();
  if (found) return found;
  const setup = await api.postRaw('/api/onboarding/complete-setup', {
    requestKey: MIGRATION_SANDBOX_ONBOARDING_ID,
    entityType: 'other', // the one entity with no proof document to upload
    coaTemplate: 'isaflow_standard',
    company: { name: MIGRATION_SANDBOX_NAME, vatPeriod: 'bi-monthly', vatNumber: '4000000000' },
    people: [],
    documents: [],
  });
  // 409: the key's company exists but was deactivated or soft-deleted, so the
  // finder above skips it and the key cannot create a second one.
  expect(setup.status, setup.status === 409
    ? `"${MIGRATION_SANDBOX_NAME}" was deactivated or deleted for this user; reactivate it (companies.is_active/status) `
      + 'or change MIGRATION_SANDBOX_ONBOARDING_ID in _migrationSandbox.ts to create a fresh one'
    : JSON.stringify(setup.json)).toBe(200);
  const created = await find();
  expect(created, 'onboarding must have created the migration sandbox').toBeTruthy();
  return created!;
}

/** Point this API context at `companyId` and prove the server now scopes it there. */
export async function switchApiCompany(api: Api, companyId: string): Promise<void> {
  await api.post('/api/auth/switch-company', { companyId });
  expect(await activeCompanyId(api), 'API context must be scoped to the switched company').toBe(companyId);
}

/** The same for a browser context (its own cookie jar, seeded from the golden session). */
export async function switchBrowserCompany(context: BrowserContext, companyId: string): Promise<void> {
  const csrf = (await context.cookies()).find((c) => c.name === 'isaflow_csrf')?.value ?? '';
  expect(csrf, 'golden session must carry the CSRF cookie').toBeTruthy();
  const res = await context.request.post('/api/auth/switch-company', {
    data: { companyId },
    headers: { 'x-csrf-token': csrf },
  });
  expect(res.status(), await res.text()).toBe(200);
  const uc = await (await context.request.get('/api/accounting/companies?action=user-companies')).json();
  expect(uc?.data?.activeCompanyId, 'browser context must be scoped to the switched company').toBe(companyId);
}

/**
 * The first ledger row on `accountCode` between `from` and `to` that `match` accepts, reading every page.
 * The sandbox outlives each run and every run posts into the same period, so its ledger grows past one
 * page (200 rows by default; 2026-10-24 the 1120 ledger reached 208 and the newest row fell off page 1).
 */
export async function findLedgerRow(api: Api, accountCode: string, from: string, to: string,
  match: (row: any) => boolean): Promise<any | undefined> {
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const page = await api.get<{ rows: any[]; total: number }>(
      `/api/accounting/reports-account-ledger?account_code=${accountCode}&from=${from}&to=${to}&limit=${limit}&offset=${offset}`,
    );
    const hit = page.rows.find(match);
    if (hit || page.rows.length < limit || offset + limit >= page.total) return hit;
  }
}

/** Stale take-ons that cannot be cancelled (paid or posted) tolerated before the run fails. */
export const MAX_UNCANCELLABLE_STALE = 5;

// The sandbox accumulates cancelled GP-MIG-AR invoices (148 vs a 100 page cap), so a single page of the
// prefix search can miss a row. The list API takes a repeated `status` filter but no negation, so name
// every live status to keep cancelled rows out of the walk.
const LIVE_STATUSES = ['draft', 'pending_approval', 'approved', 'sent', 'partially_paid', 'paid', 'overdue']
  .map((s) => `&status=${s}`).join('');

/** One page (100) of live take-on invoices whose number or customer matches `q`. */
export async function listTakeOnPage(api: Api, q: string, page: number): Promise<any[]> {
  return (await api.get<{ invoices: any[] }>(
    `/api/accounting/customer-invoices-list?q=${encodeURIComponent(q)}&limit=100&page=${page}${LIVE_STATUSES}`,
  )).invoices;
}

async function staleTakeOns(api: Api): Promise<any[]> {
  const found: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const invoices = await listTakeOnPage(api, 'GP-MIG-AR', page);
    if (invoices.length && page > 1 && invoices[0].id === found[found.length - 100]?.id) {
      throw new Error('customer-invoices-list ignored ?page: a page repeated the previous one');
    }
    found.push(...invoices);
    if (invoices.length < 100) return found;
  }
  throw new Error('more than 50 pages of live GP-MIG-AR invoices');
}

/** Cancels take-ons left by a run that died before its cancel; returns a note per row it could not. */
export async function cancelStaleTakeOns(api: Api): Promise<string[]> {
  const skipped: string[] = [];
  for (const stale of await staleTakeOns(api)) {
    try {
      await api.post('/api/accounting/customer-invoices-detail', { id: stale.id, action: 'cancel' });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 400) throw err;
      skipped.push(`${stale.invoice_number}: ${err.message}`);
    }
  }
  return skipped;
}
