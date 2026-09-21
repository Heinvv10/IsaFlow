/**
 * recordPaymentMatch — a READ, since it stopped writing the flag.
 *
 * What it used to do: set `supplier_invoices.payment_matched` from a PROJECTED
 * paid amount — `amount_paid + allocatedAmount` — before anything moved
 * `amount_paid`. When the allocation that followed applied less than the
 * projection, or nothing at all, the bill carried a flag saying it was settled
 * with its full balance still outstanding. That is the mechanism behind bills
 * reading as matched at amount_paid = 0.
 *
 * `recomputeInvoiceStatus` is the sole writer now — one rule, derived from the
 * balance AFTER the money moved. This service answers the question and writes
 * nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), {
    unsafe: vi.fn().mockReturnValue(''),
  });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  fmtDate: (x: unknown) => String(x),
  DbRow: null,
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { recordPaymentMatch } from '@/modules/accounting/services/capture/fourWayMatchService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const INVOICE_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function invoice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { total_amount: 1000, amount_paid: 0, payment_matched: false, ...overrides };
}

function readsBack(row: Record<string, unknown>): void {
  vi.mocked(sqlMock).mockResolvedValueOnce([row] as never);
}

/** Every query this service ran, flattened. */
function queries(): string[] {
  return vi.mocked(sqlMock).mock.calls
    .map((c) => (c[0] as unknown as TemplateStringsArray).join('?').replace(/\s+/g, ' ').trim());
}

describe('recordPaymentMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('NEVER writes payment_matched, however much the caller says it allocated', async () => {
    readsBack(invoice({ total_amount: 1000, amount_paid: 0 }));

    await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 1000);

    // One SELECT and nothing else. The projection that used to fire an UPDATE
    // here is exactly what flagged bills with a full balance.
    expect(vi.mocked(sqlMock)).toHaveBeenCalledTimes(1);
    expect(queries().some((q) => /UPDATE supplier_invoices/i.test(q))).toBe(false);
  });

  it('reports the bill as unmatched while its own balance is outstanding', async () => {
    // The caller is about to allocate R1,000, which would have satisfied the
    // old projection. What is TRUE right now is that nothing is paid.
    readsBack(invoice({ total_amount: 1000, amount_paid: 0 }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 1000);

    expect(result.paymentMatched).toBe(false);
  });

  it('reports a settled bill as matched, from amount_paid', async () => {
    readsBack(invoice({ total_amount: 1000, amount_paid: 1000, payment_matched: true }));

    const result = await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 0);

    expect(result.paymentMatched).toBe(true);
  });

  it('keeps the R0.01 tolerance on the balance it reads', async () => {
    readsBack(invoice({ total_amount: 1000, amount_paid: 999.995 }));
    expect((await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 0)).paymentMatched).toBe(true);

    readsBack(invoice({ total_amount: 1000, amount_paid: 999.98 }));
    expect((await recordPaymentMatch(COMPANY_ID, INVOICE_ID, 0)).paymentMatched).toBe(false);
  });

  it('is scoped to the company and answers false for an invoice it cannot see', async () => {
    vi.mocked(sqlMock).mockResolvedValueOnce([] as never);

    const result = await recordPaymentMatch('wrong-company', INVOICE_ID, 1000);

    expect(result.paymentMatched).toBe(false);
    expect(queries()[0]!).toContain('company_id');
  });
});
