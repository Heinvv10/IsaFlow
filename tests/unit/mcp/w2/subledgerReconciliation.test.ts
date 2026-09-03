/**
 * `reconcile_subledger`'s engine (W2).
 *
 * The requirement it exists to meet: DECOMPOSE the difference into itemised
 * reconciling items with document ids. A report that returns R1,429,774 and no
 * items has not done the job — a reader still has to go and find the money.
 *
 * TWO BRIDGES, not one. Re-deriving Brightsphere showed the specification had
 * conflated them:
 *   aged → subledger      what the aged report drops (null due dates, disputes)
 *   subledger → control   what the GL and the subledger disagree about
 * The R1,058,000 null-due-date invoice sits on the FIRST bridge; the unapplied
 * cash sits on the second. Adding them into one number is how the audit's
 * R1,429,774 came to be an amount that reconciles to nothing exactly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/controlAccountService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getControlAccountBalances: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/arSubledgerService', () => ({ getARSubledger: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/apSubledgerService', () => ({ getAPSubledger: vi.fn() }));
vi.mock('@/modules/accounting/services/reconciliation/unappliedCashService', () => ({
  getUnappliedControlCash: vi.fn(),
}));
vi.mock('@/modules/accounting/services/reconciliation/unpostedDocumentService', () => ({
  getUnpostedSubledgerDocuments: vi.fn(),
}));
// The aged total comes FROM the aged report. Mocked here so the bridge
// arithmetic can be driven; that it really is the aged report's own figure is
// asserted against the live books in subledgerTiesToAging.integration.test.ts,
// which is the only place that claim can honestly be made.
vi.mock('@/modules/accounting/services/reconciliation/agedReportTotal', () => ({
  getAgedReportTotal: vi.fn(),
}));

import { getControlAccountBalances } from '@/modules/accounting/services/gl/controlAccountService';
import { getARSubledger } from '@/modules/accounting/services/ar/arSubledgerService';
import { getUnappliedControlCash } from '@/modules/accounting/services/reconciliation/unappliedCashService';
import { getUnpostedSubledgerDocuments } from '@/modules/accounting/services/reconciliation/unpostedDocumentService';
import { getAgedReportTotal } from '@/modules/accounting/services/reconciliation/agedReportTotal';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const AS_AT = '2026-09-03';

const ctrl = (over: Record<string, unknown> = {}) => ({
  accountId: 'acc-1101', accountCode: '1101', accountName: 'Trade Debtors Control',
  accountType: 'asset', accountSubtype: 'receivable', isActive: true,
  balance: 11591623.6, foundBy: 'subtype' as const, ...over,
});

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1', documentNumber: 'INV0000001', entityId: 'cust-1', entityName: 'Blitz',
  documentDate: '2026-01-01', dueDate: '2026-02-01',
  totalAmount: 1000, amountPaid: 0, balance: 1000, ...over,
});

function arSnapshot(over: Record<string, unknown> = {}) {
  return {
    documents: [doc()], ageable: [doc()], unageable: [], creditNotes: [],
    subledgerTotal: 1000, postedThrough: '2026-01-01T00:00:00.000Z',
    disputes: new Map<string, number>(), ...over,
  };
}

beforeEach(() => {
  vi.mocked(getControlAccountBalances).mockReset();
  vi.mocked(getARSubledger).mockReset();
  vi.mocked(getUnappliedControlCash).mockReset().mockResolvedValue({
    appliedRecords: [], withPaymentRecord: [], withoutPaymentRecord: [], total: 0, postedThrough: null,
  });
  vi.mocked(getUnpostedSubledgerDocuments).mockReset().mockResolvedValue([]);
  // Default: the aged report agrees with the subledger, so the aged bridge is
  // empty and a test that does not care about it is not paying for one.
  vi.mocked(getAgedReportTotal).mockReset().mockResolvedValue(1000);
});

describe('reconcileSubledger — AR', () => {
  it('decomposes the difference into items that SUM to it, with document ids', async () => {
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 11581623.6 })]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot({ subledgerTotal: 14272647.6 }) as never);
    vi.mocked(getAgedReportTotal).mockResolvedValue(14272647.6);
    vi.mocked(getUnappliedControlCash).mockResolvedValue({
      withPaymentRecord: [
        { id: 'pay-1', documentNumber: 'CP-1', entityName: 'Velocity', documentDate: '2026-07-24', amount: 2681024 },
      ],
      withoutPaymentRecord: [
        { id: 'je-9', documentNumber: 'JE-2026-00009', entityName: null, documentDate: '2026-04-13', amount: 10000 },
      ],
      appliedRecords: [],
      total: 2691024,
      postedThrough: '2026-07-24T00:00:00.000Z',
    });

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);

    expect(rec.difference).toBe(2691024);
    const bridge = rec.reconcilingItems.filter((i) => i.bridge === 'subledger_to_control');
    expect(bridge.map((i) => i.type)).toEqual([
      'unapplied_receipt',
      'posting_with_no_document',
    ]);
    expect(bridge.reduce((s, i) => s + i.amount, 0)).toBe(2691024);
    // Document ids, not just a number — the whole requirement.
    expect(bridge[0]!.documentIds).toEqual(['pay-1']);
    expect(bridge[1]!.documentIds).toEqual(['je-9']);
    // Fully explained, so no residual item is emitted.
    expect(rec.unexplainedDifference).toBe(0);
    expect(rec.reconcilingItems.some((i) => i.type === 'unexplained_difference')).toBe(false);
  });

  it('EMITS an unexplained_difference item when the parts do not add up', async () => {
    // The honesty valve. Without it a caller cannot tell a complete
    // decomposition from one that quietly gave up.
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 0 })]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot({ subledgerTotal: 5000 }) as never);
    vi.mocked(getAgedReportTotal).mockResolvedValue(5000);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    expect(rec.difference).toBe(5000);
    expect(rec.unexplainedDifference).toBe(5000);
    const residual = rec.reconcilingItems.find((i) => i.type === 'unexplained_difference');
    expect(residual).toMatchObject({ amount: 5000, bridge: 'subledger_to_control', documentIds: [] });
  });

  it('does NOT claim the aged report drops a null-due-date invoice — it no longer does', async () => {
    // This item used to exist as `unageable_document`, worth R12,730,757.43 of
    // Velocity AR and R1,058,000 of Brightsphere. It asserted that the aged
    // report omits invoices with no due date. True before #303; since then they
    // are aged from `invoice_date`. The reconciliation was attributing a real
    // difference to a mechanism that had been fixed, and nothing went red
    // because the aged total was recomputed here instead of being read from the
    // report that owns it.
    const orphan = doc({ id: 'inv-133', documentNumber: 'INV0000133', dueDate: null, balance: 1058000 });
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 1059000 })]);
    vi.mocked(getARSubledger).mockResolvedValue(
      arSnapshot({
        documents: [doc(), orphan], ageable: [doc()], unageable: [orphan],
        subledgerTotal: 1059000,
      }) as never,
    );
    // The aged report carries the row, so it reports the same total.
    vi.mocked(getAgedReportTotal).mockResolvedValue(1059000);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    expect(rec.agedTotal).toBe(1059000);
    expect(rec.reconcilingItems.some((i) => i.type === 'unageable_document')).toBe(false);
    // Nothing to explain on either bridge: both reports agree, and so do the
    // subledger and the control account.
    expect(rec.reconcilingItems).toEqual([]);
    expect(rec.difference).toBe(0);
  });

  it('reports the aged report’s OWN total, and names the gap to the subledger', async () => {
    // Disputes and unallocated credit are the two things the aged report
    // genuinely does not show: bucket totals are net of disputes, and a row
    // with a balance of zero or less never reaches a bucket at all.
    const disputed = doc({ id: 'inv-d', documentNumber: 'INV-D', balance: 4000 });
    const cn = doc({ id: 'cn-1', documentNumber: 'CN0001', balance: -250 });
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 3750 })]);
    vi.mocked(getARSubledger).mockResolvedValue(
      arSnapshot({
        documents: [disputed], ageable: [disputed], creditNotes: [cn],
        subledgerTotal: 3750,
        disputes: new Map([['inv-d', 900]]),
      }) as never,
    );
    vi.mocked(getAgedReportTotal).mockResolvedValue(3100); // 4000 − 900 dispute

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    const aged = rec.reconcilingItems.filter((i) => i.bridge === 'aged_to_subledger');
    expect(aged.map((i) => i.type)).toEqual(['disputed_amount', 'unallocated_credit_note']);
    expect(aged.find((i) => i.type === 'disputed_amount')).toMatchObject({
      amount: 900, documentIds: ['inv-d'],
    });
    expect(aged.find((i) => i.type === 'unallocated_credit_note')).toMatchObject({
      amount: -250, documentIds: ['cn-1'],
    });
    // The identity this bridge exists to satisfy.
    expect(aged.reduce((s, i) => s + i.amount, 0)).toBe(3750 - 3100);
    // And it does NOT touch the GL difference: those documents' own journals
    // are already on the control account.
    expect(rec.difference).toBe(0);
    expect(rec.reconcilingItems.filter((i) => i.bridge === 'subledger_to_control')).toEqual([]);
  });

  it('EMITS aged_unexplained_difference when the aged gap is not fully named', async () => {
    // The valve that would have caught `unageable_document` going stale. The
    // aged report and the subledger disagree by R600 with no dispute and no
    // credit note to explain it, so the residual is reported rather than
    // absorbed into a plausible-looking item.
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 1000 })]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot({ subledgerTotal: 1000 }) as never);
    vi.mocked(getAgedReportTotal).mockResolvedValue(400);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    expect(rec.reconcilingItems.find((i) => i.type === 'aged_unexplained_difference')).toMatchObject({
      bridge: 'aged_to_subledger', amount: 600, documentIds: [],
    });
    // It is an AGED-bridge residual and must not be mistaken for a GL one.
    expect(rec.unexplainedDifference).toBe(0);
  });

  it('names the invoices the GL has never seen instead of lumping them into the residual', async () => {
    // Found by running this over real books: 169 of ISAFlow Demo's open
    // invoices carry no gl_journal_entry_id at all — R10,664,575.43 the
    // subledger counts and the ledger has never heard of. Before it was named,
    // every cent of it arrived as `unexplained_difference`.
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 0 })]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot({ subledgerTotal: 10664575.43 }) as never);
    vi.mocked(getAgedReportTotal).mockResolvedValue(10664575.43);
    vi.mocked(getUnpostedSubledgerDocuments).mockResolvedValue([
      { id: 'inv-a', documentNumber: 'INV-A', entityName: 'X', documentDate: '2026-01-01',
        amount: 10664000, reason: 'document_not_linked_to_journal' },
      { id: 'inv-b', documentNumber: 'INV-B', entityName: 'Y', documentDate: '2026-02-01',
        amount: 575.43, reason: 'document_not_on_control_account' },
    ]);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    const never = rec.reconcilingItems.find((i) => i.type === 'document_not_linked_to_journal');
    const elsewhere = rec.reconcilingItems.find((i) => i.type === 'document_not_on_control_account');
    // The two reasons stay apart: one was never posted, one was posted wrong.
    expect(never).toMatchObject({ amount: 10664000, documentIds: ['inv-a'] });
    expect(elsewhere).toMatchObject({ amount: 575.43, documentIds: ['inv-b'] });
    expect(rec.unexplainedDifference).toBe(0);
  });

  it('names a document whose JOURNAL is after the reporting date, once, as what it is', async () => {
    // The `document_after_as_at` item is gone with `afterAsAt`. The readers now
    // apply the same document-date cutoff the control-account balance applies,
    // so a document raised after the reporting date is not in the subledger at
    // that date and there is nothing to reconcile. On production that item was
    // absorbing R72,867,375.59 of Velocity AR at 2025-12-31 — arithmetic that
    // closed while answering a question nobody asked.
    //
    // What remains is a document IN the subledger whose journal is dated after
    // the reporting date. `getUnpostedSubledgerDocuments` returns it with a
    // shortfall equal to its balance, and the correct name for that is
    // `document_not_on_control_account`, not a second item off the date.
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 1000 })]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot({ subledgerTotal: 52750 }) as never);
    vi.mocked(getAgedReportTotal).mockResolvedValue(52750);
    vi.mocked(getUnpostedSubledgerDocuments).mockResolvedValue([
      { id: 'inv-f', documentNumber: 'INV-F', entityName: 'Blitz', documentDate: '2026-08-01',
        amount: 51750, reason: 'document_not_on_control_account' },
    ]);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);

    expect(rec.difference).toBe(51750);
    const bridge = rec.reconcilingItems.filter((i) => i.bridge === 'subledger_to_control');
    expect(bridge.filter((i) => i.documentIds.includes('inv-f'))).toHaveLength(1);
    expect(bridge[0]!.type).toBe('document_not_on_control_account');
    expect(bridge.reduce((s, i) => s + i.amount, 0)).toBe(51750);
    expect(rec.unexplainedDifference).toBe(0);
    expect(rec.reconcilingItems.some((i) => i.type === 'document_after_as_at')).toBe(false);
  });

  it('reports EVERY control account and flags the ambiguity rather than picking one', async () => {
    // FINDINGS C1: no canonical control account exists. Picking one silently is
    // how a R10,000 receipt on a NULL-subtype account disappears.
    vi.mocked(getControlAccountBalances).mockResolvedValue([
      ctrl({ balance: 11591623.6 }),
      ctrl({ accountId: 'acc-1120', accountCode: '1120', accountSubtype: null,
             balance: -10000, foundBy: 'posting' }),
    ]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot({ subledgerTotal: 11581623.6 }) as never);
    vi.mocked(getAgedReportTotal).mockResolvedValue(11581623.6);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    expect(rec.controlAccounts).toHaveLength(2);
    expect(rec.controlAccountBalance).toBe(11581623.6);
    expect(rec.controlAccountAmbiguous).toBe(true);
    expect(rec.difference).toBe(0);
  });

  it('refuses to report a control balance when NO control account exists', async () => {
    vi.mocked(getControlAccountBalances).mockResolvedValue([]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot() as never);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    expect(rec.controlAccountBalance).toBeNull();
    expect(rec.difference).toBeNull();
    // Reporting a difference of R1,000 against a control balance of zero would
    // be a fabricated finding: there is no account to compare against.
    expect(rec.excludedRows[0]).toMatchObject({ reason: 'no_control_account' });
  });

  it('never calls the unapplied-cash reader with another company id', async () => {
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl()]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot() as never);
    await reconcileSubledger(COMPANY, 'ar', AS_AT);
    expect(vi.mocked(getUnappliedControlCash).mock.calls[0]![0]).toBe(COMPANY);
    expect(vi.mocked(getARSubledger).mock.calls[0]![0]).toBe(COMPANY);
    expect(vi.mocked(getControlAccountBalances).mock.calls[0]![0]).toBe(COMPANY);
  });
});

describe('reconcileSubledger — subledgers with no document-level source', () => {
  it('reports the GL side and says WHY the comparison cannot be made', async () => {
    // Payroll, inventory and bank have no owned subledger figure to compare
    // against. Returning difference: 0 because both sides are zero would be a
    // lie an agent has no way to detect.
    vi.mocked(getControlAccountBalances).mockResolvedValue([
      ctrl({ accountCode: '2200', accountSubtype: 'payroll_liability', accountType: 'liability', balance: 0 }),
    ]);

    const rec = await reconcileSubledger(COMPANY, 'payroll', AS_AT);
    expect(rec.subledgerTotal).toBeNull();
    expect(rec.difference).toBeNull();
    expect(rec.subledgerUnavailable).toMatchObject({ reason: 'no_subledger_source' });
    expect(rec.controlAccounts).toHaveLength(1);
    expect(rec.reconcilingItems).toEqual([]);
  });
});
