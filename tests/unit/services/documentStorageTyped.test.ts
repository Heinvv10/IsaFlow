/**
 * documentStorageService: the typed ownership read and the re-run duplicate
 * guard behind attach_entity_document.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => sqlMock(strings.join('?'), values),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/services/vfStorageAdapter', () => ({ vfStorage: { uploadFile: vi.fn() } }));

import {
  findActiveDuplicate,
  verifyEntityOwnershipTyped,
} from '@/modules/accounting/services/core/documentStorageService';

const ID = '66666666-6666-4666-8666-666666666666';
const CO = '22222222-2222-2222-2222-222222222222';

beforeEach(() => sqlMock.mockReset());

describe('verifyEntityOwnershipTyped', () => {
  it.each([
    ['supplier_invoice', 'FROM supplier_invoices'],
    ['customer_invoice', 'FROM customer_invoices'],
    ['supplier_payment', 'FROM supplier_payments'],
    ['customer_payment', 'FROM customer_payments'],
    ['credit_note', 'FROM credit_notes'],
  ] as const)('%s reads only its own table, fenced by company', async (type, table) => {
    sqlMock.mockResolvedValueOnce([{ ok: 1 }]);
    await expect(verifyEntityOwnershipTyped(type, ID, CO)).resolves.toBe(true);
    const [text, values] = sqlMock.mock.calls[0]!;
    expect(text).toContain(table);
    expect(text).not.toContain('UNION');
    expect(values).toEqual([ID, CO]);
  });

  it('is false on a miss and for an unknown type, which reads nothing', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(verifyEntityOwnershipTyped('credit_note', ID, CO)).resolves.toBe(false);
    await expect(verifyEntityOwnershipTyped('purchase_order' as never, ID, CO)).resolves.toBe(false);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});

describe('findActiveDuplicate', () => {
  it('matches on the STORED (sanitised) name and size among active rows', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(findActiveDuplicate('supplier_invoice', ID, 'SIV0005104 FTTX (1).pdf', 1234)).resolves.toBeNull();
    const [text, values] = sqlMock.mock.calls[0]!;
    expect(text).toContain('is_active = true');
    expect(values).toEqual(['supplier_invoice', ID, 'SIV0005104_FTTX__1_.pdf', 1234]);
  });

  it('maps a hit to a LinkedDocument', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'd1', entity_type: 'supplier_invoice', entity_id: ID, document_type: 'invoice',
      document_name: 'a.pdf', file_url: 'u', file_size: 3, mime_type: 'application/pdf',
      uploaded_by: 'x', uploaded_at: '2026-10-15T00:00:00Z', is_active: true,
    }]);
    const doc = await findActiveDuplicate('supplier_invoice', ID, 'a.pdf', 3);
    expect(doc).toMatchObject({ id: 'd1', documentName: 'a.pdf', source: 'direct' });
  });
});
