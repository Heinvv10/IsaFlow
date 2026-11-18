// CONTRACT between the verify provisioner's API consumers and the real routes. verifyCompanyRoutes.json holds the `data` of every
// app route the seeding and readiness code calls, RECORDED from a real run of the provisioner (realDeps, scripts/deploy/verifyCompany)
// against the hosted golden stack (real next dev + real PG16 + real GoTrue) on 2026-11-18, arrays cut to two items. Each consumer's
// assumptions below are checked against those real bodies, and the real bodies are replayed through budgetProblems and the
// wrong-company guard. A route that changes shape makes the real run fail first; this test then says which assumption broke.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClientBase } from 'pg';
import type { Client } from '../../../scripts/ci/golden-hosted/seed-demo-app';
import { budgetProblems } from '../../../scripts/deploy/verifyCompany/budgetReadiness';
import { seedVerifyCompany } from '../../../scripts/deploy/verifyCompany/seedVerifyCompany';
import { EXPECTED_ROUTES, missingRoutes, recordKey, trimBody } from '../../../scripts/deploy/verifyCompany/recordRoutes';

const R = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/verifyCompanyRoutes.json'), 'utf8')) as Record<string, any>;
const NOW = new Date('2026-11-18T10:00:00Z');
const isId = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v);

describe('the fixture and its recorder', () => {
  it('carries a _recorded header (when, by what, how to redo it) and every route the consumers call', () => {
    expect(R._recorded).toMatchObject({ by: 'scripts/deploy/verifyCompany/recordRoutes.ts', redo: expect.stringContaining('recordRoutes.ts') });
    expect(Number.isNaN(Date.parse(R._recorded.at))).toBe(false);
    expect(missingRoutes(Object.fromEntries(Object.entries(R).filter(([k]) => !k.startsWith('_'))))).toEqual([]);
    expect(EXPECTED_ROUTES.length).toBeGreaterThan(15);
  });

  it('recordKey masks uuids and keeps the query; trimBody cuts long arrays at every depth; missingRoutes names what a re-run (no POSTs) lacks', () => {
    expect(recordKey('GET', '/api/payroll/employees/3a84c42b-f780-4b9e-b965-6b20b8791b9b/components?x=1')).toBe('GET /api/payroll/employees/:id/components?x=1');
    expect(trimBody({ a: Array.from({ length: 50 }, (_, i) => ({ b: [1, 2, 3], i })) }, 2)).toEqual({ a: [{ b: [1, 2], i: 0 }, { b: [1, 2], i: 1 }] });
    expect(missingRoutes({ 'GET /api/accounting/budgets?years_only=1': {} })).toContain('POST /api/accounting/journal-entries');
    expect(missingRoutes({ 'GET /api/accounting/budget-grid?fiscal_year=2031': {} })).not.toContain('GET /api/accounting/budget-grid?fiscal_year=2027');
  });
});

describe('the recorded bodies carry what each consumer reads', () => {
  it.each([
    'POST /api/accounting/customers', 'POST /api/payroll/components', 'POST /api/payroll/employees', 'POST /api/accounting/suppliers-list',
    'POST /api/accounting/supplier-invoices', 'POST /api/accounting/journal-entries', 'POST /api/accounting/budget-versions',
  ])('%s answers with the id of what it made', (route) => {
    expect(isId(R[route].id), route).toBe(true);
  });

  it('customer invoice create answers with id or invoiceId (seedCustomerInvoices reads either); approve answers with the status', () => {
    const made = R['POST /api/accounting/customer-invoices-create'];
    expect(isId(made.id ?? made.invoiceId)).toBe(true);
    expect(R['POST /api/accounting/customer-invoices-detail'].status).toBe('approved');
  });

  it('supplier-invoice approve and journal post answer with the settled document', () => {
    expect(R['POST /api/accounting/journal-entries-action'].status).toBe('posted');
    expect(R['POST /api/accounting/supplier-invoices-action'].invoiceNumber).toMatch(/^DEMO-AP-\d+$/);
  });

  it('the chart and bank lookups: a system default_revenue account and a first bank account with an id', () => {
    const accounts = R['GET /api/accounting/chart-of-accounts?subtype=default_revenue'];
    expect(Array.isArray(accounts) && accounts.some((a: any) => a.isSystemAccount === true && isId(a.id))).toBe(true);
    const banks = R['GET /api/accounting/bank-accounts'];
    expect(Array.isArray(banks) && isId(banks[0].id)).toBe(true);
  });

  it('the bulk commit reports how many rows it took (the seed trusts the import)', () => {
    expect(R['POST /api/accounting/bank-transactions-bulk-commit']).toMatchObject({ status: 'imported', duplicateCount: 0 });
    expect(R['POST /api/accounting/bank-transactions-bulk-commit'].transactionCount).toBeGreaterThan(0);
  });

  it('complete-setup answers with the company id (the provisioner then looks the company up by name)', () => {
    expect(isId(R['POST /api/onboarding/complete-setup'].companyId)).toBe(true);
  });

  it('user-companies: the active company id and the companies with name and is_demo', () => {
    const uc = R['GET /api/accounting/companies?action=user-companies'];
    expect(isId(uc.activeCompanyId)).toBe(true);
    for (const c of uc.items) expect(c).toMatchObject({ companyName: expect.any(String), isDemo: expect.any(Boolean) });
  });

  it('budgets: the current budget year is a number and the years are listed', () => {
    const b = R['GET /api/accounting/budgets?years_only=1'];
    expect(typeof b.fiscalYear).toBe('number');
    expect(b.years.length).toBeGreaterThan(0);
  });

  it('the grid and the prior-year actuals carry the fields budgetProblems reads', () => {
    for (const a of R['GET /api/accounting/budget-grid?fiscal_year=2027'].accounts) {
      expect(a).toMatchObject({ id: expect.any(String), band: expect.any(String), isActive: expect.any(Boolean), isHeader: expect.any(Boolean) });
    }
    for (const c of R['GET /api/accounting/budget-grid/prior-actuals?fiscal_year=2027&grain=company'].cells) {
      expect(c).toMatchObject({ glAccountId: expect.any(String), amount: expect.any(Number) });
    }
    for (const fy of [2027, 2028]) expect(R[`GET /api/accounting/budget-versions?fiscalYear=${fy}`].items.length).toBeGreaterThan(0);
  });
});

/** A client whose GETs are the recorded bodies. */
const replay = (over: Record<string, unknown> = {}) => ({
  get: async (p: string) => {
    const k = `GET ${p}`;
    if (k in over) return over[k];
    if (!(k in R)) throw new Error(`no recorded body for ${k}`);
    return R[k];
  },
}) as unknown as Pick<Client, 'get'>;

describe('the real bodies, replayed through the code that consumes them', () => {
  it('budgetProblems finds nothing wrong with the company the real provisioning made', async () => {
    expect(await budgetProblems(replay(), NOW)).toEqual([]);
  });

  it('...and finds the real gap: the same bodies with the prior-year actuals gone', async () => {
    const key = 'GET /api/accounting/budget-grid/prior-actuals?fiscal_year=2027&grain=company';
    const gone = { ...R[key], cells: R[key].cells.map((c: any) => ({ ...c, amount: 0 })) };
    expect((await budgetProblems(replay({ [key]: gone }), NOW)).join()).toMatch(/prior-year actuals/);
  });

  it('the wrong-company guard accepts the real active company and refuses any other', async () => {
    const uc = R['GET /api/accounting/companies?action=user-companies'];
    const api = { get: async () => uc } as unknown as Client;
    const o = { baseUrl: 'http://app', email: 'e', password: 'p', verifyUserId: 'u', now: NOW };
    await expect(seedVerifyCompany({} as ClientBase, { ...o, companyId: uc.activeCompanyId }, [], async () => api)).resolves.toEqual([]);
    await expect(seedVerifyCompany({} as ClientBase, { ...o, companyId: '00000000-0000-4000-8000-000000000000' }, [], async () => api)).rejects.toThrow(/not backed by the database/);
  });
});
