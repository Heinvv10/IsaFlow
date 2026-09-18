/**
 * Unit tests for statementEmailService.ts — fetchStatementData.
 *
 * Deviation from the L4 brief: the brief asked for the accountLedgerService
 * mocking pattern (`vi.mock('@/lib/neon')` returning bare `sql`/`withTransaction`/
 * `fmtDate` spies). fetchStatementData splices a raw fragment through
 * `sql.unsafe` (documentInLedgerAsAtFragment, same helper supplierStatementService
 * uses) — a bare `(t) => t` stub for `unsafe` would consume a queued
 * `mockResolvedValueOnce` and shift every row after it (see
 * tests/unit/helpers/sqlFragmentMock.ts). This file instead follows
 * supplierStatementService.test.ts's proven pattern: `mockUnsafe` +
 * `recordSqlCall` reproduce the real client's splicing, and a `routeMock`
 * keyed on table name stands in for the sequential per-table queries.
 *
 * Focus: money-field rounding. L4 fixes running balances accumulating in JS
 * floating point with no rounding (values like 126629.94999999995 and
 * -4.3655745685100555e-11). These tests provoke that drift and assert every
 * emitted money field is exact to 2dp.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockUnsafe, recordSqlCall } from '../../helpers/sqlFragmentMock';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      sqlCalls.push(recordSqlCall(strings, values));
      return mockImpl(strings, ...values);
    },
    { unsafe: mockUnsafe },
  ),
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CUSTOMER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const CUST = [{ id: CUSTOMER, name: 'Acme Fibre CC', email: 'ap@acme.example' }];

function routeMock(over: Record<string, unknown[]> = {}) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    if (q.includes('FROM customers')) return Promise.resolve(over.customer ?? CUST);
    if (q.includes('FROM customer_invoices')) return Promise.resolve(over.invoices ?? []);
    if (q.includes('FROM customer_payments')) return Promise.resolve(over.payments ?? []);
    if (q.includes('FROM credit_notes')) return Promise.resolve(over.credits ?? []);
    return Promise.resolve([]);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('fetchStatementData — money fields are exact to the cent', () => {
  it('a running balance that alternates debit/credit nets to exactly 0, not a float residue', async () => {
    // Ten alternating invoice/payment pairs of 0.1 — plain `running += debit -
    // credit` drifts measurably over this many float additions (the defect
    // reproduced -4.3655745685100555e-11 for a line that should be exactly 0).
    const invoices = Array.from({ length: 10 }, (_, i) => ({
      id: `i${i}`,
      invoice_number: `INV${i}`,
      invoice_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      total_amount: 0.1,
      status: 'approved',
    }));
    const payments = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      payment_number: `RCT${i}`,
      payment_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      status: 'confirmed',
      amount_received: 0.1,
    }));
    routeMock({ invoices, payments });

    const data = (await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31'))!;

    expect(data.summary.balance).toBe(0);
    expect(Object.is(data.summary.balance, -0)).toBe(false);
    for (const txn of data.transactions) {
      expect(Number.isInteger(txn.balance * 100)).toBe(true);
    }
  });

  it('reproduces the 126629.95 running-balance case exactly', async () => {
    const invoices = [
      { id: 'i1', invoice_number: 'INV1', invoice_date: '2026-01-01', total_amount: 126629.95, status: 'approved' },
    ];
    const payments = [
      { id: 'p1', payment_number: 'RCT1', payment_date: '2026-01-05', status: 'confirmed', amount_received: 100000 },
    ];
    const credits = [
      { id: 'c1', credit_note_number: 'CN1', credit_date: '2026-01-06', total_amount: 0.05, applied_amount: 0.05, status: 'applied' },
    ];
    routeMock({ invoices, payments, credits });

    const data = (await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31'))!;

    // 126629.95 − 100000 − 0.05 = 26629.90, exactly.
    expect(data.summary.balance).toBe(26629.9);
  });

  it('every money field in the payload is rounded to 2 decimal places', async () => {
    const invoices = [
      { id: 'i1', invoice_number: 'INV1', invoice_date: '2026-01-01', total_amount: '20000.555', status: 'approved' },
    ];
    const payments = [
      { id: 'p1', payment_number: 'RCT1', payment_date: '2026-02-01', status: 'draft', amount_received: '5000.005' },
    ];
    routeMock({ invoices, payments });

    const data = (await fetchStatementData(COMPANY, CUSTOMER, '2026-03-31'))!;

    const allNumbers: number[] = [
      data.summary.totalInvoiced,
      data.summary.totalPaid,
      data.summary.totalCredits,
      data.summary.balance,
      ...data.transactions.flatMap((t) => [t.debit, t.credit, t.balance]),
      ...data.excluded.map((e) => e.amount ?? 0),
    ];
    for (const n of allNumbers) {
      const cents = Math.round(n * 100);
      expect(cents / 100).toBeCloseTo(n, 10);
      expect(Number.isInteger(cents)).toBe(true);
    }
  });
});
