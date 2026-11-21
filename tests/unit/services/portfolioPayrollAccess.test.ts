/**
 * The portfolio spans every client the user belongs to; Payroll read is per client company. The server leaves the payroll
 * card out of a row where the user cannot read Payroll and counts the row without it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  companies: [] as Array<{ companyId: string; companyName: string; isDefault: boolean; role: string }>,
  adminRows: [] as Array<Record<string, unknown>>,
  adminQuery: vi.fn(),
  cards: {} as Record<string, Array<{ id: string; title: string; status: string; primary: string }>>,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/afterCommit', () => ({ runOwnedContext: (ctx: { companyId: string }, fn: () => unknown) => fn() }));
vi.mock('@/lib/rollbackFailed', () => ({ rollbackFailed: vi.fn(async () => false) }));
vi.mock('@/modules/accounting/services/core/companyService', () => ({ getUserCompanies: vi.fn(async () => h.companies) }));
vi.mock('@/lib/auth/withPlatformAdmin.pools', () => ({
  getPlatformAdminPool: () => ({ query: h.adminQuery, connect: async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }) }),
}));
vi.mock('@/modules/accounting/services/workbench/monthEndWorkbenchService', () => ({
  getMonthEndWorkbench: vi.fn(async (companyId: string) => ({ cards: h.cards[companyId] ?? [], trialBalanceBalanced: true })),
}));

import { getPortfolioWorkbench } from '@/modules/accounting/services/workbench/portfolioWorkbenchService';
import { payrollReadByCompany, withoutPayrollCard } from '@/modules/accounting/services/workbench/portfolioPayrollAccess';

const U = 'user-1';
const READ = 'co-read', NOREAD = 'co-noread', NOMEMBER = 'co-nomember';
const co = (companyId: string, companyName: string) => ({ companyId, companyName, isDefault: false, role: 'manager' });
const card = (id: string, status: string) => ({ id, title: id, status, primary: id });
const member = (company_id: string, role: string, row?: boolean) => ({
  company_id, role, approve_withheld: false, can_read: row ?? null, can_write: row ?? null, can_delete: false, can_export: false, can_approve: row ?? null, has_row: row !== undefined,
});

beforeEach(() => {
  h.adminQuery.mockReset();
  h.companies = [co(READ, 'A Readable'), co(NOREAD, 'B Hidden')];
  h.cards = {
    [READ]: [card('banking', 'ready'), card('payroll', 'attention')],
    [NOREAD]: [card('banking', 'ready'), card('payroll', 'attention'), card('vat', 'blocked')],
  };
  h.adminQuery.mockResolvedValue({ rows: [member(READ, 'manager'), member(NOREAD, 'manager', false)] });
});

describe('payrollReadByCompany', () => {
  it('decides each company by memberMay: a row of false hides, the role default shows', async () => {
    const m = await payrollReadByCompany({ query: h.adminQuery }, U, [READ, NOREAD]);
    expect([m.get(READ), m.get(NOREAD)]).toEqual([true, false]);
  });
  it('a company the query does not return (no membership) is not readable', async () => {
    h.adminQuery.mockResolvedValue({ rows: [member(READ, 'manager')] });
    const m = await payrollReadByCompany({ query: h.adminQuery }, U, [READ, NOMEMBER]);
    expect(m.get(NOMEMBER)).toBe(false);
  });
  it('is one query for every company, filtered to this user and these companies', async () => {
    await payrollReadByCompany({ query: h.adminQuery }, U, [READ, NOREAD]);
    expect(h.adminQuery).toHaveBeenCalledTimes(1);
    const [text, params] = h.adminQuery.mock.calls[0] as [string, unknown[]];
    expect(text).toMatch(/cu\.user_id = \$1 AND cu\.company_id = ANY\(\$2::uuid\[\]\)/);
    expect(params).toEqual([U, [READ, NOREAD], 'payroll']);
  });
  it('asks nothing for no companies', async () => {
    expect((await payrollReadByCompany({ query: h.adminQuery }, U, [])).size).toBe(0);
    expect(h.adminQuery).not.toHaveBeenCalled();
  });
});

describe('withoutPayrollCard', () => {
  it('drops the card and recounts from what is left', () => {
    const row = withoutPayrollCard({ companyId: 'x', companyName: 'X', isDefault: false, role: 'm', trialBalanceBalanced: true,
      cards: [card('banking', 'ready'), card('payroll', 'attention'), card('vat', 'blocked')] as never, readyCount: 1, attentionCount: 1, blockedCount: 1, failed: false });
    expect(row.cards.map((c) => c.id)).toEqual(['banking', 'vat']);
    expect([row.readyCount, row.attentionCount, row.blockedCount, row.payrollHidden]).toEqual([1, 0, 1, true]);
  });
});

describe('getPortfolioWorkbench with one readable and one hidden client', () => {
  it('omits the payroll card from the hidden client only, and counts, sort and summary exclude it', async () => {
    const wb = await getPortfolioWorkbench(U, '2026-09');
    const byId = Object.fromEntries(wb.rows.map((r) => [r.companyId, r]));
    expect(byId[READ]!.cards.map((c) => c.id)).toEqual(['banking', 'payroll']);
    expect(byId[READ]!.payrollHidden).toBeUndefined();
    expect(byId[READ]!.attentionCount).toBe(1);
    expect(byId[NOREAD]!.cards.map((c) => c.id)).toEqual(['banking', 'vat']);
    expect(byId[NOREAD]!.payrollHidden).toBe(true);
    expect(byId[NOREAD]!.attentionCount).toBe(0);
    expect(wb.summary.cardsByStatus).toMatchObject({ ready: 2, attention: 1, blocked: 1 });
    expect(wb.rows[0]!.companyId).toBe(READ); // most attention first: the hidden client's payroll attention does not count
  });

  it('fails closed: a client the access query does not return is hidden', async () => {
    h.adminQuery.mockResolvedValue({ rows: [member(READ, 'manager')] });
    const wb = await getPortfolioWorkbench(U, '2026-09');
    expect(wb.rows.find((r) => r.companyId === NOREAD)!.payrollHidden).toBe(true);
  });
});
