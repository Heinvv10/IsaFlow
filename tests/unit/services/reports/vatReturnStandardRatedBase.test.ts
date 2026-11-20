/**
 * getVATReturn's standardRatedSupplies (PR #1648 review T8): a legacy invoice contributes its subtotal when its header
 * rate is above zero; a typed invoice (migration 1008: every line carries its VAT type) contributes its RATED lines'
 * amount only, whatever its header rate. The query returns the legacy sum and the typed lines' sums by VAT type; which
 * types count is decided here, so `sql` is mocked and answered by statement.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ sales: [] as Record<string, unknown>[] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: readonly string[]) => {
    const text = strings.join('?');
    if (/FROM customer_invoices ci/.test(text)) return db.sales;
    if (/FROM supplier_invoices/.test(text)) return [{ base: '0' }];
    return []; // no VAT journal lines: the boxes are not under test here
  }),
}));

import { getVATReturn } from '@/modules/accounting/services/reports/vatReturnService';

const legacy = (base: string) => ({ kind: 'legacy', vat_type: null, base });
const typed = (vatType: string, base: string) => ({ kind: 'typed', vat_type: vatType, base });
const salesBase = async () => (await getVATReturn('co', '2026-07-01', '2026-07-31')).standardRatedSupplies;

describe('getVATReturn standardRatedSupplies', () => {
  beforeEach(() => { db.sales = []; });

  it('a legacy invoice: its subtotal (the query already kept only rated headers)', async () => {
    db.sales = [legacy('1000.00')];
    expect(await salesBase()).toBe(1000);
  });

  it('a typed mixed invoice: its standard lines only, not zero-rated or exempt', async () => {
    db.sales = [typed('standard', '1000.00'), typed('zero_rated', '300.00'), typed('exempt', '200.00')];
    expect(await salesBase()).toBe(1000);
  });

  it('a typed all-exempt invoice contributes nothing, whatever its header rate', async () => {
    db.sales = [typed('exempt', '1000.00')];
    expect(await salesBase()).toBe(0);
  });

  it('legacy and typed together add up', async () => {
    db.sales = [legacy('500.00'), typed('standard', '1000.00'), typed('exempt', '200.00')];
    expect(await salesBase()).toBe(1500);
  });

  it('no invoices: 0', async () => {
    expect(await salesBase()).toBe(0);
  });
});
