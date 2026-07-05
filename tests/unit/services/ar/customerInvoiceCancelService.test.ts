/**
 * Unit tests for customerInvoiceCancelService.ts — C1 GL-reversal-on-cancel.
 *
 * Bug: cancelling an approved customer invoice used to only flip status to
 * 'cancelled' and left the posted GL journal (DR Trade Debtors / CR Revenue /
 * CR VAT Output) untouched, permanently overstating AR, Revenue and VAT Output.
 *
 * Covers:
 *  1. cancel approved invoice → reverses the posted JE + status cancelled (balance is a
 *     GENERATED column and must never be written)
 *  2. cancel with amount_paid > 0 → rejected, nothing mutated
 *  3. cancel with a live payment allocation → rejected, nothing mutated
 *  4. cancel draft / no-GL invoice → no reversal attempted, status flipped
 *  5. already-reversed journal → no second reversal
 *  6. unknown invoice → InvoiceNotFoundError, nothing mutated
 *  7. already-cancelled invoice → idempotent no-op (no reversal, no update)
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { sql: sqlMock };
});

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  reverseJournalEntry: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import {
  cancelCustomerInvoice,
  InvoiceNotFoundError,
  InvoiceHasPaymentsError,
} from '@/modules/accounting/services/ar/customerInvoiceCancelService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockReverse = reverseJournalEntry as unknown as MockedFunction<typeof reverseJournalEntry>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const INVOICE_ID = '33333333-3333-3333-3333-333333333333';
const USER_ID = '66666666-6666-6666-6666-666666666666';
const JE_ID = '77777777-7777-7777-7777-777777777777';
const REVERSAL_ID = '99999999-9999-9999-9999-999999999999';

/** Concatenate a tagged-template SQL call's static fragments for assertions. */
function sqlText(call: unknown[]): string {
  const strings = call[0] as readonly string[];
  return strings.join(' ');
}

/** All UPDATE customer_invoices calls issued to the sql mock. */
function updateInvoiceCalls(): unknown[][] {
  return mockSql.mock.calls.filter((c) => /UPDATE\s+customer_invoices/i.test(sqlText(c)));
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    status: 'approved',
    amount_paid: '0',
    gl_journal_entry_id: JE_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cancelCustomerInvoice', () => {
  it('reverses the posted GL journal and flips status to cancelled without writing the generated balance column', async () => {
    mockSql
      .mockResolvedValueOnce([invoiceRow()]) // 1. invoice lookup
      .mockResolvedValueOnce([{ allocated: '0' }]) // 2. live-allocation guard
      .mockResolvedValueOnce([{ status: 'posted', reversed_at: null }]) // 3. JE status lookup
      .mockResolvedValueOnce([]); // 4. UPDATE customer_invoices
    mockReverse.mockResolvedValue({ id: REVERSAL_ID } as never);

    const result = await cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).toHaveBeenCalledTimes(1);
    expect(mockReverse).toHaveBeenCalledWith(COMPANY_ID, JE_ID, USER_ID);
    expect(result.reversedJournalEntryId).toBe(REVERSAL_ID);

    const updates = updateInvoiceCalls();
    expect(updates).toHaveLength(1);
    const text = sqlText(updates[0]!);
    expect(text).toMatch(/status\s*=\s*'cancelled'/i);
    // balance is GENERATED ALWAYS AS (total_amount - amount_paid); writing it
    // raises pg 428C9, so the UPDATE must never touch it.
    expect(text).not.toMatch(/\bbalance\b/i);
    // The journal link is nulled so a future legitimate re-post creates a fresh
    // journal instead of re-using the reversed net-zero pair.
    expect(text).toMatch(/gl_journal_entry_id\s*=\s*NULL/i);
  });

  it('propagates a reversal failure (e.g. closed period) and mutates nothing', async () => {
    mockSql
      .mockResolvedValueOnce([invoiceRow()])
      .mockResolvedValueOnce([{ allocated: '0' }])
      .mockResolvedValueOnce([{ status: 'posted', reversed_at: null }]);
    mockReverse.mockRejectedValue(new Error('Cannot post to closed fiscal period') as never);

    await expect(cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toThrow(
      /closed fiscal period/i,
    );
    // Status is never flipped when the reversal fails — the route/outer tx rolls back.
    expect(updateInvoiceCalls()).toHaveLength(0);
  });

  it('rejects cancellation when amount_paid > 0 and mutates nothing', async () => {
    mockSql.mockResolvedValueOnce([invoiceRow({ amount_paid: '500.00' })]);

    await expect(cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toBeInstanceOf(
      InvoiceHasPaymentsError,
    );

    expect(mockReverse).not.toHaveBeenCalled();
    expect(updateInvoiceCalls()).toHaveLength(0);
  });

  it('rejects cancellation when a live payment allocation exists and mutates nothing', async () => {
    mockSql
      .mockResolvedValueOnce([invoiceRow({ amount_paid: '0', gl_journal_entry_id: null })])
      .mockResolvedValueOnce([{ allocated: '250.00' }]);

    await expect(cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toBeInstanceOf(
      InvoiceHasPaymentsError,
    );

    expect(mockReverse).not.toHaveBeenCalled();
    expect(updateInvoiceCalls()).toHaveLength(0);
  });

  it('cancels a draft / no-GL invoice without attempting a reversal', async () => {
    mockSql
      .mockResolvedValueOnce([invoiceRow({ status: 'draft', gl_journal_entry_id: null })])
      .mockResolvedValueOnce([{ allocated: '0' }])
      .mockResolvedValueOnce([]);

    const result = await cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
    expect(result.reversedJournalEntryId).toBeNull();
    const updates = updateInvoiceCalls();
    expect(updates).toHaveLength(1);
    expect(sqlText(updates[0]!)).toMatch(/status\s*=\s*'cancelled'/i);
    expect(sqlText(updates[0]!)).not.toMatch(/\bbalance\b/i);
  });

  it('does not reverse a journal that is already reversed (posted + reversed_at set)', async () => {
    // Post-fix: a reversed entry keeps status='posted' with reversed_at set, so
    // idempotency hinges on reversed_at, not status.
    mockSql
      .mockResolvedValueOnce([invoiceRow()])
      .mockResolvedValueOnce([{ allocated: '0' }])
      .mockResolvedValueOnce([{ status: 'posted', reversed_at: '2026-07-01T00:00:00Z' }])
      .mockResolvedValueOnce([]);

    const result = await cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
    expect(result.reversedJournalEntryId).toBeNull();
    expect(updateInvoiceCalls()).toHaveLength(1);
  });

  it('throws InvoiceNotFoundError for an unknown invoice and mutates nothing', async () => {
    mockSql.mockResolvedValueOnce([]);

    await expect(cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID)).rejects.toBeInstanceOf(
      InvoiceNotFoundError,
    );

    expect(mockReverse).not.toHaveBeenCalled();
    expect(updateInvoiceCalls()).toHaveLength(0);
  });

  it('is a no-op when the invoice is already cancelled', async () => {
    mockSql.mockResolvedValueOnce([invoiceRow({ status: 'cancelled' })]);

    const result = await cancelCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockReverse).not.toHaveBeenCalled();
    expect(updateInvoiceCalls()).toHaveLength(0);
    expect(result.id).toBe(INVOICE_ID);
    expect(result.reversedJournalEntryId).toBeNull();
  });
});
