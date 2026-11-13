/**
 * reallocate_bank_transaction: the plan a RECONCILED line is judged by, before any write.
 *
 * `planReallocation` is pure — every fact it decides on is read under the line's lock by
 * `loadReallocationFacts` — so each refusal is pinned here on plain data. The integration suite
 * (tests/integration/bank-reallocate-reconciled.int.test.ts) proves the same refusals on a real ledger.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/bank/reconciledCash', () => ({ reconciliationLockOf: vi.fn() }));

import {
  BankReallocationRefusal, assertReallocatableRow, planReallocation,
  type ReallocationFacts, type ReallocationTarget,
} from '@/modules/accounting/services/bank/bankReallocationGuards';
import { reconciliationLockOf } from '@/modules/accounting/services/bank/reconciledCash';

const TX = '11111111-1111-4111-8111-111111111111';
const JE = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const BANK = '44444444-4444-4444-8444-444444444444';
const EXPENSE = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const SUP = '77777777-7777-4777-8777-777777777777';
const LEG = '88888888-8888-4888-8888-888888888888';

function facts(over: Partial<ReallocationFacts> = {}, line: Partial<ReallocationFacts['line']> = {}): ReallocationFacts {
  return {
    txId: TX,
    line: {
      status: 'reconciled', reconciliationId: REC, allocationType: 'account', allocatedEntityName: '6000 Expense',
      provisionalJeId: null, counterpartyAccountId: null, transferJournalEntryId: null, matchedLineId: LEG,
      bankAccountId: BANK, transactionDate: '2026-06-10', amount: -100, ...line,
    },
    lock: { kind: 'completed', accountName: 'Bank', statementDate: '2026-06-30' },
    chain: { lineId: LEG, journalId: JE, rootId: JE, doc: null },
    chainCashLineIds: [TX],
    reversalTarget: JE,
    journal: {
      id: JE, entryDate: '2026-06-10', lines: [
        { lineId: LEG, glAccountId: BANK, subtype: 'bank', debit: 0, credit: 100, vatType: null, cc1Id: null, cc2Id: null, buId: null },
        { lineId: 'x', glAccountId: EXPENSE, subtype: 'default_expense', debit: 100, credit: 0, vatType: null, cc1Id: null, cc2Id: null, buId: null },
      ],
    },
    documents: { supplierIds: [], customerIds: [], batch: false, applied: 0, unapplied: 0 },
    bankDefaults: {},
    targetOpenDocuments: 1,
    targetAccount: { subtype: 'default_expense' },
    ...over,
  };
}
const toOther: ReallocationTarget = { kind: 'account', glAccountId: OTHER };
const req = { expectedJournalEntryId: JE };
const refusal = (f: () => unknown): string => {
  try { f(); } catch (e) {
    expect(e).toBeInstanceOf(BankReallocationRefusal);
    expect((e as BankReallocationRefusal).code).toBe('REALLOCATION_REFUSED');
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('planReallocation', () => {
  it('plans a reallocation of a reconciled line in a completed reconciliation, dated on the original entry', () => {
    const plan = planReallocation(facts(), toOther, req);
    expect(plan).toMatchObject({ kind: 'reallocate', reconciliationId: REC, journalId: JE, entryDate: '2026-06-10' });
    expect(plan.kind === 'reallocate' && plan.bankLeg).toMatchObject({ lineId: LEG, glAccountId: BANK, credit: 100 });
  });

  it('an allocated (unreconciled) line points at reverse_bank_allocation + allocate_bank_transaction', () => {
    const m = refusal(() => planReallocation(facts({ lock: null }, { status: 'allocated' }), toOther, req));
    expect(m).toMatch(/not reconciled/);
    expect(m).toMatch(/reverse_bank_allocation/);
    expect(m).toMatch(/allocate_bank_transaction/);
  });

  it('refuses a line reconciled in the Sage import, an anomaly, and an in-progress session', () => {
    expect(refusal(() => planReallocation(facts({ lock: { kind: 'sage' } }, { reconciliationId: null }), toOther, req)))
      .toMatch(/Sage import/);
    expect(refusal(() => planReallocation(facts({ lock: { kind: 'anomaly' } }), toOther, req))).toMatch(/contact support/);
    expect(refusal(() => planReallocation(facts({ lock: { kind: 'session' } }, { status: 'matched' }), toOther, req)))
      .toMatch(/in-progress bank reconciliation/);
  });

  it('refuses a stale expected_journal_entry_id, naming the journal the line is on now', () => {
    const m = refusal(() => planReallocation(facts(), toOther, { expectedJournalEntryId: OTHER }));
    expect(m).toMatch(/expected_journal_entry_id/);
    expect(m).toContain(JE);
  });

  it('refuses a line with no journal', () => {
    expect(refusal(() => planReallocation(facts({ chain: null, journal: null }, { matchedLineId: null }), toOther, req)))
      .toMatch(/no journal/);
  });

  it('refuses a journal with reversal history (the line is not on a standing root)', () => {
    expect(refusal(() => planReallocation(facts({ chain: { lineId: LEG, journalId: JE, rootId: OTHER, doc: null } }), toOther, req)))
      .toMatch(/reversal history/);
    expect(refusal(() => planReallocation(facts({ reversalTarget: OTHER }), toOther, req))).toMatch(/reversal history/);
    expect(refusal(() => planReallocation(facts({ reversalTarget: null }), toOther, req))).toMatch(/reversal history/);
  });

  it('v1 refuses transfers, chains with another bank line, splits, provisional lines and payment batches', () => {
    expect(refusal(() => planReallocation(facts({}, { allocationType: 'transfer' }), toOther, req))).toMatch(/transfer/);
    expect(refusal(() => planReallocation(facts({}, { counterpartyAccountId: OTHER }), toOther, req))).toMatch(/transfer/);
    expect(refusal(() => planReallocation(facts({}, { transferJournalEntryId: OTHER }), toOther, req))).toMatch(/transfer/);
    expect(refusal(() => planReallocation(facts({ chainCashLineIds: [TX, OTHER] }), toOther, req))).toMatch(/more than one bank line/);
    expect(refusal(() => planReallocation(facts({}, { allocatedEntityName: 'Split allocation' }), toOther, req))).toMatch(/split/);
    expect(refusal(() => planReallocation(facts({}, { provisionalJeId: OTHER }), toOther, req))).toMatch(/provisional/);
    expect(refusal(() => planReallocation(facts({ documents: { supplierIds: [], customerIds: [], batch: true, applied: 0, unapplied: 0 } }), toOther, req)))
      .toMatch(/payment batch/);
  });

  it('refuses a line matched (not allocated) to its journal', () => {
    expect(refusal(() => planReallocation(facts({}, { allocationType: null }), toOther, req))).toMatch(/matched to an existing journal/);
  });

  it('refuses a journal dated off the statement line (the new journal could not keep its date)', () => {
    expect(refusal(() => planReallocation(facts({ journal: { ...facts().journal!, entryDate: '2026-06-11' } }), toOther, req)))
      .toMatch(/dated 2026-06-11/);
  });

  it('refuses a bank account as the target (a transfer) and the line\'s own bank account', () => {
    expect(refusal(() => planReallocation(facts({ targetAccount: { subtype: 'bank' } }), toOther, req))).toMatch(/bank account/);
    expect(refusal(() => planReallocation(facts(), { kind: 'account', glAccountId: BANK }, req))).toMatch(/bank account/);
    expect(refusal(() => planReallocation(facts({ targetAccount: null }), toOther, req))).toMatch(/Not found/);
  });

  it('the same target is nothing_changed: same account, VAT and dimensions; same supplier', () => {
    expect(planReallocation(facts(), { kind: 'account', glAccountId: EXPENSE }, req).kind).toBe('nothing_changed');
    // Same account, a different VAT code: a real change.
    expect(planReallocation(facts(), { kind: 'account', glAccountId: EXPENSE }, { ...req, vatType: 'standard' }).kind)
      .toBe('reallocate');
    // Same account, a different project: a real change.
    expect(planReallocation(facts(), { kind: 'account', glAccountId: EXPENSE }, { ...req, dims: { cc2Id: OTHER } }).kind)
      .toBe('reallocate');
    const sup = facts({ documents: { supplierIds: [SUP], customerIds: [], batch: false, applied: 100, unapplied: 0 } }, { allocationType: 'supplier' });
    expect(planReallocation(sup, { kind: 'supplier', supplierId: SUP }, req).kind).toBe('nothing_changed');
    expect(planReallocation(sup, { kind: 'supplier', supplierId: OTHER }, req).kind).toBe('reallocate');
    expect(planReallocation(sup, toOther, req).kind).toBe('reallocate');
  });
});

describe('planReallocation: what counts as the same allocation', () => {
  const doc = (applied: number, unapplied: number) => facts(
    { documents: { supplierIds: [SUP], customerIds: [], batch: false, applied, unapplied } }, { allocationType: 'supplier' });
  const same = { kind: 'supplier', supplierId: SUP } as const;
  it('the same contact with auto_apply fifo over a payment that left money on account re-applies it: a real change', () => {
    expect(planReallocation(doc(60, 40), same, req).kind).toBe('reallocate');
    expect(planReallocation(doc(60, 40), same, { ...req, autoApply: 'fifo' }).kind).toBe('reallocate');
    expect(planReallocation(doc(100, 0), same, { ...req, autoApply: 'fifo' }).kind).toBe('nothing_changed');
  });
  it('fifo over a payment left on account, with nothing open for FIFO to settle, is the same (no journals)', () => {
    const none = { ...doc(0, 400), targetOpenDocuments: 0 };
    expect(planReallocation(none, same, { ...req, autoApply: 'fifo' }).kind).toBe('nothing_changed');
    expect(planReallocation({ ...none, targetOpenDocuments: 2 }, same, { ...req, autoApply: 'fifo' }).kind).toBe('reallocate');
  });
  it("auto_apply none over a payment that applied something un-applies it: a real change; over nothing applied, the same", () => {
    expect(planReallocation(doc(60, 40), same, { ...req, autoApply: 'none' }).kind).toBe('reallocate');
    expect(planReallocation(doc(0, 100), same, { ...req, autoApply: 'none' }).kind).toBe('nothing_changed');
  });
  it('omitted dimensions mean what allocate would stamp: the bank card defaults', () => {
    const withCard = facts({ bankDefaults: { cc2Id: OTHER } });
    // Old line carries no CC2, a new allocation would stamp the card's: not the same.
    expect(planReallocation(withCard, { kind: 'account', glAccountId: EXPENSE }, req).kind).toBe('reallocate');
    const stamped = facts({ bankDefaults: { cc2Id: OTHER }, journal: { ...facts().journal!, lines: facts().journal!.lines
      .map((l) => (l.glAccountId === EXPENSE ? { ...l, cc2Id: OTHER } : l)) } });
    expect(planReallocation(stamped, { kind: 'account', glAccountId: EXPENSE }, req).kind).toBe('nothing_changed');
    // A control-account contra carries none, and dims named on one are never "the same" (allocate refuses them).
    const control = facts({ targetAccount: { subtype: 'vat_input' }, bankDefaults: { cc2Id: OTHER } });
    expect(planReallocation(control, { kind: 'account', glAccountId: EXPENSE }, req).kind).toBe('nothing_changed');
    expect(planReallocation(control, { kind: 'account', glAccountId: EXPENSE }, { ...req, dims: { cc2Id: OTHER } }).kind)
      .toBe('reallocate');
  });
  it('two lines on the target account is not "the same" (it is not one contra line)', () => {
    const two = facts({ journal: { ...facts().journal!, lines: [...facts().journal!.lines,
      { lineId: 'y', glAccountId: EXPENSE, subtype: 'default_expense', debit: 0, credit: 0, vatType: null, cc1Id: null, cc2Id: null, buId: null }] } });
    expect(planReallocation(two, { kind: 'account', glAccountId: EXPENSE }, req).kind).toBe('reallocate');
  });
  it("refuses when the line's journal line is not on the line's bank account", () => {
    const off = facts({ journal: { ...facts().journal!, lines: facts().journal!.lines
      .map((l) => (l.lineId === LEG ? { ...l, glAccountId: OTHER } : l)) } });
    expect(refusal(() => planReallocation(off, toOther, req))).toMatch(/not on its bank account/);
  });
});

describe('assertReallocatableRow (allocateTransaction under opts.reallocation)', () => {
  const row = { id: TX, status: 'reconciled', reconciliation_id: REC };
  it('accepts the locked row only when it is reconciled on exactly that completed reconciliation', async () => {
    vi.mocked(reconciliationLockOf).mockResolvedValue({ kind: 'completed', accountName: 'Bank', statementDate: '2026-06-30' });
    await expect(assertReallocatableRow('co', row, { reconciliationId: REC })).resolves.toBeUndefined();
    await expect(assertReallocatableRow('co', row, { reconciliationId: OTHER })).rejects.toBeInstanceOf(BankReallocationRefusal);
    await expect(assertReallocatableRow('co', { ...row, status: 'allocated' }, { reconciliationId: REC }))
      .rejects.toBeInstanceOf(BankReallocationRefusal);
    await expect(assertReallocatableRow('co', { ...row, reconciliation_id: null }, { reconciliationId: REC }))
      .rejects.toBeInstanceOf(BankReallocationRefusal);
  });
  it('refuses when the reconciliation is no longer completed', async () => {
    vi.mocked(reconciliationLockOf).mockResolvedValue({ kind: 'anomaly' });
    await expect(assertReallocatableRow('co', row, { reconciliationId: REC })).rejects.toBeInstanceOf(BankReallocationRefusal);
  });
});
