/**
 * splitJournalDocuments.ts — what a bank allocation's journal carries besides
 * its documents, and the refusal that keeps a void of ONE part of a split from
 * reversing all of it (paymentVoidService for MCP, voidViaBankAllocation for
 * the AP / AR voids). The whole-line shapes — one document whose total is the
 * journal's — must stay voidable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({ reverseReconciledTransaction: vi.fn() }));

import { sql } from '@/lib/neon';
import { documentsOnJournal, splitPartRefusal } from '@/modules/accounting/services/bank/splitJournalDocuments';
import { voidViaBankAllocation, type BankLeg } from '@/modules/accounting/services/ap/paymentJournalReversal';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { SupplierPaymentRefusal } from '@/modules/accounting/services/ap/supplierPaymentRefusal';

const COMPANY = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const JE = 'je-1';
type Doc = { kind: string; created_by: string | null; total: number; live: boolean };

/** The documents on the journal, then its total debits — the two reads, answered by what each reads. */
function journal(docs: Doc[], journalTotal: number): void {
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) =>
    (strings.join('?').includes('SUM(debit)') ? [{ total: journalTotal }] : docs)) as never);
}
const doc = (total: number, extra: Partial<Doc> = {}): Doc => ({ kind: 'supplier', created_by: 'u-1', total, live: true, ...extra });

beforeEach(() => {
  vi.resetAllMocks();
});

describe('documentsOnJournal', () => {
  it('a whole-line allocation: one document, the journal\'s whole amount — nothing else on it', async () => {
    journal([doc(1959.48)], 1959.48);
    expect(await documentsOnJournal(COMPANY, JE)).toMatchObject({ journalTotal: 1959.48, hasOtherLines: false });
  });

  it('a mixed split: the documents cover less than the journal — the rest is GL lines', async () => {
    journal([doc(800)], 1959.48);
    expect((await documentsOnJournal(COMPANY, JE)).hasOtherLines).toBe(true);
  });

  it('a refund counts at its size, not its sign', async () => {
    journal([doc(-300, { kind: 'customer' })], 300);
    expect((await documentsOnJournal(COMPANY, JE)).hasOtherLines).toBe(false);
  });
});

describe('splitPartRefusal', () => {
  it('lets a whole-line allocation be voided', async () => {
    journal([doc(1959.48)], 1959.48);
    expect(await splitPartRefusal(COMPANY, JE, 'Payment SP-1')).toBeNull();
  });

  it('refuses one of two documents on the journal', async () => {
    journal([doc(800), doc(1159.48)], 1959.48);
    expect(await splitPartRefusal(COMPANY, JE, 'Payment SP-1')).toMatch(/Payment SP-1 is one part of a split bank allocation \(2 payment documents\)/);
  });

  it('refuses the one document of a split that also has GL lines', async () => {
    journal([doc(800)], 1959.48);
    expect(await splitPartRefusal(COMPANY, JE, 'Receipt CR-1')).toMatch(/\(GL-account lines\).*reverse_bank_allocation/);
  });

  it('a cancelled sibling no longer counts', async () => {
    journal([doc(1959.48), doc(1959.48, { live: false })], 1959.48);
    expect(await splitPartRefusal(COMPANY, JE, 'Payment SP-1')).toBeNull();
  });
});

describe('voidViaBankAllocation (the AP / AR voids)', () => {
  const leg = { allocatedLineIds: ['bt-1'], bankLineIds: [] } as unknown as BankLeg;

  it('refuses one part of a split — the bank path would reverse every part', async () => {
    journal([doc(800), doc(1159.48)], 1959.48);
    const err = await voidViaBankAllocation(COMPANY, leg, 'user-1', 'Payment SP-1', JE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierPaymentRefusal);
    expect(String((err as Error).message)).toMatch(/one part of a split bank allocation/);
    expect(reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('still reverses a whole-line allocation through the bank path', async () => {
    journal([doc(1959.48)], 1959.48);
    expect(await voidViaBankAllocation(COMPANY, leg, 'user-1', 'Payment SP-1', JE)).toBe(true);
    expect(reverseReconciledTransaction).toHaveBeenCalledWith(COMPANY, 'bt-1', 'user-1');
  });
});
