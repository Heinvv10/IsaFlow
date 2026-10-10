/**
 * Shared setup for the creditNoteService*.test.ts suites: the module mocks, the
 * row fixtures and the sql-mock helpers. Split out of creditNoteService.test.ts to
 * keep each suite under the 300-line limit; imported before anything it mocks.
 */
import { vi, beforeEach, type MockedFunction } from 'vitest';

// R-032 L5: the Login-as guard runs its own query first; it is covered by
// tests/unit/auth/impersonationGuard.test.ts and the r-032 integration suites.
// FX PR0: the currency gate reads the company row; it has its own tests (fx-pr0-*).
vi.mock('@/modules/accounting/services/shared/documentCurrency', async (importOriginal) =>
  (await import('../../helpers/documentCurrencyMock')).documentCurrencyMock(await importOriginal()));
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
}));
// R-035 PR3: the approval gate runs its own queries next; it is covered against
// a real database by tests/integration/r035-pr3-*.int.test.ts.
vi.mock('@/modules/accounting/services/gl/approvalGate', () => ({ assertApprovalCleared: async () => undefined }));
// The pre-write refusals (closed period, inactive account) have their own real-PG suite
// (invoice-line-revenue-credit-notes.int.test.ts); the after-write wrap is pass-through here.
vi.mock('@/modules/accounting/services/ar/creditNotePostingChecks', () => ({
  assertCreditNoteCanPost: async () => undefined,
  lockInvoiceCreditNotes: async () => undefined,
  afterJournalWritten: async (_n: string, step: () => Promise<unknown>) => step(),
}));
vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return { ...actual, sql: sqlMock, withTransaction: vi.fn() };
});
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(),
}));
// D8: the chain head (real-ledger proof: d8-r3-credit-note-bank-chain-head) is the journal itself here.
vi.mock('@/modules/accounting/services/shared/journalChainHead', () => ({ lockStandingChainHead: async (_c: string, id: string) => id }));
// approve/cancel take a FOR UPDATE row lock, which refuses to run outside a
// request transaction. This suite drives the service with a mocked sql tag and
// no ALS context, so the lock is stubbed to return the same row the mock would
// have yielded; the lock's own contract is covered in creditNoteLock.test.ts and
// the real serialisation is proven in tests/integration/api/creditNoteMcpTools.
vi.mock('@/modules/accounting/services/ar/creditNoteLock', () => ({
  lockCreditNoteForUpdate: vi.fn(),
}));
// Same reason, one level down: since the FIFO walk (migration 677) every
// `amount_paid` write runs under the BOUNDED invoice row lock, which also
// refuses outside a request transaction. Passed through here so this suite goes
// on describing the credit-note service; the 5s budget and the typed timeout
// are proved against a real database in
// tests/integration/k011-invoice-lock-review.int.test.ts, and the refusal
// itself in tests/unit/services/shared/creditNoteFifo.test.ts.
vi.mock('@/modules/accounting/services/ar/customerInvoiceLock', () => ({
  withCustomerInvoiceLock: <T>(_fn: string, _s: string, run: () => Promise<T>) => run(),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceLock', () => ({
  withSupplierInvoiceLock: <T>(_fn: string, _s: string, run: () => Promise<T>) => run(),
}));

import { sql } from '@/lib/neon';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { getSystemAccount } from '@/modules/accounting/services/gl/systemAccountResolver';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';

export const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
export const mockCreateJournalEntry = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
export const mockPostJournalEntry = postJournalEntry as unknown as MockedFunction<typeof postJournalEntry>;
export const mockGetSystemAccount = getSystemAccount as unknown as MockedFunction<typeof getSystemAccount>;

export const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
export const CN_ID = '22222222-2222-2222-2222-222222222222';
export const USER_ID = '33333333-3333-3333-3333-333333333333';
export const JE_ID = '44444444-4444-4444-4444-444444444444';

// Tagged-template sql mock calls are (stringsArray, ...interpolatedValues).
// This checks a call's template text + interpolated values without caring
// about exact argument position, so it's robust to unrelated query edits.
export function sqlCallTouches(call: unknown[], textFragment: string, value: unknown): boolean {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  const text = Array.isArray(strings) ? strings.join('') : '';
  return text.includes(textFragment) && values.includes(value);
}

/**
 * Point BOTH the row lock and the sql mock at one note.
 *
 * approve/cancel read the note through lockCreditNoteForUpdate, not through
 * `sql`, so a fixture that only primes mockSql leaves the lock answering with
 * the default row — which is how these tests silently stopped describing the
 * case they were named for.
 */
export function setNote(row: Record<string, unknown>, ...rest: Record<string, unknown>[][]) {
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(row as never);
  if (rest.length === 0) {
    mockSql.mockResolvedValue([row]);
    return;
  }
  // A ROUTER with a queue behind it, not a bare `mockResolvedValueOnce` chain.
  //
  // Approving now issues two statements the caller of this helper does not care
  // about and cannot see — the applied_amount/allocation-rows guard and the
  // candidate read for the FIFO walk. A positional queue makes every fixture
  // depend on how many of those there happen to be, which is how a query added
  // in the service silently shifts what each test asserts. These two are
  // answered by SHAPE and the queue serves only what is left.
  const queue = [...rest];
  mockSql.mockImplementation(((strings: TemplateStringsArray) => {
    const text = (strings as unknown as string[]).join('?');
    if (/SUM\(amount_allocated\)/i.test(text)) return Promise.resolve([{ allocated: 0 }]);
    if (/SELECT ci\.id/i.test(text) || /FOR UPDATE/i.test(text)) return Promise.resolve([]);
    return Promise.resolve(queue.shift() ?? []);
  }) as never);
}

export function creditNoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CN_ID,
    credit_note_number: 'CN-2026-00001',
    type: 'customer',
    client_id: 'client-uuid',
    customer_invoice_id: null,
    supplier_id: null,
    supplier_invoice_id: null,
    credit_date: new Date(2026, 6, 4), // local midnight — mirrors pg's DATE parsing
    reason: 'Damaged goods',
    subtotal: 1000,
    tax_rate: 15,
    tax_amount: 150,
    total_amount: 1150,
    status: 'draft',
    gl_journal_entry_id: null,
    project_id: null,
    created_by: USER_ID,
    approved_by: null,
    approved_at: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  // mockReset, not clearAllMocks: `clear` empties the CALL history but leaves
  // any `mockResolvedValueOnce` queue a previous test left on `sql` intact, and
  // a later test that only sets `mockImplementation` is served that stale queue
  // first. That made "settles the oldest invoice in full" pass alone and fail
  // when this file ran after another that used setNote(...) — order-dependence,
  // not a real difference in behaviour.
  mockSql.mockReset();
  vi.clearAllMocks();
  // The lock returns the standard fixture. It must NOT delegate to mockSql:
  // calling the tagged-template mock with no arguments records a bogus entry in
  // mock.calls, which the INSERT-inspecting assertions below then have to step
  // over, and it silently consumes a mockResolvedValueOnce that belonged to a
  // real query. Tests needing a different note override this directly.
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(creditNoteRow() as never);
  mockGetSystemAccount.mockImplementation(async (key: string) => ({
    id: `${key}-account-id`,
    accountCode: '1000',
    accountName: key,
    accountType: 'asset',
    accountSubtype: 'current',
  }));
  mockCreateJournalEntry.mockResolvedValue({
    id: JE_ID,
    entryNumber: 'JE-2026-00001',
    entryDate: '2026-07-04',
    source: 'auto_credit_note',
    status: 'draft',
    createdBy: USER_ID,
    createdAt: '2026-07-04T00:00:00Z',
    updatedAt: '2026-07-04T00:00:00Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  mockPostJournalEntry.mockResolvedValue(undefined);
});
