/**
 * Bank-rule auto-post: the concurrency outcomes — a raced row, a lock timeout,
 * the savepoint that keeps one timeout from poisoning the next line, and the
 * candidate and attempt caps. The refusal outcomes are in
 * bankRulesAutoPostOutcomes.test.ts, on the same harness.
 *
 * The line posts through `allocateTransaction` — the controlled bank
 * allocation — so the kernel's own approval refusal
 * (`OperationApprovalRequiredError`, the REAL class) becomes a counted skip
 * that leaves the rest of the batch running, while anything else propagates.
 * Deleting the `instanceof` narrowing turns a policy refusal into a 500 for the
 * whole batch; widening it into a blanket catch reports a real failure as a
 * skipped line. Both directions are pinned here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock, allocateMock, findTxsMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { transaction: vi.fn() }),
  allocateMock: vi.fn(),
  findTxsMock: vi.fn(),
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

// The controlled allocation is the boundary this file mocks; the kernel's
// refusal class is the REAL one — the service narrows with instanceof against
// the class production actually throws, so it must not be re-declared.
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: allocateMock,
}));
vi.mock('@/modules/accounting/services/gl/ruleVatResolution', () => ({
  resolveRuleVatCode: vi.fn(async ({ requestedVatCode }: { requestedVatCode: string }) =>
    ({ vatCode: requestedVatCode, denied: false, nonSupplyCoerced: false, settlementDropped: false })),
}));
// The pre-flight reads (company lockdown facts, the kernel's approval question)
// are the boundary here; `dateRefusal` stays real so a row's period_status decides.
vi.mock('@/modules/accounting/services/bank/bankRulesAutoPostPreflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/bank/bankRulesAutoPostPreflight')>();
  return { ...actual, loadLockdownFacts: vi.fn(async () => ({})), approvalRequiredForLine: vi.fn(async () => false) };
});
vi.mock('@/modules/accounting/services/bank/bankRulesMatchingHelpers', () => ({
  toSqlPattern: vi.fn((_m: string, p: string) => p),
  findMatchingTxs: findTxsMock,
  // Real value: applyRules slices the candidate list with it, so a mock that
  // omitted it silently produced an empty run.
  MAX_RULE_CANDIDATES: 500,
}));

import { OperationApprovalRequiredError, SuppliedApprovalRefusal } from '@/modules/accounting/services/controls/approvalExecutionService';
import { BeneficiaryError } from '@/modules/accounting/services/controls/beneficiaryValidation';
import { ClosedFiscalPeriodError, LOCKDOWN_REFUSAL_MESSAGE, VAT_PERIOD_REFUSAL_MESSAGE } from '@/modules/accounting/services/gl/postingPeriodGuard';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import { enterFakeRequestCtx } from '../helpers/requestCtx';
import { als } from '@/lib/als';
import { MAX_RULE_SWEEP_ATTEMPTS_PER_REQUEST } from '@/lib/limits/authorityHoldLimits';

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
    { id: 'tx-1', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', is_deposit: false, period_status: 'open' },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // mockReset, not only clearAllMocks: a test that aborts mid-run leaves queued
  // *Once values behind, and the next test would consume them.
  allocateMock.mockReset();
  allocateMock.mockResolvedValue({ journalEntryId: 'je-1', bankTransaction: {} });
  sqlMock.transaction.mockResolvedValue([]);
});

describe('applyRules — races, locks and caps', () => {
  it('skips a candidate that was allocated between the rule query and the lock', async () => {
    // findMatchingTxs read this row as unallocated seconds ago; by the time the
    // lock is taken a UI allocation has committed on it. Posting anyway would
    // put a second journal on one transaction and relink the row to it.
    withOneAutoPostRule(lockedRow({ status: 'allocated', matched_journal_line_id: 'jl-1' }));

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(allocateMock).not.toHaveBeenCalled();
    expect(result.applied).toBe(0);
    // Counted, not silently dropped.
    expect(result.autoPostSkippedRaced).toBe(1);
  });

  it('skips a candidate that has been deleted since the rule query', async () => {
    withOneAutoPostRule(null);

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(allocateMock).not.toHaveBeenCalled();
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
      { id: 'tx-1', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', is_deposit: false, period_status: 'open' },
      { id: 'tx-2', transaction_date: '2026-08-14', amount: -200, description: 'BANK FEE', is_deposit: false, period_status: 'open' },
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
        amount: -100, description: 'BANK FEE', is_deposit: false, period_status: 'open',
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
    // 500 candidates, not 501 — the probe row is trimmed, never worked on. Of
    // those, one request ATTEMPTS at most the authority-hold bound and defers
    // the rest for the next run (a raced line still costs the attempt's lock read).
    expect(result.autoPostSkippedRaced).toBe(MAX_RULE_SWEEP_ATTEMPTS_PER_REQUEST);
    expect(result.autoPostDeferred).toBe(500 - MAX_RULE_SWEEP_ATTEMPTS_PER_REQUEST);
  });
});
