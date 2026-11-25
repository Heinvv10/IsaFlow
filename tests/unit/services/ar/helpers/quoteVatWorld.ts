/**
 * The scripted database behind the quote VAT service suites (quoteServiceVat*.test.ts): each file vi.mocks the modules
 * (vi.mock is hoisted per file) and uses this for the world the mocked `sql` answers from and the readers of what it
 * was sent. The mocked `sql` is the one the test file's vi.mock installs.
 */
import { vi, type MockedFunction } from 'vitest';
import { sql } from '@/lib/neon';
import { createQuote } from '@/modules/accounting/services/ar/quoteService';

export const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
export const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
export const QUOTE_ID = '22222222-2222-2222-2222-222222222222';
export const CLIENT_ID = '33333333-3333-3333-3333-333333333333';
export const ITEM_ID = '44444444-4444-4444-4444-444444444444';
export const ITEM_B = '55555555-5555-5555-5555-555555555555';

const text = (call: unknown[]) => (call[0] as readonly string[]).join('?');
const header = { id: QUOTE_ID, quote_number: 'QUO1', client_id: null, customer_name: 'Acme', quote_date: '2026-11-11', expiry_date: null,
  status: 'draft', subtotal: '0', tax_amount: '0', total: '0', notes: null, terms: null, converted_invoice_id: null, created_at: '', updated_at: '' };

export interface World {
  vatPeriod: string; customerVat: string | null; itemVat: string | null; stored: Record<string, unknown>[]; head: Record<string, unknown>;
  /** The catalogue items' sales accounts (ITEM_ID, ITEM_B; active accounts of the company), null for none. */
  itemAccount: string | null;
  itemBAccount: string | null;
  /** Items deactivated, items of ANOTHER company, accounts deactivated: the stubs answer as the scoped queries would. */
  inactiveItems: Set<string>; foreignItems: Set<string>; inactiveAccounts: Set<string>;
}
const fresh = (): World => ({
  vatPeriod: 'bi-monthly', customerVat: null, itemVat: null, stored: [], head: {}, itemAccount: null, itemBAccount: null,
  inactiveItems: new Set(), foreignItems: new Set(), inactiveAccounts: new Set(),
});
export const world: World = fresh();
const OTHER_COMPANY = '99999999-9999-9999-9999-999999999999';
/** The ids a scoped stub query names (its `id = ANY(...)` array), lower-cased. */
const idsOf = (call: unknown[]): string[] => ((call.slice(1).find(Array.isArray) as unknown[] | undefined) ?? []).map((v) => String(v).toLowerCase());
/** The company a scoped stub query names (its first bound value). */
const companyOf = (call: unknown[]): string => String(call[1]);

/** Fresh mocks and a registered company with no stored quote; call in beforeEach. */
export function resetWorld(): void {
  vi.clearAllMocks();
  mockSql.mockReset();
  Object.assign(world, fresh());
  mockSql.mockImplementation(async (...call: unknown[]) => {
    const t = text(call);
    if (t.includes('FROM companies')) return [{ vat_period: world.vatPeriod, vat_system_type: null, customer_vat: world.customerVat }];
    if (t.includes('FROM items')) {
      // Scoped as the real query is: this company's items, of the ids asked for.
      return [{ id: ITEM_ID, sales_account_id: world.itemAccount }, { id: ITEM_B, sales_account_id: world.itemBAccount }]
        .filter((r) => idsOf(call).includes(r.id) && companyOf(call) === (world.foreignItems.has(r.id) ? OTHER_COMPANY : COMPANY_ID))
        .map((r) => ({ ...r, is_active: !world.inactiveItems.has(r.id), purchases_account_id: null, vat_on_sales: world.itemVat, vat_on_purchases: null }));
    }
    if (t.includes('FROM gl_accounts')) {
      return [world.itemAccount, world.itemBAccount].flatMap((a) => (a && idsOf(call).includes(a.toLowerCase()) && companyOf(call) === COMPANY_ID
        ? [{ id: a, is_active: !world.inactiveAccounts.has(a) }] : []));
    }
    if (t.includes('INSERT INTO customer_quotes')) return [{ id: QUOTE_ID }];
    if (t.includes('FROM customer_quote_lines')) return world.stored;
    if (t.includes('FROM customer_quotes')) return [{ ...header, ...world.head }];
    return [];
  });
}

/** The bound values of an INSERT, by its column list (each VALUES slot is one bound value, in order). */
export function inserted(table: string): Record<string, unknown>[] {
  return mockSql.mock.calls.filter((c) => new RegExp(`INSERT INTO ${table}\\s*\\(`).test(text(c))).map((c) => {
    const cols = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)`).exec(text(c))![1]!.split(',').map((s) => s.trim());
    return Object.fromEntries(cols.map((col, i) => [col, c[i + 1]]));
  });
}
export const updatedHeader = () => {
  const c = mockSql.mock.calls.find((call) => text(call).includes('UPDATE customer_quotes SET'))!;
  const parts = (c[0] as readonly string[]);
  return Object.fromEntries(parts.slice(0, -1).map((p, i) => [/(\w+)\s*=\s*$/.exec(p)?.[1] ?? `?${i}`, c[i + 1]]));
};
export const lineVat = (rows: Record<string, unknown>[]) => rows.map((l) => ({ vat: l.vat_type, tax: l.tax_amount, rate: l.tax_rate, amount: l.amount }));
export const head = () => { const h = inserted('customer_quotes')[0]!; return { subtotal: h.subtotal, tax: h.tax_amount, total: h.total, rate: h.tax_rate, mode: h.amounts_are }; };
export const wrote = () => mockSql.mock.calls.some((c) => /INSERT|UPDATE|DELETE/.test(text(c)));

export type Line = { description: string; quantity: number; unitPrice: number; taxRate?: unknown; vatType?: unknown; itemId?: string };
export const create = (lines: Line[], extra: Record<string, unknown> = {}) =>
  createQuote(COMPANY_ID, { customerName: 'Acme', quoteDate: '2026-11-11', lines, ...extra } as never, 'u1');
