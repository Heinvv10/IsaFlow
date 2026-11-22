// One workbench card failing (e.g. 42501 on vat_returns) aborts the request's shared
// transaction; every later card then died with 25P02. Each card must run in its own savepoint.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ aborted: false, savepoints: [] as string[], tail: Promise.resolve() as Promise<unknown> }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(),
  // Models Postgres on one connection: sibling savepoints queue (savepointQueue), and a throw
  // inside one is rolled back to it, clearing the aborted state.
  withSavepoint: <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    db.savepoints.push(name);
    const run = db.tail.then(async () => {
      try { return await fn(); } catch (e) { db.aborted = false; throw e; }
    });
    db.tail = run.catch(() => undefined);
    return run;
  },
}));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const okCard = vi.hoisted(() => (id: string) => async () => {
  await Promise.resolve();
  if (db.aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
  return { id, title: id, status: 'ready', primary: 'ok' };
});
vi.mock('@/modules/accounting/services/workbench/monthEndLedgerCards', () => ({
  buildBankingCard: vi.fn(okCard('banking')),
  buildSalesCard: vi.fn(okCard('sales')),
  buildPurchasesCard: vi.fn(okCard('purchases')),
  buildVatCard: vi.fn(async () => { db.aborted = true; throw new Error('permission denied for table vat_returns'); }),
  buildPayrollCard: vi.fn(okCard('payroll')),
}));
vi.mock('@/modules/accounting/services/reports/headlineFigures', () => ({
  getHeadlineCounts: vi.fn(async () => { await Promise.resolve(); if (db.aborted) throw new Error('25P02'); return { draftInvoices: 0, draftBills: 0 }; }),
  countDraftJournals: vi.fn(async () => 0),
}));
vi.mock('@/modules/accounting/services/afs/afsDocumentService', () => ({
  listAfsDocuments: vi.fn(async () => { await Promise.resolve(); if (db.aborted) throw new Error('25P02'); return []; }),
}));

import { sql } from '@/lib/neon';
import { getMonthEndWorkbench } from '@/modules/accounting/services/workbench/monthEndWorkbenchService';

describe('getMonthEndWorkbench card isolation', () => {
  beforeEach(() => {
    db.aborted = false;
    db.tail = Promise.resolve();
    db.savepoints.length = 0;
    vi.mocked(sql).mockImplementation((async () => {
      await Promise.resolve();
      if (db.aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
      return [];
    }) as never);
  });

  it('a failing VAT card blocks only itself', async () => {
    const wb = await getMonthEndWorkbench('00000000-0000-0000-0000-000000000001', '2026-11', { payrollRead: true });
    const byId = Object.fromEntries(wb.cards.map((c) => [c.id, c]));
    expect(byId.vat!.status).toBe('blocked');
    for (const id of ['banking', 'sales', 'purchases', 'payroll', 'afs', 'exceptions', 'review']) {
      expect(byId[id]!.status, id).not.toBe('blocked');
    }
  });

  it('runs every card and the trial balance in its own savepoint', async () => {
    await getMonthEndWorkbench('00000000-0000-0000-0000-000000000001', '2026-11', { payrollRead: true });
    expect(new Set(db.savepoints).size).toBe(9);
  });

  it('without Payroll read the payroll card is not built at all: no card, no savepoint, payrollHidden', async () => {
    const wb = await getMonthEndWorkbench('00000000-0000-0000-0000-000000000001', '2026-11', { payrollRead: false });
    expect(wb.cards.map((c) => c.id)).toEqual(['banking', 'sales', 'purchases', 'vat', 'afs', 'exceptions', 'review']);
    expect(wb.payrollHidden).toBe(true);
    expect(db.savepoints).not.toContain('wb_card_payroll');
    expect(new Set(db.savepoints).size).toBe(8);
  });

  it('with Payroll read the card is there and payrollHidden is absent', async () => {
    const wb = await getMonthEndWorkbench('00000000-0000-0000-0000-000000000001', '2026-11', { payrollRead: true });
    expect(wb.cards.map((c) => c.id)).toContain('payroll');
    expect(wb.payrollHidden).toBeUndefined();
  });
});

