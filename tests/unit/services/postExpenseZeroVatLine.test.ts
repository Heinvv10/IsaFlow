/**
 * capture/[id]/post-expense — the sibling of receipt-to-journal, same guards.
 *
 * Both routes build their journal with buildExpenseJournalFromReceipt, which
 * emits its VAT leg unconditionally, and both filter zero-value legs before
 * calling createJournalEntry (validateJournalLine rejects a line with neither
 * debit nor credit, so a zero-rated receipt would otherwise 500).
 *
 * receiptZeroVatLine.test.ts covers the other route. This file exists because
 * that coverage did NOT extend here: deleting this route's filter left the whole
 * suite green, which is the same shadow-test gap the first version of that file
 * had — just one file over.
 *
 * It also pins the postJournalEntry argument order. The call read
 * `postJournalEntry(jeEntry.id, userId, companyId)` against a signature of
 * `(companyId, id, userId)`, so the lookup matched nothing and threw; the catch
 * swallowed it and the entry silently stayed a draft. Auto-post on this path
 * had never once worked.
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
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    notFound: vi.fn((_res: unknown, entity: string) => ({ kind: 'notFound', entity })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
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
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: createMock,
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: postMock,
  // The route narrows on `err instanceof ClosedFiscalPeriodError` to decide
  // whether to swallow (leave the journal a draft) or rethrow. Omitting the
  // class from this mock leaves it `undefined` in the module under test, so any
  // test that drove postMock to reject would die on
  // "Right-hand side of 'instanceof' is not callable" — testing the mock's
  // shape instead of the route's behaviour.
  ClosedFiscalPeriodError: class ClosedFiscalPeriodError extends Error {},
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async (key: string) => `acct-${key}`),
}));
vi.mock('@/modules/accounting/services/expense/expenseClaimService', () => ({
  createClaim: vi.fn(),
  submitClaim: vi.fn(),
}));

// receiptToJournalService stays REAL — the point is that the genuine builder
// emits the zero leg this route must filter.
import handler from '../../../pages/api/accounting/capture/[id]/post-expense';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { validateJournalEntry } from '@/modules/accounting/utils/doubleEntry';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb';
const EVENT_ID = 'dddddddd-0000-0000-0000-dddddddddddd';
const DOC_ID = 'cccccccc-0000-0000-0000-cccccccccccc';

type Line = { glAccountId: string; debit: number; credit: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const res = () => ({} as NextApiResponse<any>);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (): any => ({
  method: 'POST',
  companyId: COMPANY_ID,
  user: { id: USER_ID },
  query: { id: EVENT_ID },
  body: {}, // no employeeId → the anonymous direct-GL path
});

function stubDb(extracted: Record<string, unknown>) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM capture_events')) {
      return Promise.resolve([{
        event_id: EVENT_ID,
        event_status: 'pending',
        captured_document_id: DOC_ID,
        extracted_data: extracted,
      }]);
    }
    if (text.includes('FROM gl_accounts')) return Promise.resolve([]);
    return Promise.resolve([]);
  }) as never);
}

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
  createMock.mockResolvedValue({ id: 'je-pe-1', status: 'draft' });
  postMock.mockResolvedValue({ id: 'je-pe-1', status: 'posted' });
});

describe('capture post-expense — zero-VAT receipts', () => {
  it('does not hand createJournalEntry a zero/zero leg', async () => {
    stubDb(ZERO_VAT);

    await handler(req(), res());

    expect(createMock).toHaveBeenCalledTimes(1);
    // Mutation check: delete this route's `.filter(...)` and this goes red.
    expect(linesFromRoute().every(l => l.debit !== 0 || l.credit !== 0)).toBe(true);
    expect(linesFromRoute().find(l => l.glAccountId === 'acct-vat_input')).toBeUndefined();
  });

  it('what the route passes validates and balances', async () => {
    stubDb(ZERO_VAT);

    await handler(req(), res());

    const result = validateJournalEntry(linesFromRoute());
    expect(result.valid).toBe(true);
    expect(result.totalDebit).toBe(500);
    expect(result.totalCredit).toBe(500);
  });

  it('keeps all three legs for a standard-rated receipt', async () => {
    stubDb({ ...ZERO_VAT, totalAmount: 1150, subtotal: 1000, vatAmount: 150, vatRate: 15 });

    await handler(req(), res());

    expect(linesFromRoute()).toHaveLength(3);
    expect(validateJournalEntry(linesFromRoute()).valid).toBe(true);
  });

  // Same untested hole as receipt-to-journal: removing the company_id predicates
  // from the capture_events / captured_documents lookup survived the whole
  // suite. The event id is a UUID another tenant could hold.
  it('scopes the capture-event lookup to the caller company', async () => {
    stubDb(ZERO_VAT);

    await handler(req(), res());

    const lookup = sqlMock.mock.calls.find(c => {
      const text = Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]);
      return text.includes('FROM capture_events');
    });
    expect(lookup, 'the route must read capture_events').toBeDefined();

    const text = (lookup![0] as unknown as string[]).join('');
    // Both sides of the join are scoped — the document is reachable through the
    // event, so scoping only one of them still crosses tenants.
    expect(text).toContain('ce.company_id');
    expect(text).toContain('cd.company_id');
    expect(lookup!.slice(1)).toContain(COMPANY_ID);
  });

  it('scopes the capture_events stamp to the caller company', async () => {
    stubDb(ZERO_VAT);

    await handler(req(), res());

    const stamp = sqlMock.mock.calls.find(c => {
      const text = Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]);
      return text.includes('UPDATE capture_events');
    });
    expectScopedToCompany(stamp, 'capture_events stamp');
  });

  it('leaves the journal a draft when the period is closed, and still responds', async () => {
    stubDb(ZERO_VAT);
    postMock.mockRejectedValue(new ClosedFiscalPeriodError('Cannot post to closed fiscal period'));

    const result = await handler(req(), res());

    // A closed period is a legitimate outcome — same end state as autoPost being
    // false — so it is swallowed and the draft survives for later posting.
    expect(result).toMatchObject({ kind: 'success' });
    expect((result as { data: { journalEntry: { status: string } } }).data.journalEntry.status).toBe('draft');
  });

  it('RETHROWS any other posting failure rather than stamping over it', async () => {
    stubDb(ZERO_VAT);
    // A Postgres error here aborts the request transaction; continuing would run
    // the capture stamps against a dead transaction and answer 200 for writes
    // that can never commit.
    postMock.mockRejectedValue(Object.assign(new Error('deadlock detected'), { code: '40P01' }));

    await expect(handler(req(), res())).rejects.toThrow(/deadlock/);
  });

  it('auto-posts with the arguments in the order postJournalEntry declares', async () => {
    stubDb(ZERO_VAT); // R500, confidence 0.95 → under R5 000 and above 0.80

    await handler(req(), res());

    // (companyId, id, userId). The call used to be (id, userId, companyId), so
    // it looked up `WHERE id = <userId> AND company_id = <jeId>`, threw, and was
    // swallowed — auto-post never actually posted.
    expect(postMock).toHaveBeenCalledWith(COMPANY_ID, 'je-pe-1', USER_ID);
  });
});
