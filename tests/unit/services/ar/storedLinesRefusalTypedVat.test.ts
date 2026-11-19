/**
 * approve's pre-write refusal (storedLinesRefusal, approving) and lines carrying their VAT type (migration 1008):
 * a partly typed invoice and typed lines that do not foot are refused there, before the status moves. A line's amount
 * is its NET on every invoice (amounts_are says how unit_price reads, never amount), so an inclusive typed invoice
 * whose lines store their net foots, and one storing its gross does not. A legacy coded invoice is refused as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn() }) }));
vi.mock('@/modules/accounting/services/gl/dimensions/dimensionStoredPosting', () => ({
  assertPostsStoredDimensions: vi.fn(async () => undefined),
  isApprovingFrom: () => true,
}));

import { sql } from '@/lib/neon';
import { storedInvoiceLines, storedLinesRefusal, type StoredInvoiceLines } from '@/modules/accounting/services/ar/invoiceLineCodingGuard';
import type { StoredVatLine } from '@/modules/accounting/services/ar/invoiceVatLegs';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const A = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const B = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const account = (code: string) => ({ account_code: code, account_name: code, account_type: 'revenue', is_active: true, has_children: false });

const stored = (lines: StoredVatLine[], header: Partial<StoredInvoiceLines> = {}): StoredInvoiceLines =>
  ({ invoiceNumber: 'INV-3', subtotal: 150, taxAmount: 15, totalAmount: 165, invoiceDate: new Date(2026, 6, 1), amountsAre: null,
    customerFnoId: null, lines, ...header });
const approving = (s: StoredInvoiceLines) => storedLinesRefusal('company', s, { approving: true });

describe('storedLinesRefusal (approving) and typed lines', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([account('4100'), account('4200')]);
  });

  it('takes coded typed lines that store their net and foot to the cent', async () => {
    const lines = [
      { amount: 100, glAccountId: A, projectId: null, vatType: 'standard', taxAmount: 15 },
      { amount: 50, glAccountId: B, projectId: null, vatType: 'exempt', taxAmount: 0 },
    ];
    expect(await approving(stored(lines))).toBeNull();
  });

  it('refuses coded typed lines that store their gross as the amount', async () => {
    const lines = [
      { amount: 115, glAccountId: A, projectId: null, vatType: 'standard', taxAmount: 15 },
      { amount: 50, glAccountId: B, projectId: null, vatType: 'exempt', taxAmount: 0 },
    ];
    expect(await approving(stored(lines))).toMatch(/^Invoice INV-3: line 1 is standard: its VAT on 115\.00 at 15% is 17\.25, but it carries 15\.00/);
  });

  it('refuses typed lines whose net does not foot', async () => {
    const lines = [{ amount: 100, glAccountId: A, projectId: null, vatType: 'standard', taxAmount: 15 },
      { amount: 49.99, glAccountId: B, projectId: null, vatType: 'exempt', taxAmount: 0 }];
    expect(await approving(stored(lines))).toMatch(/^Invoice INV-3: its lines' net adds up to 149\.99 but its subtotal is 150\.00/);
  });

  it('refuses a partly typed invoice', async () => {
    const lines = [{ amount: 100, glAccountId: null, projectId: null, vatType: 'standard', taxAmount: 15 },
      { amount: 50, glAccountId: null, projectId: null }];
    expect(await approving(stored(lines))).toMatch(/^Invoice INV-3: some of its lines carry a VAT type and some do not/);
  });

  // T3: every typed rule is refused HERE, before approve's status UPDATE, with the builder's wording.
  const plain = (amount: number, vatType: string, taxAmount: number) => ({ amount, glAccountId: null, projectId: null, vatType, taxAmount });
  it.each([
    ['VAT not footing to the header', [plain(100, 'standard', 15), plain(50, 'exempt', 0)], { taxAmount: 16, totalAmount: 166 },
      /^Invoice INV-3: its lines' VAT adds up to 15\.00 but its VAT total is 16\.00/],
    ['an unrated line carrying VAT', [plain(100, 'standard', 15), plain(50, 'exempt', 1)], { taxAmount: 16, totalAmount: 166 },
      /^Invoice INV-3: line 2 is exempt, which charges no VAT, but carries 1\.00 of VAT/],
    ['a type the poster may not post', [plain(100, 'standard', 15), plain(50, 'reverse_charge', 0)], {},
      /^Invoice INV-3: line 2 is typed reverse_charge, which a customer invoice line cannot post yet/],
    ['a rated line without its own VAT', [plain(100, 'standard', 0), plain(50, 'exempt', 0)], { taxAmount: 0, totalAmount: 150 },
      /^Invoice INV-3: line 1 is standard: its VAT on 100\.00 at 15% is 15\.00, but it carries 0\.00/],
    ['a total that is not subtotal + VAT', [plain(100, 'standard', 15), plain(50, 'exempt', 0)], { totalAmount: 165.01 },
      /^Invoice INV-3: its total is 165\.01 but its subtotal plus VAT is 165\.00/],
  ] as const)('refuses %s', async (_label, lines, over, message) => {
    expect(await approving(stored([...lines], over))).toMatch(message);
  });

  it('a legacy coded invoice is held to the legacy footing, as before', async () => {
    const lines = [{ amount: 100, glAccountId: A, projectId: null }, { amount: 40, glAccountId: B, projectId: null }];
    expect(await approving(stored(lines))).toMatch(/its lines add up to 140\.00 but its subtotal is 150\.00/);
  });

  it('the stored read carries the header total and the invoice date the typed rules need', async () => {
    const date = new Date(2026, 6, 1);
    mockSql.mockResolvedValueOnce([{ invoice_number: 'INV-3', subtotal: '100.00', tax_amount: '15.00', total_amount: '115.00',
      invoice_date: date, customer_fno_id: null, line_id: 'l1', amount: '100.00', gl_account_id: null, project_id: null,
      cc1_id: null, cc2_id: null, bu_id: null, line_vat_type: 'standard', line_tax_amount: '15.00' }]);
    const read = (await storedInvoiceLines('company', 'inv'))!;
    expect([read.subtotal, read.taxAmount, read.totalAmount, read.invoiceDate, read.amountsAre]).toEqual([100, 15, 115, date, null]);
    expect(String((mockSql.mock.calls[0]![0] as readonly string[]).join('?'))).toMatch(/ci\.total_amount, ci\.invoice_date/);
  });

  // Round 4, item 2: the inclusive flag through its wiring (the stored read; approve's pre-check).
  it('the stored read carries amounts_are', async () => {
    mockSql.mockResolvedValueOnce([{ invoice_number: 'INV-3', subtotal: '100.00', tax_amount: '15.01', total_amount: '115.01',
      invoice_date: '2026-07-01', amounts_are: 'inclusive', customer_fno_id: null, line_id: 'l1', amount: '100.00',
      gl_account_id: null, project_id: null, cc1_id: null, cc2_id: null, bu_id: null, line_vat_type: 'standard', line_tax_amount: '15.01' }]);
    expect((await storedInvoiceLines('company', 'inv'))!.amountsAre).toBe('inclusive');
    expect(String((mockSql.mock.calls[0]![0] as readonly string[]).join('?'))).toMatch(/ci\.amounts_are/);
  });

  it('a 100.00 standard line with VAT 15.01: accepted on an inclusive invoice, refused at the line on an exclusive one', async () => {
    const line = [plain(100, 'standard', 15.01)];
    const header = { subtotal: 100, taxAmount: 15.01, totalAmount: 115.01 };
    expect(await approving(stored([...line], { ...header, amountsAre: 'inclusive' }))).toBeNull();
    expect(await approving(stored([...line], { ...header, amountsAre: null })))
      .toMatch(/^Invoice INV-3: line 1 is standard: its VAT on 100\.00 at 15% is 15\.00, but it carries 15\.01/);
  });
});
