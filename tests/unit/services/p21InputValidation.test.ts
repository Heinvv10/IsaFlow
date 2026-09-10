// RED phase — written before implementation (A–Z programme P2.1, audit W1/W2/W3/N6)
/**
 * P2.1 input-validation cluster:
 *
 * W1 — negative quantities/amounts must be rejected server-side on invoice
 *      and quote lines (the audit created a −R115.00 invoice live).
 * W2 — customers/suppliers with open documents cannot be soft-deleted.
 * W3 — DRAFT payment allocations must count other drafts' pending
 *      allocations, not just confirmed amount_paid (two drafts could each
 *      allocate the full balance; both confirm → over-payment).
 * N6 — a credit note auto-applied at approve (linked to an invoice) must
 *      end 'applied', so a subsequent explicit apply is rejected instead of
 *      double-crediting the invoice.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) =>
      d instanceof Date
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        : String(d ?? ''),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn().mockResolvedValue({ id: 'je-rev' }),
}));

// approve/cancel now take a FOR UPDATE row lock, which refuses to run outside a
// request transaction. This suite drives the service with a mocked sql tag and
// no ALS context, so the lock is stubbed to answer from the same mock the old
// unlocked SELECT read. The lock's own contract is proven in
// tests/integration/api/creditNoteLock.test.ts.
vi.mock('@/modules/accounting/services/ar/creditNoteLock', () => ({
  lockCreditNoteForUpdate: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ id: 'acct-1' }),
}));

import { sql } from '@/lib/neon';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { createJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { createQuote } from '@/modules/accounting/services/ar/quoteService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';


const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const ENTITY_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

/** Text-keyed sql mock. */
function mockByText(routes: Record<string, unknown[] | Error>) {
  mockSql.mockImplementation((strings: unknown) => {
    if(!Array.isArray(strings)||strings.some(value=>typeof value!=='string'))throw new Error('Expected SQL template');
    const text = (strings as unknown as string[]).join('?');
    for (const [pattern, result] of Object.entries(routes)) {
      if (new RegExp(pattern, 'i').test(text)) {
        return result instanceof Error ? Promise.reject(result) : Promise.resolve([...(result as unknown[])]);
      }
    }
    return Promise.resolve([]);
  });
}

beforeEach(() => {
  vi.resetAllMocks(); // wipes factory implementations too — re-prime below
  mockSql.mockResolvedValue([]);
  (getSystemAccount as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'acct-1' });
  (createJournalEntry as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'je-1' });
  (reverseJournalEntry as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'je-rev' });
});

// ── W1: negative lines ────────────────────────────────────────────────────────

describe('W1 — negative quantities/amounts rejected (quotes)', () => {
  it('createQuote rejects a negative quantity', async () => {
    await expect(
      createQuote(COMPANY_ID, {
        customerName: 'X',
        lines: [{ description: 'bad', quantity: -1, unitPrice: 115 }],
      } as never, USER_ID),
    ).rejects.toThrow(/quantity|positive/i);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('createQuote rejects a negative unit price', async () => {
    await expect(
      createQuote(COMPANY_ID, {
        customerName: 'X',
        lines: [{ description: 'bad', quantity: 1, unitPrice: -115 }],
      } as never, USER_ID),
    ).rejects.toThrow(/price|negative/i);
    expect(mockSql).not.toHaveBeenCalled();
  });
});

// ── W2: soft-delete guard ─────────────────────────────────────────────────────

describe('W2 — soft-delete blocked while open documents exist', () => {
  it('blocks deleting a customer with open invoices', async () => {
    mockByText({
      'FROM customer_invoices': [{ open_count: '2' }],
    });

    await expect(softDelete(COMPANY_ID, 'customer', ENTITY_ID)).rejects.toThrow(
      /open (invoice|document)/i,
    );
    // never reached the UPDATE
    const updates = mockSql.mock.calls
      .map((c) => (c[0] as string[]).join('?'))
      .filter((t) => /UPDATE customers SET deleted_at/i.test(t));
    expect(updates).toHaveLength(0);
  });

  it('blocks deleting a supplier with open invoices', async () => {
    mockByText({
      'FROM supplier_invoices': [{ open_count: '1' }],
    });

    await expect(softDelete(COMPANY_ID, 'supplier', ENTITY_ID)).rejects.toThrow(
      /open (invoice|document)/i,
    );
  });

  it('still deletes a customer with no open documents', async () => {
    mockByText({
      'FROM customer_invoices': [{ open_count: '0' }],
      'FROM customer_payments': [{ open_count: '0' }],
      'UPDATE customers SET deleted_at': [{ id: ENTITY_ID }],
    });

    const result = await softDelete(COMPANY_ID, 'customer', ENTITY_ID);
    expect(result.undoToken).toBeTruthy();
  });
});

// W3/N6 actual pending draft balance and linked credit-note exactly-once: arCiCreditPayment.int.test.ts.
