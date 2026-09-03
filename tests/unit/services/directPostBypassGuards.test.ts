/**
 * The two paths that posted a journal without going through postJournalEntry.
 *
 * Both did `UPDATE gl_journal_entries SET status = 'posted'` directly, so they
 * skipped every guard that function owns — including the CLOSED FISCAL PERIOD
 * check. A closed period is a set of figures someone has signed off; a later
 * posting into it invalidates that with no trace.
 *
 * They are not the same case, and the fix is not the same:
 *
 *   postCustomerInvoiceToGL — a normal AR posting. Routed through
 *     postJournalEntry so it inherits every guard. Its ONE historical caller
 *     (the Sage migration) opts out via `historicalImport`, because migrating
 *     2022-2024 invoices into their real periods is the entire point and 955
 *     such journals already exist in production.
 *
 *   commitAPInvoice (Sage) — the bypass is deliberate and was documented as
 *     such: "Post JE directly — bypasses workflow helper that blocks backdated
 *     periods." Keeps the direct UPDATE, but gains the inactive-account guard.
 *
 * Both refuse BEFORE any write. That matters more than usual here: the AR
 * route catches every error and answers 400, and withAuth only ROLLBACKs on
 * >= 500 — so a refusal raised after createJournalEntry would COMMIT an orphan
 * draft journal while telling the client the request failed. The guards
 * therefore run before the entry is created, not after.
 *
 * All DB calls are mocked — no real connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: Object.assign((...a: unknown[]) => sqlMock(...a), { unsafe: (s: string) => s }),
  withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const createJournalEntry = vi.fn(async () => ({ id: 'je-1' }));
const postJournalEntry = vi.fn(async () => ({ id: 'je-1', status: 'posted' }));
const getPeriodStatusForDate = vi.fn(async () => 'open');
const assertNoInactiveAccountLines = vi.fn(async () => undefined);

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: (...a: unknown[]) => createJournalEntry(...(a as [])),
  postJournalEntry: (...a: unknown[]) => postJournalEntry(...(a as [])),
  reverseJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: (...a: unknown[]) => createJournalEntry(...(a as [])),
  resolveUserUuid: vi.fn(async (u: string) => u),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  assertNoInactiveAccountLines: (...a: unknown[]) => assertNoInactiveAccountLines(...(a as [])),
}));
vi.mock('@/modules/accounting/services/gl/periodStatusService', () => ({
  getPeriodStatusForDate: (...a: unknown[]) => getPeriodStatusForDate(...(a as [])),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(async (role: string) => ({ id: `acct-${role}` })),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryMeta', () => ({
  defaultHumanMeta: (u: string) => ({ postingAgent: `human:${u}` }),
}));
vi.mock('@/modules/accounting/services/ar/customerPaymentService', () => ({
  getCustomerPaymentById: vi.fn(),
}));

import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const INVOICE = 'bbbbbbbb-0000-0000-0000-000000000001';
const USER = 'cccccccc-0000-0000-0000-000000000001';

const INVOICE_ROW = {
  id: INVOICE, status: 'approved', gl_journal_entry_id: null,
  invoice_number: 'INV-01179', invoice_date: '2023-11-14',
  total_amount: 22549.79, subtotal: 19608.51, tax_amount: 2941.28,
};

function texts(): string[] {
  return sqlMock.mock.calls.map((c) =>
    (c[0] as readonly string[]).join(' ? ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' '),
  );
}

const directPostWrites = () => texts().filter((q) => /UPDATE gl_journal_entries[^?]*status = 'posted'/i.test(q));

beforeEach(() => {
  vi.clearAllMocks();
  createJournalEntry.mockResolvedValue({ id: 'je-1' });
  postJournalEntry.mockResolvedValue({ id: 'je-1', status: 'posted' });
  getPeriodStatusForDate.mockResolvedValue('open');
  assertNoInactiveAccountLines.mockResolvedValue(undefined);
  sqlMock.mockImplementation(async (strings: readonly string[]) => {
    const q = strings.join(' ');
    if (/FROM customer_invoices ci/i.test(q)) return [INVOICE_ROW];
    return [];
  });
});

describe('postCustomerInvoiceToGL routes through postJournalEntry', () => {
  it('posts via postJournalEntry, not a direct status UPDATE', async () => {
    await postCustomerInvoiceToGL(COMPANY, INVOICE, USER);

    expect(postJournalEntry).toHaveBeenCalledWith(COMPANY, 'je-1', USER);
    expect(directPostWrites()).toHaveLength(0);
  });

  it('refuses a closed period BEFORE creating the journal, so nothing partial commits', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');

    await expect(postCustomerInvoiceToGL(COMPANY, INVOICE, USER)).rejects.toThrow(/closed/i);
    // The route answers 400 on any throw and withAuth only ROLLBACKs on >= 500,
    // so a draft entry created before the refusal would be COMMITted.
    expect(createJournalEntry).not.toHaveBeenCalled();
    expect(directPostWrites()).toHaveLength(0);
  });

  it('still links the invoice to the journal on success', async () => {
    await postCustomerInvoiceToGL(COMPANY, INVOICE, USER);

    expect(texts().some((q) => /UPDATE customer_invoices SET gl_journal_entry_id/i.test(q))).toBe(true);
  });
});

describe('historicalImport opt-out — Sage migration only', () => {
  it('allows a closed period, because migrating 2022-2024 invoices is the point', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');

    await expect(
      postCustomerInvoiceToGL(COMPANY, INVOICE, USER, { historicalImport: true }),
    ).resolves.toBe('je-1');
  });

  it('keeps the inactive-account guard even when the period check is waived', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');
    await postCustomerInvoiceToGL(COMPANY, INVOICE, USER, { historicalImport: true });

    expect(assertNoInactiveAccountLines).toHaveBeenCalledWith(COMPANY, 'je-1');
  });

  it('refuses an inactive account even on the historical path, and writes no status', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');
    assertNoInactiveAccountLines.mockRejectedValue(new Error('Cannot post to deactivated GL account: 1121'));

    await expect(
      postCustomerInvoiceToGL(COMPANY, INVOICE, USER, { historicalImport: true }),
    ).rejects.toThrow(/deactivated/i);
    expect(directPostWrites()).toHaveLength(0);
  });

  it('defaults to the guarded path when no option is passed', async () => {
    getPeriodStatusForDate.mockResolvedValue('closed');

    await expect(postCustomerInvoiceToGL(COMPANY, INVOICE, USER)).rejects.toThrow();
  });
});
