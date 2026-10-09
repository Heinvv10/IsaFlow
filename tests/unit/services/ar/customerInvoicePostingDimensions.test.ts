/**
 * Dimensions Phase 1 — postCustomerInvoiceToGL builds its revenue legs from the
 * items' STORED CC1/CC2/BU (read with the stored lines,
 * invoiceLineCodingGuard.storedInvoiceLines, since migration 874), and never
 * puts a dimension on the AR or VAT leg. The customer's FNO is read only to
 * refuse, when approving, an item saved without it (dimensionStoredPosting).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/modules/accounting/services/shared/documentCurrency', async (importOriginal) =>
  (await import('../../helpers/documentCurrencyMock')).documentCurrencyMock(await importOriginal()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })), postJournalEntry: vi.fn(async () => ({})),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ resolveUserUuid: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ assertNoInactiveAccountLines: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({ getPeriodStatusForDate: vi.fn(async () => 'open') }));
vi.mock('@/modules/accounting/services/gl/journalVatLockGuard', () => ({ assertJournalVatPeriodOpen: vi.fn() }));
const { stored } = vi.hoisted(() => ({ stored: { value: null as unknown } }));
vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({
  storedInvoiceLines: vi.fn(async () => stored.value),
  storedLinesRefusal: vi.fn(async () => null),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(async (role: string) => ({ id: role })),
}));

import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerInvoiceGlPosting';

const INV = {
  id: 'inv-1', invoice_number: 'INV-9', status: 'approved', gl_journal_entry_id: null,
  invoice_date: '2026-09-30', subtotal: '1000.00', tax_amount: '150.00', total_amount: '1150.00',
};
const storedLines = (customerFnoId: string | null, lines: Record<string, unknown>[]) => {
  stored.value = { invoiceNumber: 'INV-9', subtotal: 1000, customerFnoId,
    lines: lines.map((l) => ({ glAccountId: null, projectId: null, ...l })) };
};

beforeEach(() => {
  vi.clearAllMocks();
  sqlMock.mockResolvedValueOnce([INV]).mockResolvedValue([]);
});

type Line = { glAccountId: string; credit: number; cc1Id?: string; cc2Id?: string; buId?: string };
const posted = () => (vi.mocked(createJournalEntry).mock.calls[0]![1] as { lines: Line[] }).lines;

describe('postCustomerInvoiceToGL — revenue dimensions', () => {
  it("splits revenue by the items' STORED dimensions; AR and VAT untagged", async () => {
    storedLines('fno-ft', [
      { amount: 700, cc1Id: 'fno-ft', cc2Id: 'lawley', buId: 'act' },
      { amount: 300, cc1Id: 'fno-ft', buId: 'maint' },
    ]);
    await postCustomerInvoiceToGL('co-1', 'inv-1', 'user-1');
    const lines = posted();
    const revenue = lines.filter((l) => l.glAccountId === 'default_revenue');
    expect(revenue).toEqual([
      expect.objectContaining({ credit: 700, cc1Id: 'fno-ft', cc2Id: 'lawley', buId: 'act' }),
      expect.objectContaining({ credit: 300, cc1Id: 'fno-ft', buId: 'maint' }),
    ]);
    for (const l of lines.filter((x) => x.glAccountId !== 'default_revenue')) {
      expect(l.cc1Id ?? l.cc2Id ?? l.buId).toBeUndefined();
    }
  });

  it('approving: refuses, posting nothing, an item saved without the FNO its customer now has', async () => {
    storedLines('fno-ft', [{ amount: 1000 }]);
    await expect(postCustomerInvoiceToGL('co-1', 'inv-1', 'user-1', { approvingFromStatus: 'draft' }))
      .rejects.toThrow(/customer's FNO.*Re-save the draft/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('already approved: posts the line as stored, adding no FNO, and never re-derives (POST_AS_STORED)', async () => {
    storedLines('fno-ft', [{ amount: 1000 }]);
    await postCustomerInvoiceToGL('co-1', 'inv-1', 'user-1');
    expect(posted().filter((l) => l.glAccountId === 'default_revenue'))
      .toEqual([{ glAccountId: 'default_revenue', debit: 0, credit: 1000, description: 'Revenue: INV-9' }]);
    expect(vi.mocked(createJournalEntry).mock.calls[0]![4]).toEqual({ dimensionAssignmentMode: 'historical-copy' });
  });

  it('posts the single revenue line exactly as before when nothing names a dimension', async () => {
    storedLines(null, [{ amount: 1000 }]);
    await postCustomerInvoiceToGL('co-1', 'inv-1', 'user-1');
    expect(posted().filter((l) => l.glAccountId === 'default_revenue'))
      .toEqual([{ glAccountId: 'default_revenue', debit: 0, credit: 1000, description: 'Revenue: INV-9' }]);
  });
});
