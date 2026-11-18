/**
 * A zero-amount bank line (e.g. "PROOF OF PMT EMAIL R0.00") matched by an auto-create rule has nothing to post: every
 * journal line is 0/0, createJournalEntry refuses ("A line must have a non-zero debit or credit amount") and the whole
 * sweep 500s, so the rule cannot even be saved. The sweep must skip such a candidate and carry on.
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
    id: 'tx-1', status: 'imported', feed_state: 'posted', matched_journal_line_id: null,
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
        match_type: 'contains', match_pattern: 'FEE', vat_code: 'none',
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
  createMock.mockResolvedValue({ id: 'je-draft-1', status: 'draft' });

beforeEach(() => {
  vi.clearAllMocks();
  createMock.mockResolvedValue({ id: 'je-draft-1', status: 'draft' });
  postMock.mockResolvedValue({ id: 'je-draft-1', status: 'posted' });
  sqlMock.transaction.mockResolvedValue([]);
});

describe('applyRules — zero-amount candidate', () => {
  it('skips a 0.00 line without creating a journal or throwing', async () => {
    withOneAutoPostRule(lockedRow({ id: 'tx-0', amount: 0 }));
    findTxsMock.mockResolvedValue([
      { id: 'tx-0', transaction_date: '2026-08-13', amount: 0, description: 'PROOF OF PMT EMAIL', is_deposit: false },
    ]);
    // What buildAutoCreateLines really returns for a zero total: the refused all-zero lines.
    buildLinesMock.mockResolvedValue([
      { glAccountId: 'acct-charges', debit: 0, credit: 0 }, { glAccountId: BANK_GL, debit: 0, credit: 0 },
    ]);
    createMock.mockRejectedValue(new Error('Invalid journal entry: Line 1: A line must have a non-zero debit or credit amount'));

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(createMock).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
  });
});
