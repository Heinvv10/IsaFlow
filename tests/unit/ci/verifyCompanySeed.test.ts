// The seeding of the verify company: the wrong-company guard (an app backed by another database writes nothing), the block loop
// and its plan, RESUMING a half-made block without doubling what exists, the markers the seeders write and the queries find, and
// the budget readiness the budget specs need.
import { describe, expect, it, vi } from 'vitest';
import type { ClientBase } from 'pg';
import { Client, seedBankRows, seedCustomers, seedEmployee, seedJournals, seedSuppliersAndInvoices } from '../../../scripts/ci/golden-hosted/seed-demo-app';
import { seedCustomerInvoices } from '../../../scripts/ci/golden-hosted/seed-golden-fixtures';
import { MARK, complete, markerIndex, missing, type Progress } from '../../../scripts/ci/golden-hosted/seedMarkers';
import { buildBlocks, type Block } from '../../../scripts/deploy/verifyCompany/seedBlocks';
import { planBlocks, seedVerifyCompany } from '../../../scripts/deploy/verifyCompany/seedVerifyCompany';
import { budgetProblems } from '../../../scripts/deploy/verifyCompany/budgetReadiness';
import { fyLabel, fyStartYear, midFy, periodAnchors } from '../../../scripts/deploy/verifyCompany/provisionDb';

const NOW = new Date('2026-11-18T10:00:00Z');
const MONTHS = ['2026-01', '2026-02', '2026-03'];
const db = {} as ClientBase;
const prog = (ids: Array<[number, string]>, done: number[]): Progress => ({ ids: new Map(ids), done: new Set(done) });

/** A client that records every call and answers posts with sequential ids. */
function fakeApi(get: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let n = 0;
  const api = {
    get: vi.fn(async (path: string) => get[path] ?? []),
    post: vi.fn(async (path: string, body: Record<string, unknown>) => { calls.push({ path, body }); return { id: `new-${++n}` }; }),
  } as unknown as Client;
  return { api, calls };
}

describe('seedVerifyCompany: the wrong-company guard', () => {
  const block = (name: string, ran: string[], complete: boolean): Block => ({ name, plan: async () => ({ complete, run: async () => { ran.push(name); } }) });

  it('refuses, writing nothing, when the app puts the verify user in another company (the app is not on the provisioned database)', async () => {
    const ran: string[] = [];
    const { api } = fakeApi({ '/api/accounting/companies?action=user-companies': { activeCompanyId: 'someone-elses' } });
    await expect(seedVerifyCompany(db, { baseUrl: 'http://app', email: 'e', password: 'p', companyId: 'co-1', verifyUserId: 'u1', now: NOW }, [block('b', ran, false)], async () => api))
      .rejects.toThrow(/puts the verify user in company someone-elses, not co-1.*nothing was seeded/s);
    expect(ran).toEqual([]);
  });

  it('refuses when the user has no active company at all', async () => {
    const ran: string[] = [];
    const { api } = fakeApi({ '/api/accounting/companies?action=user-companies': {} });
    await expect(seedVerifyCompany(db, { baseUrl: 'http://app', email: 'e', password: 'p', companyId: 'co-1', verifyUserId: 'u1', now: NOW }, [block('b', ran, false)], async () => api)).rejects.toThrow(/company none/);
    expect(ran).toEqual([]);
  });

  it('runs exactly the blocks that are not complete, in order, and reports them', async () => {
    const ran: string[] = [];
    const { api } = fakeApi({ '/api/accounting/companies?action=user-companies': { activeCompanyId: 'co-1' } });
    const done = await seedVerifyCompany(db, { baseUrl: 'http://app', email: 'e', password: 'p', companyId: 'co-1', verifyUserId: 'u1', now: NOW },
      [block('one', ran, true), block('two', ran, false), block('three', ran, false), block('four', ran, true)], async () => api);
    expect(done).toEqual(['two', 'three']);
    expect(ran).toEqual(['two', 'three']);
  });

  it('a block that throws stops the run: later blocks never start', async () => {
    const ran: string[] = [];
    const { api } = fakeApi({ '/api/accounting/companies?action=user-companies': { activeCompanyId: 'co-1' } });
    const bad: Block = { name: 'bad', plan: async () => ({ complete: false, run: async () => { throw new Error('boom'); } }) };
    await expect(seedVerifyCompany(db, { baseUrl: 'http://app', email: 'e', password: 'p', companyId: 'co-1', verifyUserId: 'u1', now: NOW }, [bad, block('after', ran, false)], async () => api)).rejects.toThrow('boom');
    expect(ran).toEqual([]);
  });
});

describe('planBlocks', () => {
  it('says make for every block when there is no company yet, and reads each block\'s state otherwise', async () => {
    const mk = (name: string, complete: boolean): Block => ({ name, plan: async () => ({ complete, run: async () => undefined }) });
    expect(await planBlocks(db, null, [mk('a', true), mk('b', false)])).toEqual([{ name: 'a', state: 'make' }, { name: 'b', state: 'make' }]);
    expect(await planBlocks(db, { companyId: 'c', verifyUserId: 'u', now: NOW }, [mk('a', true), mk('b', false)])).toEqual([{ name: 'a', state: 'skip' }, { name: 'b', state: 'make' }]);
  });

  it('plans the real blocks in dependency order: the invoices after the customers they bill, the journals after the chart', () => {
    const names = buildBlocks().map((b) => b.name);
    expect(names.indexOf('customers')).toBeLessThan(names.indexOf('approved customer invoices'));
    expect(names).toContain('budget original version, current year');
    expect(names).toContain('budget original version, next year');
    expect(names).toContain('migration sandbox company');
    expect(names).toContain('prior-year actuals journal');
  });
});

describe('the markers', () => {
  it.each([
    ['customer', MARK.customer, 'Demo Customer 3', 3], ['supplier', MARK.supplier, 'Demo Supplier 12', 12],
    ['AP invoice', MARK.apInvoice, 'DEMO-AP-7', 7], ['AR note', MARK.arNote, 'DEMO-AR-9', 9], ['journal', MARK.journal, 'DEMO-JNL-4', 4],
  ])('%s: what the seeder writes is what the query finds, by index', (_n, m, text, i) => {
    expect(m.build(i)).toBe(text);
    expect(markerIndex(m, text)).toBe(i);
    expect(markerIndex(m, `${text} extra`)).toBeNull();
    expect(markerIndex(m, `x${text}`)).toBeNull();
  });

  it('bank rows: both descriptions the seeder writes are found, anything else is not', () => {
    expect(markerIndex(MARK.bank, MARK.bank.build(5, true))).toBe(5);
    expect(markerIndex(MARK.bank, MARK.bank.build(6, false))).toBe(6);
    expect(markerIndex(MARK.bank, 'DEMO-BNK 5 groceries')).toBeNull();
  });

  it('the prior-year journal marker is not read as one of the numbered journals', () => {
    expect(markerIndex(MARK.journal, 'DEMO-JNL-PY')).toBeNull();
  });

  it('progress helpers: missing and complete', () => {
    const p = prog([[1, 'a'], [3, 'c']], [1]);
    expect(missing(4, p)).toEqual([2, 4]);
    expect(complete(1, p)).toBe(true);
    expect(complete(3, p)).toBe(false); // 3 exists but is not done
  });
});

describe('the seeders write the markers the queries look for, and RESUME', () => {
  it('customers: only the absent ones are made', async () => {
    const { api, calls } = fakeApi();
    const ids = await seedCustomers(api, { suppliers: 0, invoices: 0, journals: 0, bankRows: 0, customers: 4 }, prog([[1, 'c1'], [3, 'c3']], [1, 3]));
    expect(calls.map((c) => c.body.name)).toEqual(['Demo Customer 2', 'Demo Customer 4']);
    expect(ids).toEqual(['c1', 'new-1', 'c3', 'new-2']);
  });

  it('the shared empty progress is never mutated: a second seed from nothing makes them all again', async () => {
    const counts = { suppliers: 0, invoices: 0, journals: 0, bankRows: 0, customers: 2 };
    await seedCustomers(fakeApi().api, counts);
    const second = fakeApi();
    await seedCustomers(second.api, counts);
    expect(second.calls).toHaveLength(2);
  });

  it('supplier invoices: 5 of 12 approved resumes as 7 created and approved, and an invoice made but not approved is approved, not made again', async () => {
    const { api, calls } = fakeApi();
    const counts = { suppliers: 2, invoices: 12, journals: 0, bankRows: 0, customers: 0 };
    const done = [1, 2, 3, 4, 5];
    const invoices = prog([...done.map((i): [number, string] => [i, `inv${i}`]), [6, 'inv6']], done); // 6 exists, not approved
    await seedSuppliersAndInvoices(api, MONTHS, counts, { suppliers: prog([[1, 's1'], [2, 's2']], [1, 2]), invoices });
    const created = calls.filter((c) => c.path === '/api/accounting/supplier-invoices').map((c) => c.body.invoiceNumber);
    expect(created).toEqual(['DEMO-AP-7', 'DEMO-AP-8', 'DEMO-AP-9', 'DEMO-AP-10', 'DEMO-AP-11', 'DEMO-AP-12']);
    const approved = calls.filter((c) => c.path === '/api/accounting/supplier-invoices-action').map((c) => c.body.invoiceId);
    expect(approved).toHaveLength(7);
    expect(approved[0]).toBe('inv6'); // the unapproved one, by its existing id
    expect(calls.some((c) => c.path === '/api/accounting/suppliers-list')).toBe(false); // the suppliers exist
  });

  it('customer invoices: the same resume', async () => {
    const { api, calls } = fakeApi();
    await seedCustomerInvoices(api, () => '2026-01-10', ['c1'], prog([[1, 'a'], [2, 'b']], [1]));
    const created = calls.filter((c) => c.path === '/api/accounting/customer-invoices-create').map((c) => c.body.notes);
    expect(created).toHaveLength(10);
    expect(created).not.toContain('DEMO-AR-1');
    expect(created).not.toContain('DEMO-AR-2');
    expect(calls.filter((c) => c.path === '/api/accounting/customer-invoices-detail')[0]!.body.id).toBe('b'); // 2 exists as a draft
  });

  it('journals: a draft is posted (never made again); a posted one is left alone', async () => {
    const { api, calls } = fakeApi({
      '/api/accounting/chart-of-accounts?subtype=default_revenue': [{ id: 'rev', isSystemAccount: true }],
      '/api/accounting/bank-accounts': [{ id: 'bank' }],
    });
    await seedJournals(api, MONTHS, { suppliers: 0, invoices: 0, journals: 4, bankRows: 0, customers: 0 }, prog([[1, 'j1'], [2, 'j2']], [1]));
    const made = calls.filter((c) => c.path === '/api/accounting/journal-entries').map((c) => c.body.description);
    expect(made).toEqual(['DEMO-JNL-3', 'DEMO-JNL-4']);
    const posted = calls.filter((c) => c.path === '/api/accounting/journal-entries-action').map((c) => c.body.id);
    expect(posted).toHaveLength(3);
    expect(posted[0]).toBe('j2'); // the draft that exists, by its id; the two others are the ones just made
  });

  it('bank rows: only the missing rows are sent, and nothing at all when every row is there', async () => {
    const counts = { suppliers: 0, invoices: 0, journals: 0, bankRows: 6, customers: 0 };
    const some = fakeApi({ '/api/accounting/bank-accounts': [{ id: 'bank' }] });
    await seedBankRows(some.api, MONTHS, '2026-11-18', counts, new Set([1, 2, 3]));
    const csv = String(some.calls[0]!.body.csvContent);
    expect(csv.split('\n')).toHaveLength(1 + 3);
    expect(csv).toContain('DEMO-BNK 4 ');
    expect(csv).not.toContain('DEMO-BNK 1 ');
    const none = fakeApi({ '/api/accounting/bank-accounts': [{ id: 'bank' }] });
    await seedBankRows(none.api, MONTHS, '2026-11-18', counts, new Set([1, 2, 3, 4, 5, 6]));
    expect(none.calls).toEqual([]);
  });

  it('the employee: an earlier run that stopped between its three writes is finished, not repeated', async () => {
    const full = fakeApi();
    await seedEmployee(full.api);
    expect(full.calls.map((c) => c.path)).toEqual(['/api/payroll/components', '/api/payroll/employees', '/api/payroll/employees/new-2/components']);
    const noLink = fakeApi();
    await seedEmployee(noLink.api, { componentId: 'comp', employeeId: 'emp', attached: false });
    expect(noLink.calls.map((c) => c.path)).toEqual(['/api/payroll/employees/emp/components']);
    expect(noLink.calls[0]!.body.componentId).toBe('comp');
    const noEmp = fakeApi();
    await seedEmployee(noEmp.api, { componentId: 'comp', employeeId: null, attached: false });
    expect(noEmp.calls.map((c) => c.path)).toEqual(['/api/payroll/employees', '/api/payroll/employees/new-1/components']);
  });
});

describe('the financial years', () => {
  it('follow the March year: FY label = the calendar year the year ends in', () => {
    expect(fyLabel(new Date('2026-11-18T00:00:00Z'))).toBe(2027);
    expect(fyLabel(new Date('2027-02-28T00:00:00Z'))).toBe(2027);
    expect(fyLabel(new Date('2027-03-01T00:00:00Z'))).toBe(2028);
    expect(fyStartYear(new Date('2027-01-05T00:00:00Z'))).toBe(2026);
  });

  it('every run date gets periods for the previous, current and next year, plus the fixed dates the specs post into', () => {
    expect(periodAnchors(NOW)).toEqual(expect.arrayContaining(['2025-06-01', '2026-06-01', '2027-01-15', '2025-08-15', '2026-11-18', '2027-08-15']));
    expect(midFy(new Date('2027-02-10T00:00:00Z'), -1)).toBe('2025-08-15'); // January/February: the previous year is two calendar years back
  });
});

describe('budgetProblems', () => {
  const lines = (...bands: string[]) => bands.map((band, i) => ({ id: `a${i}`, band, isActive: true, isHeader: false }));
  function api(over: { years?: number; versions?: Record<number, number>; grid?: ReturnType<typeof lines>; cells?: Array<{ glAccountId: string; amount: number }> } = {}) {
    const grid = over.grid ?? lines('turnover', 'cost_of_sales', 'operating_expense');
    const get = async (path: string): Promise<unknown> => {
      if (path.startsWith('/api/accounting/budgets?')) return { fiscalYear: over.years ?? 2027 };
      const v = /budget-versions\?fiscalYear=(\d+)/.exec(path);
      if (v) return { items: Array.from({ length: (over.versions ?? { 2027: 1, 2028: 1 })[Number(v[1])] ?? 0 }) };
      if (path.startsWith('/api/accounting/budget-grid/prior-actuals')) return { cells: over.cells ?? [{ glAccountId: 'a0', amount: 5000 }] };
      return { accounts: grid };
    };
    return { get } as unknown as Pick<Client, 'get'>;
  }

  it('is empty when the specs would run', async () => { expect(await budgetProblems(api(), NOW)).toEqual([]); });

  it('names a missing version for the current or the next year', async () => {
    expect((await budgetProblems(api({ versions: { 2027: 1 } }), NOW)).join()).toMatch(/no budget version for FY2028/);
    expect((await budgetProblems(api({ versions: { 2028: 1 } }), NOW)).join()).toMatch(/no budget version for FY2027/);
  });

  it('names missing prior-year actuals (the January/February case: the previous year holds no journal)', async () => {
    expect((await budgetProblems(api({ cells: [] }), NOW)).join()).toMatch(/no turnover or cost-of-sales line has prior-year actuals/);
    expect((await budgetProblems(api({ cells: [{ glAccountId: 'a0', amount: 0 }] }), NOW)).join()).toMatch(/prior-year actuals/);
    expect((await budgetProblems(api({ cells: [{ glAccountId: 'a2', amount: 9 }] }), NOW)).join()).toMatch(/prior-year actuals/); // an operating-expense line does not count
  });

  it('names a missing line band and a year the app and this run disagree on', async () => {
    expect((await budgetProblems(api({ grid: lines('turnover', 'operating_expense') }), NOW)).join()).toMatch(/no active cost_of_sales line/);
    expect((await budgetProblems(api({ years: 2026 }), NOW)).join()).toMatch(/current budget year is 2026, not 2027/);
  });
});
