/**
 * allocationFacts (bankLineImporterGate.ts) on a SPLIT journal: the reversal
 * and match gates judge an allocation by its arm. A split can carry several
 * documents and GL lines beside them, so the arm is judged over all of them,
 * and where they differ an ENFORCED one wins. Before, the first document read
 * (`LIMIT 1`) decided: an R0.01 receipt line made a GL split ungated, an R0.01
 * supplier line moved it to a payment arm that may be switched off.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => [{ journal_by: 'u-journal', run_by: null }]) }));
vi.mock('@/modules/accounting/services/bank/splitJournalDocuments', () => ({ documentsOnJournal: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/approvalEnforcement', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/gl/approvalEnforcement')>()),
  isEnforced: vi.fn(async () => false),
}));

import { documentsOnJournal, type JournalDocument } from '@/modules/accounting/services/bank/splitJournalDocuments';
import { isEnforced } from '@/modules/accounting/services/gl/approvalEnforcement';
import { allocationFacts } from '@/modules/accounting/services/bank/bankLineImporterGate';

const COMPANY = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const supplier = (createdBy = 'u-sup'): JournalDocument => ({ kind: 'supplier', createdBy, total: 0.01, live: true });
const customer = (createdBy = 'u-cus'): JournalDocument => ({ kind: 'customer', createdBy, total: 0.01, live: true });
function onJournal(docs: JournalDocument[], hasOtherLines: boolean): void {
  vi.mocked(documentsOnJournal).mockResolvedValue({ docs, journalTotal: 10000, hasOtherLines });
}
const facts = (amount: number) => allocationFacts(COMPANY, { amount, auto_post_run_id: null }, 'je-root');
const enforce = (...types: string[]) => vi.mocked(isEnforced).mockImplementation(async (_c, t) => types.includes(t));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isEnforced).mockResolvedValue(false);
});

describe('whole-line allocations keep their arm', () => {
  it('a plain journal is manual_journal', async () => {
    onJournal([], false);
    expect((await facts(-10000))?.arm).toBe('manual_journal');
  });

  it('a supplier payment is supplier_payment; a receipt is ungated', async () => {
    onJournal([supplier()], false);
    expect((await facts(-10000))?.arm).toBe('supplier_payment');
    onJournal([customer()], false);
    expect(await facts(10000)).toBeNull();
  });
});

describe('a split is judged over every part', () => {
  it('a GL split with a R0.01 receipt line stays manual_journal (money in)', async () => {
    onJournal([customer()], true);
    expect((await facts(10000))?.arm).toBe('manual_journal');
  });

  it('a GL split with a R0.01 supplier line: manual_journal when that is the enforced arm', async () => {
    onJournal([supplier()], true);
    enforce('manual_journal');
    expect((await facts(-10000))?.arm).toBe('manual_journal');
  });

  it('… and supplier_payment when THAT is the enforced arm', async () => {
    onJournal([supplier()], true);
    enforce('supplier_payment');
    expect((await facts(-10000))?.arm).toBe('supplier_payment');
  });

  it('every document\'s creator is an allocator, not only the first one read', async () => {
    onJournal([supplier('u-a'), supplier('u-b')], false);
    expect((await facts(-10000))?.allocators.sort()).toEqual(['u-a', 'u-b', 'u-journal']);
  });
});
