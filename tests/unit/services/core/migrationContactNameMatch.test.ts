/**
 * M5: the wizard matches an imported contact name to an existing one by a
 * near spelling (Dice >= 0.8), right for a hand-kept CSV. A new supplier is
 * written to `suppliers.address` (customers' `billing_address` does not exist
 * there and failed every new supplier).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/migrationService', () => ({ updateSession: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentAuthors', () => ({
  bankDetailsChange: vi.fn(() => 'none'), hasBankDetails: vi.fn(() => false),
  lockSupplierBankDetails: vi.fn(), recordBankDetailsSetter: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { importCustomers, importSuppliers } from '@/modules/accounting/services/core/migrationContactService';

const sqlMock = vi.mocked(sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>);
const insertTexts = () => sqlMock.mock.calls.map(([s]) => s.join('')).filter((t) => t.includes('INSERT INTO'));

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (s: TemplateStringsArray) =>
    (s.join('').includes('SELECT id') ? [{ id: 'c-1', name: 'ABC Tradings' }] : []));
});

describe('contact name matching', () => {
  it('a near spelling is the existing customer and is skipped', async () => {
    const r = await importCustomers('co', 's', [{ name: 'ABC Trading' }], 'skip');
    expect(r).toMatchObject({ imported: 0, skipped: 1 });
    expect(insertTexts()).toHaveLength(0);
  });

  it('the same name, whatever its case and outer spaces, is the existing customer', async () => {
    const r = await importCustomers('co', 's', [{ name: '  abc tradings ' }], 'skip');
    expect(r).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('suppliers take the same rule', async () => {
    expect(await importSuppliers('co', 's', [{ name: 'ABC Trading' }], 'skip', 'u')).toMatchObject({ skipped: 1 });
  });
});

describe('a new supplier', () => {
  it('is inserted into suppliers.address, not billing_address', async () => {
    const r = await importSuppliers('co', 's', [{ name: 'Zeta Holdings' }], 'skip', 'u');
    expect(r).toMatchObject({ imported: 1, skipped: 0 });
    const [insert] = insertTexts();
    expect(insert).toMatch(/\baddress, contact_person/);
    expect(insert).not.toContain('billing_address');
  });
});
