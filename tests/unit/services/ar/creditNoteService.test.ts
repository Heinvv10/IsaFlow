// RED phase — written before the fix landed.
/**
 * Unit tests for creditNoteService.ts — approveCreditNote date handling.
 *
 * Bug: credit_date comes back from pg as a JS Date object. String(Date)
 * yields e.g. "Fri Jul 04 2026 00:00:00 GMT+0200 (South Africa Standard
 * Time)", which Postgres rejects with `time zone "gmt+0200" not
 * recognized` when inserted into gl_journal_entries.entry_date. That made
 * every credit note approval fail, which in turn blocked apply/cancel/
 * delete (all of which require an approved credit note first).
 *
 * These tests pin entryDate passed to createJournalEntry to 'YYYY-MM-DD'
 * for both Date-typed and string-typed credit_date values.
 *
 * Also covers a follow-up finding from the same investigation:
 * gl_journal_entries.source_document_id has an FK to captured_documents(id)
 * only (migration 409). approveCreditNote used to pass sourceDocumentId: id
 * (the credit note's own id), which would violate that FK on any
 * environment where it's enforced (confirmed VALIDATED in prod) — trading
 * the date crash for a new FK-violation crash. The credit_note <-> journal
 * entry link is instead persisted via credit_notes.gl_journal_entry_id.
 *
 * The Date fixture below is built with `new Date(2026, 6, 4)` (local-time
 * constructor), not `new Date('2026-07-04T00:00:00.000Z')` — node-postgres
 * itself constructs `DATE` column values at LOCAL midnight, so a fixture
 * anchored to UTC midnight would not catch a fix that uses UTC-based
 * slicing (e.g. `toISOString().slice(0, 10)`), which silently rolls the
 * date back a day on any server east of UTC (this one runs UTC+2). Real
 * `fmtDate` is imported via importActual so the test can't drift from the
 * true source of truth by re-implementing it.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

// R-032 L5: the Login-as guard runs its own query first; it is covered by
// tests/unit/auth/impersonationGuard.test.ts and the r-032 integration suites.
vi.mock('@/lib/auth/impersonationGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/impersonationGuard')>()),
  assertNotImpersonating: async () => undefined,
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
import {
  approveCreditNote,
  createCreditNote,
  cancelCreditNote,
  applyCreditNoteToInvoice,
} from '@/modules/accounting/services/ar/creditNoteService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreateJournalEntry = createJournalEntry as unknown as MockedFunction<typeof createJournalEntry>;
const mockPostJournalEntry = postJournalEntry as unknown as MockedFunction<typeof postJournalEntry>;
const mockGetSystemAccount = getSystemAccount as unknown as MockedFunction<typeof getSystemAccount>;

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const CN_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const JE_ID = '44444444-4444-4444-4444-444444444444';

// Tagged-template sql mock calls are (stringsArray, ...interpolatedValues).
// This checks a call's template text + interpolated values without caring
// about exact argument position, so it's robust to unrelated query edits.
function sqlCallTouches(call: unknown[], textFragment: string, value: unknown): boolean {
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
function setNote(row: Record<string, unknown>, ...rest: Record<string, unknown>[][]) {
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

function creditNoteRow(overrides: Record<string, unknown> = {}) {
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

describe('approveCreditNote — credit_date normalization', () => {
  it('formats a Date-typed credit_date as YYYY-MM-DD before creating the journal entry', async () => {
    setNote(creditNoteRow(), [creditNoteRow({ status: 'approved' })]);

    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1);
    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.entryDate).toBe('2026-07-04');
  });

  it('formats a string-typed (ISO timestamp) credit_date as YYYY-MM-DD', async () => {
    setNote(creditNoteRow({ credit_date: '2026-07-04T00:00:00.000Z' }), [creditNoteRow({ status: 'approved' })]);

    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.entryDate).toBe('2026-07-04');
  });

  it('passes through a plain YYYY-MM-DD string credit_date unchanged', async () => {
    setNote(creditNoteRow({ credit_date: '2026-07-04' }), [creditNoteRow({ status: 'approved' })]);

    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.entryDate).toBe('2026-07-04');
  });
});

describe('approveCreditNote — no sourceDocumentId, linked via gl_journal_entry_id', () => {
  it('does not pass sourceDocumentId to createJournalEntry (would violate fk_gl_je_source_document)', async () => {
    setNote(creditNoteRow(), [creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);

    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    const [, journalInput] = mockCreateJournalEntry.mock.calls[0]!;
    expect(journalInput.sourceDocumentId).toBeUndefined();
  });

  it('persists gl_journal_entry_id on the credit note when approving', async () => {
    setNote(creditNoteRow(), [creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID })]);

    const result = await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);

    expect(result.glJournalEntryId).toBe(JE_ID);
    // Found by CONTENT, not by index: the note is now read through the row lock
    // rather than through `sql`, so a positional lookup silently shifted when
    // that landed and this assertion started reading an undefined call.
    const updateCall = mockSql.mock.calls.find((c) =>
      sqlCallTouches(c as unknown[], 'gl_journal_entry_id', JE_ID),
    );
    expect(updateCall, 'no UPDATE wrote gl_journal_entry_id').toBeDefined();
  });
});


/**
 * credit_notes.supplier_id is a UUID column referencing suppliers(id)
 * (migration 202) — it has never been an integer. createCreditNote used to
 * interpolate `Number(input.supplierId)`, which turns every real supplier UUID
 * into NaN; Postgres then rejects the INSERT with `invalid input syntax for
 * type uuid: "NaN"`. So a supplier credit note raised against an actual
 * supplier threw, and the only supplier rows that ever reached the table were
 * seeded ones carrying supplier_id NULL — orphaned from any supplier, and
 * therefore invisible to every per-supplier statement and ageing view.
 *
 * Pinned as an interpolated VALUE, not a rendered string: the assertion fails
 * the moment the Number() coercion comes back, because NaN !== the UUID.
 */
describe('createCreditNote — supplier_id is a UUID, never coerced to a number', () => {
  const SUPPLIER_ID = '55555555-5555-4555-8555-555555555555';

  it('interpolates the supplier UUID unchanged into the INSERT', async () => {
    mockSql.mockResolvedValue([
      creditNoteRow({ type: 'supplier', client_id: null, supplier_id: SUPPLIER_ID }),
    ]);

    const note = await createCreditNote(
      COMPANY_ID,
      { type: 'supplier', supplierId: SUPPLIER_ID, creditDate: '2026-07-04', subtotal: 1000 },
      USER_ID,
    );

    const insert = mockSql.mock.calls.find((c) =>
      sqlCallTouches(c as unknown[], 'INSERT INTO credit_notes', SUPPLIER_ID),
    );
    expect(insert).toBeDefined();

    // Nothing NaN-shaped reached the driver.
    const values = (insert as unknown[]).slice(1);
    expect(values.some((v) => typeof v === 'number' && Number.isNaN(v))).toBe(false);
    expect(note.supplierId).toBe(SUPPLIER_ID);
  });

  it('still writes NULL when no supplier is supplied', async () => {
    mockSql.mockResolvedValue([creditNoteRow()]);
    await createCreditNote(
      COMPANY_ID,
      { type: 'customer', clientId: 'client-uuid', creditDate: '2026-07-04', subtotal: 1000 },
      USER_ID,
    );
    const insert = mockSql.mock.calls.find((c) => {
      const [strings] = c as [readonly string[], ...unknown[]];
      return Array.isArray(strings) && strings.join('').includes('INSERT INTO credit_notes');
    });
    expect((insert as unknown[]).slice(1)).toContain(null);
  });
});

/**
 * The reversing entry approve/cancel raise is a ledger write of its own. If the
 * postingAgent stamp is dropped on the way through, createJournalEntry falls
 * back to defaultHumanMeta(userId) and MCP work posts labelled `human:<userId>`
 * — affirmatively claiming the token owner did it by hand, and invisible to
 * list_agent_postings, which filters posting_agent LIKE 'mcp:%'. That review
 * surface is the control the whole agent-write model rests on.
 */
describe('postingAgent attribution reaches the GL services', () => {
  it('approveCreditNote forwards the stamp to createJournalEntry', async () => {
    setNote(creditNoteRow());
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID, { postingAgent: 'mcp:approve_credit_note:v1' });
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      COMPANY_ID, expect.anything(), USER_ID,
      { postingAgent: 'mcp:approve_credit_note:v1' },
    );
  });

  it('approveCreditNote leaves meta undefined when no stamp is given, keeping human attribution', async () => {
    setNote(creditNoteRow());
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      COMPANY_ID, expect.anything(), USER_ID, undefined,
    );
  });

  it('cancelCreditNote forwards the stamp to reverseJournalEntry', async () => {
    setNote(creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID }));
    await cancelCreditNote(COMPANY_ID, CN_ID, USER_ID, 'duplicate', {
      postingAgent: 'mcp:cancel_credit_note:v1',
    });
    expect(vi.mocked(reverseJournalEntry)).toHaveBeenCalledWith(
      COMPANY_ID, JE_ID, USER_ID,
      { postingAgent: 'mcp:cancel_credit_note:v1' },
    );
  });
});


/**
 * Finding 22 from review: every proof that approve/cancel actually TAKE the row
 * lock lived in the integration suite, which `bun run ci` does not run without
 * DATABASE_URL. Deleting the lock call from the service left CI green. These
 * two run in the unit suite, so the wiring itself is gated.
 */
describe('approve and cancel go through the row lock', () => {
  it('approveCreditNote reads the note via lockCreditNoteForUpdate, not a plain SELECT', async () => {
    setNote(creditNoteRow());
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(lockCreditNoteForUpdate).toHaveBeenCalledWith(COMPANY_ID, CN_ID);
  });

  it('cancelCreditNote reads the note via lockCreditNoteForUpdate', async () => {
    setNote(creditNoteRow({ status: 'approved', gl_journal_entry_id: JE_ID }));
    await cancelCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(lockCreditNoteForUpdate).toHaveBeenCalledWith(COMPANY_ID, CN_ID);
  });
});

/**
 * The auto-apply used to add the note's full total with no cap and set
 * autoApplied = true without inspecting the row count.
 */
describe('approveCreditNote — auto-apply is capped and verified', () => {
  const INV = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

  function linkedNote() {
    return creditNoteRow({ customer_invoice_id: INV, total_amount: 1150 });
  }

  /** Answers the guard, the locked invoice read, and the two UPDATEs. */
  function wire(invoice: { total_amount: string; amount_paid: string } | null) {
    const applied: number[] = [];
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(linkedNote() as never);
    mockSql.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SUM\(amount_allocated\)/i.test(text)) {
        return Promise.resolve([{ allocated: 0 }]);
      }
      // The lock read is where the outstanding balance now comes from, so the
      // cap these tests describe is computed from its figures.
      if (/FOR UPDATE/i.test(text)) {
        if (!invoice) return Promise.resolve([]);
        const outstanding = Number(invoice.total_amount) - Number(invoice.amount_paid);
        return Promise.resolve([{ id: INV, status: 'approved', outstanding }]);
      }
      if (/SELECT ci\.id/i.test(text)) {
        return Promise.resolve([]);
      }
      if (/UPDATE customer_invoices SET amount_paid = COALESCE\(amount_paid, 0\) \+/i.test(text)) {
        applied.push(Number(values[0]));
        return Promise.resolve([{ id: INV }]);
      }
      if (/UPDATE credit_notes SET status/i.test(text)) {
        return Promise.resolve([linkedNote()]);
      }
      return Promise.resolve([]);
    }) as never);
    return applied;
  }

  it('caps the applied amount at the invoice outstanding balance', async () => {
    // Invoice owes 150; the note is worth 1150. Only 150 may be consumed.
    const applied = wire({ total_amount: '1150.00', amount_paid: '1000.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([150]);
  });

  it('applies the full total when the invoice owes more than the note', async () => {
    const applied = wire({ total_amount: '5000.00', amount_paid: '0.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([1150]);
  });

  it('applies nothing to an already-settled invoice, leaving the credit unallocated', async () => {
    const applied = wire({ total_amount: '1150.00', amount_paid: '1150.00' });
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(applied).toEqual([]);
  });

  it('refuses when the linked invoice no longer exists rather than reporting a phantom apply', async () => {
    wire(null);
    await expect(approveCreditNote(COMPANY_ID, CN_ID, USER_ID))
      .rejects.toThrow(/no longer exists in this company/);
  });
});

/**
 * FIFO APPLICATION (L2, migration 677).
 *
 * Approving a note no longer stops at the document it names. The remainder
 * walks the same customer's open invoices oldest first, and every application
 * writes a `credit_note_allocations` row — the invariant these tests pin is
 * that the rows and the money always move together, because `applied_amount`
 * is now the sum of the rows rather than a figure written beside them.
 */
describe('approveCreditNote — FIFO application across open documents', () => {
  const INV_OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
  const INV_NEW = 'aaaaaaaa-0000-4000-8000-000000000002';

  interface Wired {
    /** [invoiceId, amount] per allocation row inserted. */
    rows: [string, number][];
    /** [invoiceId, amount] per amount_paid increment. */
    money: [string, number][];
    /** The status the note was finally written with. */
    status: () => string | undefined;
    appliedAmount: () => number | undefined;
  }

  function wireOpen(open: { id: string; outstanding: number }[]): Wired {
    const rows: [string, number][] = [];
    const money: [string, number][] = [];
    let status: string | undefined;
    let appliedAmount: number | undefined;
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(
      creditNoteRow({ total_amount: 1150 }) as never,
    );
    mockSql.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SUM\(amount_allocated\)/i.test(text)) {
        return Promise.resolve([{ allocated: 0 }]);
      }
      // The locked re-read: the plan consumes THESE figures, not the candidate
      // query's. Both are served from the same fixture here.
      if (/FOR UPDATE/i.test(text)) {
        const wanted = new Set((values[0] as string[]) ?? []);
        return Promise.resolve(open
          .filter((o) => wanted.has(o.id))
          .map((o) => ({ id: o.id, status: 'approved', outstanding: o.outstanding })));
      }
      if (/SELECT ci\.id/i.test(text)) {
        return Promise.resolve(open.map((o) => ({ id: o.id, outstanding: o.outstanding })));
      }
      if (/INSERT INTO credit_note_allocations/i.test(text)) {
        rows.push([String(values[2]), Number(values[3])]);
        return Promise.resolve([]);
      }
      if (/UPDATE customer_invoices SET amount_paid = COALESCE\(amount_paid, 0\) \+/i.test(text)) {
        money.push([String(values[1]), Number(values[0])]);
        return Promise.resolve([{ id: values[1] }]);
      }
      if (/UPDATE credit_notes SET status/i.test(text)) {
        status = String(values[0]);
        appliedAmount = Number(values[3]);
        return Promise.resolve([creditNoteRow({ status })]);
      }
      return Promise.resolve([]);
    }) as never);
    return { rows, money, status: () => status, appliedAmount: () => appliedAmount };
  }

  it('settles the oldest invoice in full and part-settles the next', async () => {
    const w = wireOpen([
      { id: INV_OLD, outstanding: 400 },
      { id: INV_NEW, outstanding: 5000 },
    ]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(w.money).toEqual([[INV_OLD, 400], [INV_NEW, 750]]);
    expect(w.status()).toBe('applied');
    expect(w.appliedAmount()).toBe(1150);
  });

  it('writes one allocation row per application, for exactly the money moved', async () => {
    const w = wireOpen([
      { id: INV_OLD, outstanding: 400 },
      { id: INV_NEW, outstanding: 5000 },
    ]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(w.rows).toEqual(w.money);
    // …and the column is the sum of the rows, never an independent figure.
    expect(w.appliedAmount()).toBe(w.rows.reduce((s, [, a]) => s + a, 0));
  });

  it('leaves the excess on account as partially_applied when nothing more is open', async () => {
    const w = wireOpen([{ id: INV_OLD, outstanding: 400 }]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID);
    expect(w.money).toEqual([[INV_OLD, 400]]);
    expect(w.status()).toBe('partially_applied');
    expect(w.appliedAmount()).toBe(400);
  });

  it('applies nothing and stays approved when auto_apply is "none"', async () => {
    const w = wireOpen([{ id: INV_OLD, outstanding: 5000 }]);
    await approveCreditNote(COMPANY_ID, CN_ID, USER_ID, { autoApply: 'none' });
    expect(w.money).toEqual([]);
    expect(w.rows).toEqual([]);
    expect(w.status()).toBe('approved');
    expect(w.appliedAmount()).toBe(0);
  });
});

/**
 * The two refusals the MANUAL apply gained.
 *
 * Both are about not extending something that cannot be undone correctly. The
 * status guard stops a credit landing on a document that has posted nothing;
 * the allocation guard stops a note whose column and rows already disagree from
 * being given another row, which would strand the original credit on an invoice
 * nothing names.
 */
describe('applyCreditNoteToInvoice — what it refuses before it writes', () => {
  const INVOICE = 'cccccccc-0000-4000-8000-cccccccccccc';
  const CLIENT = 'client-uuid';

  function wireApply(invoice: Record<string, unknown>, allocated: number) {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(
      creditNoteRow({ status: 'approved', applied_amount: 300 }) as never,
    );
    mockSql.mockImplementation(((strings: TemplateStringsArray) => {
      const text = (strings as unknown as string[]).join('?');
      if (/SUM\(amount_allocated\)/i.test(text)) return Promise.resolve([{ allocated }]);
      if (/SELECT \* FROM customer_invoices/i.test(text)) return Promise.resolve([invoice]);
      return Promise.resolve([creditNoteRow({ status: 'applied' })]);
    }) as never);
  }

  const openInvoice = (status: string) => ({
    id: INVOICE, client_id: CLIENT, customer_id: CLIENT,
    total_amount: '1000.00', amount_paid: '0.00', status,
  });

  it('refuses an invoice that has posted nothing', async () => {
    wireApply(openInvoice('draft'), 300);
    await expect(applyCreditNoteToInvoice(COMPANY_ID, CN_ID, INVOICE, USER_ID))
      .rejects.toThrow(/status: draft/);
  });

  it('refuses a cancelled invoice for the same reason', async () => {
    wireApply(openInvoice('cancelled'), 300);
    await expect(applyCreditNoteToInvoice(COMPANY_ID, CN_ID, INVOICE, USER_ID))
      .rejects.toThrow(/status: cancelled/);
  });

  it('refuses a note whose applied_amount the allocation rows do not account for', async () => {
    // applied_amount 300, rows totalling 120 — the other 180 went somewhere no
    // row names, and a cancel would never give it back.
    wireApply(openInvoice('sent'), 120);
    await expect(applyCreditNoteToInvoice(COMPANY_ID, CN_ID, INVOICE, USER_ID))
      .rejects.toThrow(/Reconcile the note by hand/);
  });

  it('applies when the status is live and the rows account for the column', async () => {
    wireApply(openInvoice('sent'), 300);
    const out = await applyCreditNoteToInvoice(COMPANY_ID, CN_ID, INVOICE, USER_ID);
    expect(out.status).toBe('applied');
  });
});
