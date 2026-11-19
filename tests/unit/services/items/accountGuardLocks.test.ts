/**
 * The bill-line account rule behind an item's purchases default (and a PO line's defaulted account) is ONE batched query over the
 * distinct accounts in id order, never a loop in row / line order: a per-account loop takes FOR SHARE in that order, and a concurrent
 * account merge (which locks in id order) could deadlock it (40P01). A DRY RUN takes no lock at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import { loadUpsertContext } from '@/modules/accounting/services/items/itemUpsertContext';
import { defaultNewPoLines } from '@/modules/accounting/services/ap/purchaseOrderItemLines';
import { billLineAccountRefusalsById } from '@/modules/accounting/services/ap/billLineAccountGuard';

const COMPANY = '22222222-2222-4222-8222-222222222222';
const A3 = 'cccccccc-0000-4000-8000-000000000003';
const A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const A2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const ITEM = '33333333-3333-4333-8333-333333333333';
const sqlMock = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;

const guardCalls = () => sqlMock.mock.calls.filter((c: unknown[]) => (c[0] as string[]).join('?').includes('has_children'));
const text = (c: unknown[]) => (c[0] as string[]).join('?');

beforeEach(() => {
  sqlMock.mockReset();
  sqlMock.mockImplementation(async (strings: ReadonlyArray<string>, ...values: unknown[]) => {
    const t = strings.join('?');
    if (t.includes('has_children')) {
      return (values[1] as string[]).map((id) => ({ id, account_code: id.slice(0, 4), account_name: 'n', account_subtype: id === A2 ? 'payable' : 'operating_expense', is_active: true, has_children: false }));
    }
    if (t.includes('FROM gl_accounts')) return (values[1] as string[]).map((id) => ({ id, is_active: true }));
    if (t.includes('FROM items i')) return [];
    if (t.includes('FROM items')) return [{ id: ITEM, is_active: true, purchases_account_id: A2, sales_account_id: null, vat_on_purchases: null, vat_on_sales: null }];
    return [];
  });
});

const rows = [A3, A1, A2, A1].map((a, i) => ({ code: `C${i}`, purchasesAccountId: a }));

describe('loadUpsertContext: the purchases accounts\' bill-line rule', () => {
  it('is ONE query over the distinct ids, sorted, with FOR SHARE once (a live call)', async () => {
    const ctx = await loadUpsertContext(COMPANY, rows, [], { lock: true });
    expect(guardCalls()).toHaveLength(1);
    expect(guardCalls()[0]!.slice(1)).toContainEqual([A1, A2, A3]);
    expect(text(guardCalls()[0]!)).toMatch(/FOR SHARE OF a/);
    expect(ctx.accountProblems.get(`purchases:${A2}`)).toMatch(/cannot be coded to/);
    expect(ctx.accountProblems.has(`purchases:${A1}`)).toBe(false);
  });

  it('takes NO lock on a dry run (lock: false), still one query, same verdicts', async () => {
    const ctx = await loadUpsertContext(COMPANY, rows, [], { lock: false });
    expect(guardCalls()).toHaveLength(1);
    expect(text(guardCalls()[0]!)).not.toMatch(/FOR SHARE|FOR UPDATE/);
    expect(ctx.accountProblems.get(`purchases:${A2}`)).toMatch(/cannot be coded to/);
  });

  it('locks by default (a caller that says nothing is a live call)', async () => {
    await loadUpsertContext(COMPANY, rows);
    expect(text(guardCalls()[0]!)).toMatch(/FOR SHARE OF a/);
  });
});

describe('billLineAccountRefusalsById', () => {
  it('names a missing (foreign) account and sorts the ids it asks for, lower-cased and de-duplicated', async () => {
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
    const out = await billLineAccountRefusalsById(COMPANY, [A3.toUpperCase(), A1, A3, null, '']);
    expect(sqlMock.mock.calls[0]!.slice(1)).toContainEqual([A1, A3]);
    expect([...out.keys()]).toEqual([A1, A3]);
  });
});

describe('purchaseOrderItemLines: lines naming accounts in a non-id order', () => {
  it('holds the defaulted accounts with ONE guard query, ids sorted (line order is not lock order)', async () => {
    sqlMock.mockImplementation(async (strings: ReadonlyArray<string>, ...values: unknown[]) => {
      const t = strings.join('?');
      if (t.includes('has_children')) return (values[1] as string[]).map((id) => ({ id, account_code: 'x', account_name: 'n', account_subtype: 'operating_expense', is_active: true, has_children: false }));
      if (t.includes('FROM gl_accounts')) return (values[1] as string[]).map((id) => ({ id, is_active: true }));
      if (t.includes('FROM items')) return [
        { id: '33333333-3333-4333-8333-333333333331', is_active: true, purchases_account_id: A3, sales_account_id: null, vat_on_purchases: null, vat_on_sales: null },
        { id: '33333333-3333-4333-8333-333333333332', is_active: true, purchases_account_id: A1, sales_account_id: null, vat_on_purchases: null, vat_on_sales: null },
        { id: '33333333-3333-4333-8333-333333333333', is_active: true, purchases_account_id: A2, sales_account_id: null, vat_on_purchases: null, vat_on_sales: null },
      ];
      return [];
    });
    const out = await defaultNewPoLines(COMPANY, [
      { itemId: '33333333-3333-4333-8333-333333333331' }, { itemId: '33333333-3333-4333-8333-333333333332' }, { itemId: '33333333-3333-4333-8333-333333333333' },
    ]);
    expect(out.map((l) => l.glAccountId)).toEqual([A3, A1, A2]);
    expect(guardCalls()).toHaveLength(1);
    expect(guardCalls()[0]!.slice(1)).toContainEqual([A1, A2, A3]);
  });
});
