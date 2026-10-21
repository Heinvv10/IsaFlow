/**
 * M5: the wizard matches an imported contact name to an existing one by a
 * near spelling (Dice >= 0.8), right for a hand-kept CSV. Where a source's
 * names are already canonical a near spelling is a different contact:
 * 'exact' takes the same name only, and the CSV default is unchanged.
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
const inserts = () => sqlMock.mock.calls.filter(([s]) => s.join('').includes('INSERT INTO')).length;

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (s: TemplateStringsArray) =>
    (s.join('').includes('SELECT id') ? [{ id: 'c-1', name: 'ABC Tradings' }] : []));
});

describe('contact name matching', () => {
  it('similar (the CSV default): a near spelling is the existing contact and is skipped', async () => {
    const r = await importCustomers('co', 's', [{ name: 'ABC Trading' }], 'skip');
    expect(r).toMatchObject({ imported: 0, skipped: 1 });
    expect(inserts()).toBe(0);
  });

  it('exact: a near spelling is a new contact', async () => {
    const r = await importCustomers('co', 's', [{ name: 'ABC Trading' }], 'skip', 'exact');
    expect(r).toMatchObject({ imported: 1, skipped: 0 });
    expect(inserts()).toBe(1);
  });

  it('exact still finds the same name, whatever its case and outer spaces', async () => {
    const r = await importCustomers('co', 's', [{ name: '  abc tradings ' }], 'skip', 'exact');
    expect(r).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('suppliers take the same rule', async () => {
    expect(await importSuppliers('co', 's', [{ name: 'ABC Trading' }], 'skip', 'u')).toMatchObject({ skipped: 1 });
    expect(await importSuppliers('co', 's', [{ name: 'ABC Trading' }], 'skip', 'u', 'exact')).toMatchObject({ imported: 1 });
  });
});
