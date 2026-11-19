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
import { storedLinesRefusal, type StoredInvoiceLines } from '@/modules/accounting/services/ar/invoiceLineCodingGuard';
import type { StoredVatLine } from '@/modules/accounting/services/ar/invoiceVatLegs';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const A = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const B = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const account = (code: string) => ({ account_code: code, account_name: code, account_type: 'revenue', is_active: true, has_children: false });

const stored = (lines: StoredVatLine[], header: Partial<StoredInvoiceLines> = {}): StoredInvoiceLines =>
  ({ invoiceNumber: 'INV-3', subtotal: 150, taxAmount: 15, customerFnoId: null, lines, ...header });
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
    expect(await approving(stored(lines))).toMatch(/^Invoice INV-3: its lines' net adds up to 165\.00 but its subtotal is 150\.00/);
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

  it('a legacy coded invoice is held to the legacy footing, as before', async () => {
    const lines = [{ amount: 100, glAccountId: A, projectId: null }, { amount: 40, glAccountId: B, projectId: null }];
    expect(await approving(stored(lines))).toMatch(/its lines add up to 140\.00 but its subtotal is 150\.00/);
  });
});
