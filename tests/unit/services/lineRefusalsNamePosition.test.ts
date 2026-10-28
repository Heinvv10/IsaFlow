/**
 * A refused line is named by its POSITION, never its description. These messages are thrown into the API error
 * handler, which captures them; a description is customer text (a name, a bank reference, a note), so it must not
 * be in them. Each case puts a recognisable payee in the offending line's description and in a clean line before it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) });
  return { sql: sqlMock, withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)), withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ assertCustomerInCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({ assertLineAccountIds: vi.fn() }));

import { assertSupplierInvoiceLines } from '@/modules/accounting/services/ap/supplierInvoiceTotals';
import { assertValidLines } from '@/modules/accounting/services/ar/quoteService';
import { calcTotals } from '@/modules/accounting/services/ar/salesOrderService';
import { createRecurringInvoice } from '@/modules/accounting/services/ar/recurringInvoiceService';
import { parseLineItems } from '@/modules/accounting/services/ar/recurringInvoiceTemplate';
import { assertWipEntryLines } from '@/modules/accounting/services/practice/wipInvoiceGuards';

const PAYEE = 'J SMITH 0123456789';
const message = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
};
const messageAsync = async (fn: () => Promise<unknown>): Promise<string> => {
  try { await fn(); } catch (e) { return (e as Error).message; }
  throw new Error('expected a throw');
};

describe('supplier invoice lines', () => {
  const item = (over: object) => ({ description: PAYEE, quantity: 1, unitPrice: 10, taxRate: 15, ...over });
  it.each([
    [{ quantity: 0 }, 'Line 2: quantity must be positive'],
    [{ unitPrice: -1 }, 'Line 2: unit price cannot be negative'],
  ])('%j -> %s', (over, want) => {
    expect(message(() => assertSupplierInvoiceLines([item({ description: 'ok' }), item(over)] as never, false))).toBe(want);
  });
  it('a bad tax amount is named by position', () => {
    const m = message(() => assertSupplierInvoiceLines([item({ description: 'ok' }), item({ taxAmount: -5 })] as never, true));
    expect(m).toBe('Line 2: tax amount must be a non-negative number');
  });
});

describe('quote lines', () => {
  it.each([
    [{ quantity: 0, unitPrice: 5 }, 'Line 2: quantity must be positive'],
    [{ quantity: 1, unitPrice: -5 }, 'Line 2: unit price cannot be negative'],
  ])('%j -> %s', async (over, want) => {
    expect(await messageAsync(() => assertValidLines('co', [{ description: 'ok', quantity: 1, unitPrice: 1 }, { description: PAYEE, ...over }] as never))).toBe(want);
  });
});

describe('sales order lines', () => {
  it.each([
    [{ quantity: 0, unit_price: 5 }, 'Line 2: quantity must be positive'],
    [{ quantity: 1, unit_price: -5 }, 'Line 2: unit price cannot be negative'],
  ])('%j -> %s', (over, want) => {
    expect(message(() => calcTotals([{ description: 'ok', quantity: 1, unit_price: 1 }, { description: PAYEE, ...over }] as never))).toBe(want);
  });
});

describe('recurring invoice lines', () => {
  it.each([
    [{ quantity: 0, unitPrice: 5 }, 'Line 2: quantity must be positive'],
    [{ quantity: 1, unitPrice: -5 }, 'Line 2: unit price cannot be negative'],
  ])('create: %j -> %s', async (over, want) => {
    const input = { clientId: 'c1', lineItems: [{ description: 'ok', quantity: 1, unitPrice: 1 }, { description: PAYEE, ...over }] };
    expect(await messageAsync(() => createRecurringInvoice('co', input as never, 'u'))).toBe(want);
  });

  it('a stored template line already has a position, and no description', () => {
    const lines = JSON.stringify([{ description: 'ok', quantity: 1, unitPrice: 1 }, { description: PAYEE, quantity: 0, unitPrice: 1 }]);
    expect(message(() => parseLineItems('rec-1', lines))).toBe('Recurring invoice rec-1 line 2: quantity must be a positive number');
    const bad = JSON.stringify([{ description: PAYEE, quantity: 1, unitPrice: -1 }]);
    expect(message(() => parseLineItems('rec-1', bad))).toBe('Recurring invoice rec-1 line 1: unit price must be zero or more');
  });
});

describe('WIP time entries', () => {
  const entry = (over: object) => ({ id: 'te', entry_date: '2026-01-05', task_description: PAYEE, hours: 4, applied_rate: 250, line_total: 1000, ...over });
  it('a negative rate names the entry by position and date', () => {
    const m = message(() => assertWipEntryLines([entry({ task_description: 'ok' }), entry({ applied_rate: -1, line_total: -4 })]));
    expect(m).toMatch(/^time entry 2 \(2026-01-05\) has a negative or non-numeric amount/);
    expect(m).not.toContain('J SMITH');
  });
  it('a line that is not hours x rate names the entry by position and date', () => {
    const m = message(() => assertWipEntryLines([entry({ line_total: 5000 })]));
    expect(m).toMatch(/^time entry 1 \(2026-01-05\) has a line of 5000/);
    expect(m).not.toContain('J SMITH');
  });
});
