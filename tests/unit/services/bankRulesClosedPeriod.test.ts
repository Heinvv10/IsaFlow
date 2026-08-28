/**
 * Bank-rule auto-post must survive a period closing mid-run.
 *
 * applyRules pre-flights the fiscal period, then creates a draft journal and
 * posts it. The period can close between those two steps (an admin closing the
 * month while a batch runs), so postJournalEntry throws
 * ClosedFiscalPeriodError. The service narrows on that class to hard-delete the
 * draft it just inserted, count the skip, and carry on with the remaining
 * transactions — anything else re-throws.
 *
 * That narrowing was completely unprotected: deleting the whole
 * `if (err instanceof ClosedFiscalPeriodError) { … }` block left the full unit
 * suite green (413 files / 5115 tests). The regression it hides is not
 * cosmetic — the batch 500s instead of continuing, and the draft it created is
 * left orphaned in gl_journal_entries.
 *
 * closedFiscalPeriodErrorContract.test.ts pins that postJournalEntry THROWS the
 * class. That protects the throw, not each consumer's handling of it — the two
 * other consumers (closeRunService, capture post-expense) already have their own
 * tests; this file is the third.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, createMock, postMock, findTxsMock, buildLinesMock, periodStatusMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn() }),
  createMock: vi.fn(),
  postMock: vi.fn(),
  findTxsMock: vi.fn(),
  buildLinesMock: vi.fn(),
  periodStatusMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
  withTransaction: vi.fn(),
  fmtDate: (d: unknown) => String(d),
  // Faithful-enough savepoint: on throw the "transaction" is restored, which
  // the two-candidate lock-timeout test below relies on.
  withSavepoint: vi.fn(async (_name: string, cb: () => unknown) => {
    try { return await cb(); } catch (err) { txAborted = false; throw err; }
  }),
}));
let txAborted = false;
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// The REAL ClosedFiscalPeriodError — the point is the service's instanceof
// against the class production actually throws, so it must not be re-declared.
vi.mock('@/modules/accounting/services/gl/journalEntryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/gl/journalEntryService')>();
  return { ...actual, createJournalEntry: createMock, postJournalEntry: postMock };
});
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccountId: vi.fn(async (k: string) => `acct-${k}`),
}));
vi.mock('@/modules/accounting/services/bank/bankRulesMatchingHelpers', () => ({
  toSqlPattern: vi.fn((_m: string, p: string) => p),
  findMatchingTxs: findTxsMock,
  buildAutoCreateLines: buildLinesMock,
  getPeriodStatusForDate: periodStatusMock,
  // Real value: applyRules slices the candidate list with it, so a mock that
  // omitted it silently produced an empty run.
  MAX_RULE_CANDIDATES: 500,
}));

import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryService';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import { enterFakeRequestCtx } from '../helpers/requestCtx';

// The bank write paths take a row lock (bankTxLock), which refuses to run
// outside a request transaction. These tests mock `sql`, so the ALS client is
// never actually used — it only has to be present.
beforeEach(() => enterFakeRequestCtx());


const COMPANY = '11111111-1111-1111-1111-111111111111';
const BANK_GL = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';

/** The row the auto-apply path locks before it posts for a candidate. */
function lockedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1', status: 'imported', matched_journal_line_id: null,
    amount: -100, transaction_date: '2026-08-13', description: 'BANK FEE',
    ...overrides,
  };
}

/**
 * One active auto-create rule, a valid bank GL account, one matching tx.
 * `lock` is what the row looks like when the service locks it just before
 * posting — `null` means another request got there first.
 */
function withOneAutoPostRule(lock: Record<string, unknown> | null | 'timeout' = lockedRow()) {
  sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
    const text = Array.isArray(strings) ? strings.join('') : String(strings);
    if (text.includes('FROM bank_transactions') && text.includes('FOR UPDATE')) {
      if (lock === 'timeout') {
        // What pg raises when `lock_timeout` elapses; bankTxLock maps it.
        return Promise.reject(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
      }
      return Promise.resolve(lock ? [lock] : []);
    }
    if (text.includes('FROM bank_categorisation_rules')) {
      return Promise.resolve([{
        id: 'rule-1', rule_name: 'Bank charges', priority: 1,
        auto_create_entry: true, alloc_type: 'gl', gl_account_id: 'acct-charges',
        match_type: 'contains', match_pattern: 'FEE', vat_code: 'no_vat',
      }]);
    }
    if (text.includes('FROM gl_accounts')) {
      return Promise.resolve([{ id: BANK_GL }]);
    }
    return Promise.resolve([]);
  }) as never);

  findTxsMock.mockResolvedValue([
    { id: 'tx-1', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', is_deposit: false },
  ]);
  buildLinesMock.mockResolvedValue([
    { glAccountId: 'acct-charges', debit: 100, credit: 0 },
    { glAccountId: BANK_GL, debit: 0, credit: 100 },
  ]);
  periodStatusMock.mockResolvedValue('open'); // pre-flight passes
}

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ id: 'je-draft-1', status: 'draft' });
  postMock.mockResolvedValue({ id: 'je-draft-1', status: 'posted' });
  sqlMock.transaction.mockResolvedValue([]);
});

describe('applyRules — period closes between pre-flight and post', () => {
  it('does NOT throw when postJournalEntry reports a closed period', async () => {
    withOneAutoPostRule();
    postMock.mockRejectedValue(new ClosedFiscalPeriodError('closed'));

    // Without the instanceof narrowing this rejects, 500ing the whole batch and
    // abandoning every transaction after the first.
    await expect(applyRules(COMPANY, BANK_GL, USER)).resolves.toBeDefined();
  });

  it('hard-deletes the draft it just created rather than orphaning it', async () => {
    withOneAutoPostRule();
    postMock.mockRejectedValue(new ClosedFiscalPeriodError('closed'));

    await applyRules(COMPANY, BANK_GL, USER);

    const del = sqlMock.mock.calls.find(c => {
      const text = Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]);
      return text.includes('DELETE FROM gl_journal_entries');
    });
    expect(del, 'the draft must be deleted, not left dangling').toBeDefined();
    const delText = (del![0] as unknown as string[]).join('');
    // Scoped, and only ever a draft — never a posted entry.
    expect(delText).toContain('company_id');
    expect(delText).toContain("status = 'draft'");
  });

  it('skips a candidate that was allocated between the rule query and the lock', async () => {
    // findMatchingTxs read this row as unallocated seconds ago; by the time the
    // lock is taken a UI allocation has committed on it. Posting anyway would
    // put a second journal on one transaction and relink the row to it.
    withOneAutoPostRule(lockedRow({ status: 'allocated', matched_journal_line_id: 'jl-1' }));

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(createMock).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    // Counted, not silently dropped.
    expect(result.autoPostSkippedRaced).toBe(1);
  });

  it('skips a candidate that has been deleted since the rule query', async () => {
    withOneAutoPostRule(null);

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(createMock).not.toHaveBeenCalled();
    expect(result.autoPostSkippedRaced).toBe(1);
  });

  it('counts a lock timeout per candidate instead of aborting the run', async () => {
    // Another request holds this row. Letting the error escape would abort a
    // run that may already have posted for earlier candidates — and withAuth
    // COMMITs whatever the handler wrote before the route's catch 400s.
    withOneAutoPostRule('timeout');

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result.autoPostSkippedLocked).toBe(1);
    expect(result.applied).toBe(0);
  });

  it('a lock timeout on candidate 1 does not poison candidate 2 (savepoint restores the tx)', async () => {
    // A real 55P03 ABORTS the transaction: without the per-line savepoint the
    // next candidate's first statement raises 25P02 and the whole run dies
    // after a single skip. pg semantics are emulated via the txAborted flag.
    txAborted = false;
    let locks = 0;
    sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('') : String(strings);
      if (txAborted) {
        return Promise.reject(Object.assign(new Error('current transaction is aborted'), { code: '25P02' }));
      }
      if (text.includes('FROM bank_transactions') && text.includes('FOR UPDATE')) {
        locks += 1;
        if (locks === 1) {
          txAborted = true; // the 55P03 aborts the tx until a savepoint rollback
          return Promise.reject(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }));
        }
        return Promise.resolve([lockedRow()]);
      }
      if (text.includes('FROM bank_categorisation_rules')) {
        return Promise.resolve([{
          id: 'rule-1', rule_name: 'Bank charges', priority: 1,
          auto_create_entry: true, alloc_type: 'gl', gl_account_id: 'acct-charges',
          match_type: 'contains', match_pattern: 'FEE', vat_code: 'no_vat',
        }]);
      }
      if (text.includes('FROM gl_accounts')) return Promise.resolve([{ id: BANK_GL }]);
      return Promise.resolve([]);
    }) as never);
    findTxsMock.mockResolvedValue([
      { id: 'tx-1', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', is_deposit: false },
      { id: 'tx-2', transaction_date: '2026-08-14', amount: -200, description: 'BANK FEE', is_deposit: false },
    ]);

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result.autoPostSkippedLocked).toBe(1);
    expect(result.applied).toBe(1); // candidate 2 still posts
  });


  it('caps a rule at 500 candidates and says so', async () => {
    withOneAutoPostRule();
    // 501 back from the query = the cap was hit, one row past it is the signal.
    findTxsMock.mockResolvedValue(
      Array.from({ length: 501 }, (_, i) => ({
        id: `tx-${String(i).padStart(4, '0')}`, transaction_date: '2026-08-13',
        amount: -100, description: 'BANK FEE', is_deposit: false,
      })),
    );
    // Every candidate races, so nothing posts — this test is about the cap.
    sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('') : String(strings);
      if (text.includes('FROM bank_categorisation_rules')) {
        return Promise.resolve([{
          id: 'rule-1', rule_name: 'Bank charges', priority: 1,
          auto_create_entry: true, alloc_type: 'gl', gl_account_id: 'acct-charges',
          match_type: 'contains', match_pattern: 'FEE', vat_code: 'no_vat',
        }]);
      }
      if (text.includes('FROM gl_accounts')) return Promise.resolve([{ id: BANK_GL }]);
      return Promise.resolve([]);
    }) as never);

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result.autoPostTruncatedRules).toBe(1);
    // 500 processed, not 501 — the probe row is trimmed, never worked on.
    expect(result.autoPostSkippedRaced).toBe(500);
  });

  it('still PROPAGATES any other posting failure', async () => {
    withOneAutoPostRule();
    postMock.mockRejectedValue(new Error('deadlock detected'));

    // Guards the other half: narrowing must not become a blanket swallow, or a
    // real failure would be silently counted as a skipped period.
    await expect(applyRules(COMPANY, BANK_GL, USER)).rejects.toThrow(/deadlock/);
  });
});
