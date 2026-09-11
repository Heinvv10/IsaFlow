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
import { getSystemAccountId } from '@/modules/accounting/services/gl/systemAccountResolver';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
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
        // 'pending' is not in the capture_events CHECK vocabulary — the route's
        // postable ALLOW-list refuses it, so use the real post-extraction status.
        event_status: 'extracted',
        captured_document_id: DOC_ID,
        extracted_data: extracted,
      }]);
    }
    // The route CLAIMS the document — a status-predicated UPDATE ... RETURNING
    // id — before its first ledger write, and refuses with a 400 when the
    // statement matches no row. A stub that answered [] to everything therefore
    // made every test here refuse instead of post.
    if (text.includes('UPDATE captured_documents')) return Promise.resolve([{ id: DOC_ID }]);
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
  // The text the auto-post gate re-reads: a purchase title (K-072 round 20),
  // one printed total, a VAT figure.
  rawText: 'Standard Bank\nTAX INVOICE\nSub Total 500.00\nVAT 0.00\nTotal 500.00',
  // Only a structured extraction may post unattended (K-072 round 14).
  extractionMethod: 'vlm',
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

    const eventStatements = sqlMock.mock.calls.filter(c => {
      const text = Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]);
      return text.includes('FROM capture_events');
    });
    // The route reads the event TWICE: the FOR UPDATE lock, then the join that
    // carries the extracted document. Both are the caller's tenant or neither.
    expect(eventStatements.length, 'the route must read capture_events').toBeGreaterThan(0);
    for (const statement of eventStatements) {
      const sqlText = (statement[0] as unknown as string[]).join('');
      expect(sqlText).toContain('company_id');
      expect(statement.slice(1)).toContain(COMPANY_ID);
    }

    const lookup = eventStatements.find(c => {
      const text = (c[0] as unknown as string[]).join('');
      return text.includes('JOIN captured_documents');
    });
    expect(lookup, 'the route must join the captured document').toBeDefined();

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

  it('does not auto-post a credit note, though its figures are the same', async () => {
    // The receipt above auto-posts; only the classification differs. A refund
    // booked here is EXP / VAT-in / bank credit — the direction reversed.
    stubDb({ ...ZERO_VAT, documentType: 'credit_note' });

    await handler(req(), res());

    expect(createMock).toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });
});

describe('capture post-expense — a transient fault is not a configuration answer', () => {
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
      await expect(handler(req(), res())).rejects.toThrow(/connection terminated/);
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
      const result = await handler(req(), res());
      expect(result).toMatchObject({ kind: 'badRequest' });
      expect(createMock).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getSystemAccountId).mockImplementation(original);
    }
  });
});
