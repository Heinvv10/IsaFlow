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

import { getControlAccountBalances } from '@/modules/accounting/services/gl/controlAccountService';
import { getARSubledger } from '@/modules/accounting/services/ar/arSubledgerService';
import { getUnappliedControlCash } from '@/modules/accounting/services/reconciliation/unappliedCashService';
import { getUnpostedSubledgerDocuments } from '@/modules/accounting/services/reconciliation/unpostedDocumentService';
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
    documents: [doc()], ageable: [doc()], unageable: [], afterAsAt: [], creditNotes: [],
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
});

describe('reconcileSubledger — AR', () => {
  it('decomposes the difference into items that SUM to it, with document ids', async () => {
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 11581623.6 })]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot({ subledgerTotal: 14272647.6 }) as never);
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

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    expect(rec.difference).toBe(5000);
    expect(rec.unexplainedDifference).toBe(5000);
    const residual = rec.reconcilingItems.find((i) => i.type === 'unexplained_difference');
    expect(residual).toMatchObject({ amount: 5000, bridge: 'subledger_to_control', documentIds: [] });
  });

  it('puts the null-due-date invoice on the AGED bridge with its amount and id', async () => {
    const orphan = doc({ id: 'inv-133', documentNumber: 'INV0000133', dueDate: null, balance: 1058000 });
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 1059000 })]);
    vi.mocked(getARSubledger).mockResolvedValue(
      arSnapshot({
        documents: [doc(), orphan], ageable: [doc()], unageable: [orphan],
        subledgerTotal: 1059000,
      }) as never,
    );

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    const item = rec.reconcilingItems.find((i) => i.type === 'unageable_document');
    expect(item).toMatchObject({ bridge: 'aged_to_subledger', amount: 1058000, documentIds: ['inv-133'] });
    expect(item!.documentNumbers).toEqual(['INV0000133']);
    // It reconciles the AGED report to the subledger, and does NOT pretend to
    // explain the GL difference — the invoice's own journal IS in the control
    // account. Conflating the two is what made the audit's figure unreconcilable.
    expect(rec.difference).toBe(0);
    expect(rec.agedTotal).toBe(1000);
  });

  it('names the invoices the GL has never seen instead of lumping them into the residual', async () => {
    // Found by running this over real books: 169 of ISAFlow Demo's open
    // invoices carry no gl_journal_entry_id at all — R10,664,575.43 the
    // subledger counts and the ledger has never heard of. Before it was named,
    // every cent of it arrived as `unexplained_difference`.
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 0 })]);
    vi.mocked(getARSubledger).mockResolvedValue(arSnapshot({ subledgerTotal: 10664575.43 }) as never);
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

  it('emits NO item for a future-dated document the control account already holds', async () => {
    // The mirror of the double-count case below. A document dated after the
    // reporting date whose journal posted BEFORE it is on the control account
    // already, so the unposted scan returns nothing for it and there is nothing
    // to reconcile. Emitting an item off the document's date alone would
    // manufacture a difference out of a set of books that agree.
    const future = doc({ id: 'inv-f', documentNumber: 'INV-F', documentDate: '2026-10-01', balance: 51750 });
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 52750 })]);
    vi.mocked(getARSubledger).mockResolvedValue(
      arSnapshot({
        documents: [doc(), future], ageable: [doc(), future], afterAsAt: [future],
        subledgerTotal: 52750,
      }) as never,
    );

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);
    expect(rec.difference).toBe(0);
    expect(rec.reconcilingItems.filter((i) => i.bridge === 'subledger_to_control')).toEqual([]);
    expect(rec.unexplainedDifference).toBe(0);
  });

  it('counts a future-dated document ONCE when the unposted scan also returns it', async () => {
    // The production defect this case exists for. A document dated after the
    // reporting date has NO control posting as at that date, so
    // `getUnpostedSubledgerDocuments` returns it with a shortfall equal to its
    // whole balance — and `afterAsAt` then reported the same balance again.
    // Two items, one document, and a residual of exactly minus its balance.
    //
    // On isaflow_dev nothing is future-dated, so the DB-gated test could not
    // see it; on production ISAFlow Demo it was R5,836,396.24 of AR and
    // R1,206,462.27 of AP reported as `unexplained_difference`.
    const future = doc({ id: 'inv-f', documentNumber: 'INV-F', documentDate: '2026-10-01', balance: 51750 });
    vi.mocked(getControlAccountBalances).mockResolvedValue([ctrl({ balance: 1000 })]);
    vi.mocked(getARSubledger).mockResolvedValue(
      arSnapshot({
        documents: [doc(), future], ageable: [doc(), future], afterAsAt: [future],
        subledgerTotal: 52750,
      }) as never,
    );
    vi.mocked(getUnpostedSubledgerDocuments).mockResolvedValue([
      { id: 'inv-f', documentNumber: 'INV-F', entityName: 'Blitz', documentDate: '2026-10-01',
        amount: 51750, reason: 'document_not_on_control_account' },
    ]);

    const rec = await reconcileSubledger(COMPANY, 'ar', AS_AT);

    expect(rec.difference).toBe(51750);
    const bridge = rec.reconcilingItems.filter((i) => i.bridge === 'subledger_to_control');
    // The document is named ONCE, and by the reason that actually explains it.
    expect(bridge.filter((i) => i.documentIds.includes('inv-f'))).toHaveLength(1);
    expect(bridge.find((i) => i.documentIds.includes('inv-f'))!.type).toBe('document_after_as_at');
    expect(bridge.reduce((s, i) => s + i.amount, 0)).toBe(51750);
    expect(rec.unexplainedDifference).toBe(0);
    expect(rec.reconcilingItems.some((i) => i.type === 'unexplained_difference')).toBe(false);
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
