/**
 * #1656 round 4 (F-M4): an invoice delete / undo asks Approve only when it takes a journal off or puts one back, decided UNDER the
 * invoice's row lock (not from a status read before it): a draft delete needs nothing, so a former accountant can still delete
 * drafts; an invoice that is approved or later, or carries a journal, needs `allowReversal`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
const assertInvoiceDeletable = vi.fn();
vi.mock('@/modules/accounting/services/core/softDeleteInvoiceGuards', () => ({ assertInvoiceDeletable: (...a: unknown[]) => assertInvoiceDeletable(...a) }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ reverseJournalEntry: vi.fn(async () => ({ id: 'rev-1' })) }));
vi.mock('@/modules/accounting/services/shared/journalChainHead', () => ({ findJournalChainHead: vi.fn(async () => ({ kind: 'head', id: 'je-1', standing: true, unreversed: 1 })) }));

import { sql } from '@/lib/neon';
import { prepareInvoiceDelete, reinstateInvoiceJournal } from '@/modules/accounting/services/core/softDeleteJournalService';

const args = ['customer_invoice', 'inv-1', 'co-1', 'u-1'] as const;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(sql).mockResolvedValue([] as never); });

describe('prepareInvoiceDelete: Approve decided on the locked row', () => {
  it.each([
    ['approved', null], ['sent', null], ['draft', 'je-1'], ['paid', null], ['something_new', null],
  ])('status %s, journal %s: refused without Approve, nothing read or written after the lock', async (status, journal) => {
    assertInvoiceDeletable.mockResolvedValue({ status, gl_journal_entry_id: journal });
    await expect(prepareInvoiceDelete(...args, { allowReversal: false })).rejects.toMatchObject({ name: 'ApprovePermissionError', module: 'customers' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('a supplier bill asks Suppliers & AP', async () => {
    assertInvoiceDeletable.mockResolvedValue({ status: 'approved', gl_journal_entry_id: 'je-1' });
    await expect(prepareInvoiceDelete('supplier_invoice', 'b-1', 'co-1', 'u-1', { allowReversal: false })).rejects.toMatchObject({ module: 'suppliers' });
  });

  it.each(['draft', 'pending_approval', 'cancelled'])('a %s invoice with no journal deletes without Approve (a former accountant may delete drafts)', async (status) => {
    assertInvoiceDeletable.mockResolvedValue({ status, gl_journal_entry_id: null });
    await expect(prepareInvoiceDelete(...args, { allowReversal: false })).resolves.toEqual({ reversalJournalEntryId: null });
  });

  it('with Approve an approved invoice goes on to reverse its journal (the lock reads are made)', async () => {
    assertInvoiceDeletable.mockResolvedValue({ status: 'approved', gl_journal_entry_id: 'je-1' });
    vi.mocked(sql).mockResolvedValue([{ status: 'posted', reversed_at: null }] as never);
    await prepareInvoiceDelete(...args, { allowReversal: true });
    expect(sql).toHaveBeenCalled();
  });
});

describe('reinstateInvoiceJournal: the undo puts an invoice back on the books only for a person with Approve', () => {
  it('a recorded reversal and no Approve: refused', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ status: 'approved', gl_journal_entry_id: 'je-1' }] as never);
    await expect(reinstateInvoiceJournal(...args, { allowReversal: false })).rejects.toMatchObject({ name: 'ApprovePermissionError', module: 'customers' });
  });

  it.each(['approved', 'sent', 'paid'])('round 6 (L4): a %s invoice with NO journal (a Sage import) is refused too: the restore puts it back on the books', async (status) => {
    vi.mocked(sql).mockResolvedValueOnce([{ status, gl_journal_entry_id: null }] as never);
    await expect(reinstateInvoiceJournal(...args, { allowReversal: false })).rejects.toMatchObject({ name: 'ApprovePermissionError' });
  });

  it('a draft invoice with no recorded reversal: the undo needs no Approve', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ status: 'draft', gl_journal_entry_id: null }] as never).mockResolvedValueOnce([] as never);
    await expect(reinstateInvoiceJournal(...args, { allowReversal: false })).resolves.toBeNull();
  });

  it('with Approve a journal-less approved invoice is restored (nothing recorded to re-post)', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ status: 'approved', gl_journal_entry_id: null }] as never).mockResolvedValueOnce([] as never);
    await expect(reinstateInvoiceJournal(...args, { allowReversal: true })).resolves.toBeNull();
  });
});
