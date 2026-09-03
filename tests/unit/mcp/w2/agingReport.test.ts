/**
 * Aged debtors / aged creditors (W2) — EXTEND.
 *
 * `aged_debtors` returned exactly ten customer rows totalling R63.1m with no
 * total, no row count and no truncation flag, and silently dropped every
 * invoice with a null due date — R1,058,000 of a reconciling difference was one
 * such row. Ten is a suspicious number to a human and an unremarkable one to an
 * agent, which is the whole reason the envelope exists.
 *
 * What this suite pins down:
 *  - a document that cannot be aged is EXCLUDED WITH ITS AMOUNT, never dropped;
 *  - the report carries its own totals and its own universe;
 *  - unapplied receipts are reported beside the buckets, because a debtors
 *    figure computed while R2.69m of receipts sit unapplied is not what anyone
 *    means by "what we are owed".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/arSubledgerService', () => ({ getARSubledger: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/apSubledgerService', () => ({ getAPSubledger: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/controlAccountService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getControlAccountBalances: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reconciliation/unappliedCashService', () => ({
  getUnappliedControlCash: vi.fn(),
}));

import { getARSubledger } from '@/modules/accounting/services/ar/arSubledgerService';
import { getControlAccountBalances } from '@/modules/accounting/services/gl/controlAccountService';
import { getUnappliedControlCash } from '@/modules/accounting/services/reconciliation/unappliedCashService';
import { getAgingReport } from '@/modules/accounting/services/reports/agingReportService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1', documentNumber: 'INV1', entityId: 'cust-1', entityName: 'Blitz',
  documentDate: '2026-01-01', dueDate: '2026-02-01',
  totalAmount: 1000, amountPaid: 0, balance: 1000, ...over,
});

function snapshot(over: Record<string, unknown> = {}) {
  const documents = (over.documents as unknown[]) ?? [doc()];
  return {
    documents,
    ageable: (over.ageable as unknown[]) ?? documents,
    unageable: (over.unageable as unknown[]) ?? [],
    afterAsAt: [], creditNotes: [],
    subledgerTotal: 1000, postedThrough: '2026-01-01T00:00:00.000Z',
    disputes: new Map<string, number>(),
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(getARSubledger).mockReset().mockResolvedValue(snapshot() as never);
  vi.mocked(getControlAccountBalances).mockReset().mockResolvedValue([]);
  vi.mocked(getUnappliedControlCash).mockReset().mockResolvedValue({
    appliedRecords: [], withPaymentRecord: [], withoutPaymentRecord: [], total: 0, postedThrough: null,
  });
});

describe('getAgingReport', () => {
  it('EXCLUDES a null-due-date invoice with its amount rather than dropping it', async () => {
    const orphan = doc({ id: 'inv-133', documentNumber: 'INV0000133', dueDate: null, balance: 1058000 });
    vi.mocked(getARSubledger).mockResolvedValue(
      snapshot({ documents: [doc(), orphan], ageable: [doc()], unageable: [orphan] }) as never,
    );

    const report = await getAgingReport(COMPANY, 'ar', '2026-09-03');
    expect(report.excluded).toEqual([
      expect.objectContaining({
        id: 'inv-133', reason: 'null_due_date', amount: 1058000, documentNumber: 'INV0000133',
      }),
    ]);
    // "One row was excluded" and "R1.06m was excluded" are different facts.
    expect(report.excludedTotal).toBe(1058000);
    // The buckets still total only what could be aged, so the figure is honest.
    expect(report.totals.total).toBe(1000);
  });

  it('counts its own universe so completeness is arithmetic, not a claim', async () => {
    const orphan = doc({ id: 'inv-2', entityId: 'cust-2', dueDate: null });
    vi.mocked(getARSubledger).mockResolvedValue(
      snapshot({ documents: [doc(), orphan], ageable: [doc()], unageable: [orphan] }) as never,
    );
    const report = await getAgingReport(COMPANY, 'ar', '2026-09-03');
    // One entity bucketed, one entity excluded entirely: 1 + 1 = 2 outcomes.
    expect(report.buckets).toHaveLength(1);
    expect(report.entityUniverse).toBe(report.buckets.length + report.excluded.length);
  });

  it('reports unapplied receipts BESIDE the buckets', async () => {
    vi.mocked(getControlAccountBalances).mockResolvedValue([
      { accountId: 'a1', accountCode: '1101', accountName: 'AR', accountType: 'asset',
        accountSubtype: 'receivable', isActive: true, balance: 1, foundBy: 'subtype' },
    ]);
    vi.mocked(getUnappliedControlCash).mockResolvedValue({
      appliedRecords: [],
      withPaymentRecord: [
        { id: 'p1', documentNumber: 'CP-1', entityName: 'Blitz', documentDate: '2026-07-24', amount: 2681024 },
      ],
      withoutPaymentRecord: [
        { id: 'je9', documentNumber: 'JE-9', entityName: null, documentDate: '2026-04-13', amount: 10000 },
      ],
      total: 2691024,
      postedThrough: '2026-07-24T00:00:00.000Z',
    });

    const report = await getAgingReport(COMPANY, 'ar', '2026-09-03');
    // R1,000 is owed on paper while R2.69m of receipts sit unapplied. Reporting
    // the first without the second is the misleading half of the truth.
    expect(report.unappliedReceipts).toBe(2691024);
    expect(report.totals.total).toBe(1000);
  });

  it('takes the later posted_through across the subledger and the cash reader', async () => {
    vi.mocked(getControlAccountBalances).mockResolvedValue([
      { accountId: 'a1', accountCode: '1101', accountName: 'AR', accountType: 'asset',
        accountSubtype: 'receivable', isActive: true, balance: 1, foundBy: 'subtype' },
    ]);
    vi.mocked(getUnappliedControlCash).mockResolvedValue({
      appliedRecords: [], withPaymentRecord: [], withoutPaymentRecord: [], total: 0,
      postedThrough: '2026-08-31T22:15:00.000Z',
    });
    const report = await getAgingReport(COMPANY, 'ar', '2026-09-03');
    expect(report.postedThrough).toBe('2026-08-31T22:15:00.000Z');
  });

  it('scopes every reader by the company it was given', async () => {
    await getAgingReport(COMPANY, 'ar', '2026-09-03');
    expect(vi.mocked(getARSubledger).mock.calls[0]![0]).toBe(COMPANY);
    expect(vi.mocked(getControlAccountBalances).mock.calls[0]![0]).toBe(COMPANY);
  });
});
