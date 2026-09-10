/**
 * A zero-VAT receipt must still post — proven against the ROUTES, not a copy.
 *
 * buildExpenseJournalFromReceipt emits its VAT leg unconditionally
 * (receiptToJournalService.ts), and validateReceiptExtraction only WARNS on a
 * null vatAmount, not a zero one. So a zero-rated or exempt receipt (bank
 * charges, basic foodstuffs, a foreign supplier) yields a leg of
 * { debit: 0, credit: 0 }. That was harmless while the routes hand-INSERTed
 * their lines; once they went through createJournalEntry it became fatal,
 * because validateJournalLine rejects a line with neither debit nor credit.
 *
 * The first version of this file re-implemented the routes' filter locally and
 * asserted against its own copy. Deleting the filter from BOTH production
 * routes left the entire 5118-test suite green — it protected nothing. These
 * tests import the real handlers and use the REAL builder, mocking only the
 * database and the posting service, so the assertion is on what the route
 * actually hands to createJournalEntry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/als', () => ({
  // The route now takes a FOR UPDATE row lock before its status check, which
  // needs the request transaction's client. These tests mock the database
  // wholesale, so the store is stubbed; the lock's real behaviour is proven
  // against Postgres in tests/integration/k072-capture-double-post.int.test.ts.
  als: { getStore: () => ({ client: { query: vi.fn() } }) },
  assertTxUsable: vi.fn(),
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn((_res: unknown, entity: string) => ({ kind: 'notFound', entity })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
    internalError: vi.fn(() => ({ kind: 'internalError' })),
  },
}));

const { sqlMock, createMock, postMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn() }),
  createMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(sqlMock)),
  fmtDate: (d: unknown) => String(d),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: createMock,
  postJournalEntry: postMock,
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async (key: string) => `acct-${key}`),
}));

// receiptToJournalService is deliberately NOT mocked — the whole point is that
// the REAL builder emits the zero leg the route has to filter.
import handler from '../../../pages/api/accounting/receipt-to-journal';
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const DOC_ID = 'cccccccc-0000-0000-0000-cccccccccccc';

type Line = { glAccountId: string; debit: number; credit: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res = () => ({} as NextApiResponse<any>);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function req(extracted: Record<string, unknown>): any {
  return {
    method: 'POST',
    companyId: COMPANY_ID,
    user: { id: USER_ID },
    body: { documentId: DOC_ID },
    query: {},
    __extracted: extracted,
  };
}

function stubDb(extracted: Record<string, unknown>) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM captured_documents')) {
      return Promise.resolve([{ extracted_data: extracted, status: 'pending' }]);
    }
    // The route CLAIMS the document — a status-predicated UPDATE ... RETURNING
    // id — before its first ledger write, and refuses with a 400 when the
    // statement matches no row. A stub that answered [] to everything therefore
    // made every test here refuse instead of post.
    if (text.includes('UPDATE captured_documents')) return Promise.resolve([{ id: 'doc-1' }]);
    if (text.includes('FROM gl_accounts')) return Promise.resolve([]);
    return Promise.resolve([]);
  }) as never);
}

/** The lines the ROUTE handed to createJournalEntry. */
function linesFromRoute(): Line[] {
  return (createMock.mock.calls[0]![1] as { lines: Line[] }).lines;
}

/**
 * Assert `company_id` is bound in the WHERE clause specifically.
 *
 * An earlier version asserted only that the token appeared somewhere in the SQL
 * and the value somewhere in the bind list. That is not falsifiable: moving
 * `company_id = ${companyId}` from the WHERE into the SET clause keeps both
 * assertions green while the statement re-parents any tenant's row whose UUID
 * the caller holds. Proven by mutation.
 */
function expectScopedToCompany(call: unknown[] | undefined, label: string) {
  expect(call, `${label}: statement not found`).toBeDefined();
  const text = (call![0] as unknown as string[]).join('?');
  const whereIdx = text.toUpperCase().lastIndexOf('WHERE');
  expect(whereIdx, `${label}: no WHERE clause`).toBeGreaterThan(-1);
  const whereClause = text.slice(whereIdx);
  expect(whereClause, `${label}: company_id is not in the WHERE clause`).toContain('company_id');
  expect(call!.slice(1), `${label}: companyId is not bound`).toContain(COMPANY_ID);
}

const ZERO_VAT = {
  totalAmount: 500,
  subtotal: 500,
  vatAmount: 0,
  vatRate: 0,
  date: '2026-08-13',
  vendorName: 'Standard Bank',
  confidence: 0.95,
};

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ id: 'je-1', status: 'draft' });
  postMock.mockResolvedValue({ id: 'je-1', status: 'posted' });
});

describe('receipt-to-journal — zero-VAT receipts', () => {
  it('does not hand createJournalEntry a zero/zero leg', async () => {
    stubDb(ZERO_VAT);

    await handler(req(ZERO_VAT), res());

    expect(createMock).toHaveBeenCalledTimes(1);
    const lines = linesFromRoute();
    // Mutation check for this file: delete the route's `.filter(...)` and this
    // assertion goes red.
    expect(lines.every(l => l.debit !== 0 || l.credit !== 0)).toBe(true);
    expect(lines.find(l => l.glAccountId === 'acct-vat_input')).toBeUndefined();
  });

  it('what the route passes actually validates and balances', async () => {
    stubDb(ZERO_VAT);

    await handler(req(ZERO_VAT), res());

    const result = validateJournalEntry(linesFromRoute());
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(500);
    expect(result.totalCredit).toBe(500);
  });

  it('keeps all three legs for a standard-rated receipt — nothing over-filtered', async () => {
    const standard = { ...ZERO_VAT, totalAmount: 1150, subtotal: 1000, vatAmount: 150, vatRate: 15 };
    stubDb(standard);

    await handler(req(standard), res());

    const lines = linesFromRoute();
    expect(lines).toHaveLength(3);
    expect(lines.find(l => l.glAccountId === 'acct-vat_input')).toMatchObject({ debit: 150 });
    expect(validateJournalEntry(lines).valid).toBe(true);
  });

  // Nothing in the repo tested tenant scoping on this route: removing
  // `AND company_id = ${companyId}` from the captured_documents lookup survived
  // the entire suite. A document id is a UUID an attacker could hold from
  // another tenant, and gl_journal_lines has only a plain FK to gl_accounts(id)
  // with no composite company constraint, so the database would not stop the
  // resulting journal either.
  it('scopes the captured-document lookup to the caller company', async () => {
    stubDb(ZERO_VAT);

    await handler(req(ZERO_VAT), res());

    const docQuery = sqlMock.mock.calls.find(c => {
      const text = Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]);
      return text.includes('FROM captured_documents');
    });
    expect(docQuery, 'the route must read captured_documents').toBeDefined();

    const text = (docQuery![0] as unknown as string[]).join('');
    expect(text).toContain('company_id');
    // The companyId must actually be BOUND, not just mentioned in the SQL.
    expect(docQuery!.slice(1)).toContain(COMPANY_ID);
  });

  it('scopes the captured_documents status update to the caller company', async () => {
    stubDb(ZERO_VAT);

    await handler(req(ZERO_VAT), res());

    const update = sqlMock.mock.calls.find(c => {
      const text = Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]);
      return text.includes('UPDATE captured_documents');
    });
    expectScopedToCompany(update, 'captured_documents stamp');
  });

  it('covers the derived path too, where vatRate 0 makes VAT zero', async () => {
    // subtotal/vatAmount absent → derived from total and vatRate.
    const derived = { ...ZERO_VAT, subtotal: null, vatAmount: null, vatRate: 0 };
    stubDb(derived);

    await handler(req(derived), res());

    expect(linesFromRoute().every(l => l.debit !== 0 || l.credit !== 0)).toBe(true);
    expect(validateJournalEntry(linesFromRoute()).valid).toBe(true);
  });
});

describe('receipt-to-journal — a transient fault is not a configuration answer', () => {
  // L-1's narrowing, which nothing exercised. `getSystemAccountId` runs a real
  // query, so the bare `catch` that used to sit here reported a database fault
  // to the operator as "set it up in Default Accounts" — unlogged, pointing at
  // the wrong remedy, and hiding an outage behind a 400. Only the MISSING ROLE
  // is answered; everything else propagates.
  it('rethrows a database fault raised while resolving the VAT Input role', async () => {
    stubDb(ZERO_VAT);
    const original = vi.mocked(getSystemAccountId).getMockImplementation()!;
    vi.mocked(getSystemAccountId).mockImplementation(async (key: string, companyId: string) => {
      if (key === 'vat_input') throw Object.assign(new Error('connection terminated'), { code: '57P01' });
      return original(key, companyId);
    });
    try {
      await expect(handler(req(ZERO_VAT), res())).rejects.toThrow(/connection terminated/);
      expect(createMock).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getSystemAccountId).mockImplementation(original);
    }
  });

  it('still answers 400 when the role is genuinely unmapped', async () => {
    stubDb(ZERO_VAT);
    const original = vi.mocked(getSystemAccountId).getMockImplementation()!;
    vi.mocked(getSystemAccountId).mockImplementation(async (key: string, companyId: string) => {
      if (key === 'vat_input') throw new MissingSystemAccountError('vat_input', companyId, 'no_claimant', []);
      return original(key, companyId);
    });
    try {
      const result = await handler(req(ZERO_VAT), res());
      expect(result).toMatchObject({ kind: 'badRequest' });
      expect(createMock).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getSystemAccountId).mockImplementation(original);
    }
  });
});
