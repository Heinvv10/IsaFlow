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
 * idempotent: a second complete-setup with it replays the first company.
 *
 * Switching is per request context: POST /api/auth/switch-company sets the
 * active_company_id cookie of the context that called it, nothing server-side,
 * so the shared golden session file other specs load still points at Demo.
 */
import { expect, type BrowserContext } from '@playwright/test';
import type { Api } from './_api';

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
  await api.post('/api/onboarding/complete-setup', {
    requestKey: MIGRATION_SANDBOX_ONBOARDING_ID,
    entityType: 'other', // the one entity with no proof document to upload
    coaTemplate: 'isaflow_standard',
    company: { name: MIGRATION_SANDBOX_NAME, vatPeriod: 'bi-monthly', vatNumber: '4000000000' },
    people: [],
    documents: [],
  });
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
