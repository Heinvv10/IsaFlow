/**
 * Bank-rule auto-post: every per-line outcome the sweep reports, and the two
 * errors it must NOT swallow.
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
// The pre-flight READS (company lockdown facts, the company's payment policy)
// are the boundary here; `dateRefusal` and `approvalRefusalForAmount` stay real.
vi.mock('@/modules/accounting/services/bank/bankRulesAutoPostPreflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/bank/bankRulesAutoPostPreflight')>();
  return { ...actual, loadLockdownFacts: vi.fn(async () => ({})) };
});
vi.mock('@/modules/accounting/services/controls/approvalRuleService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/controls/approvalRuleService')>();
  return { ...actual, loadApprovalRules: vi.fn(async () => []) };
});
vi.mock('@/modules/accounting/services/controls/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/accounting/services/controls/context')>();
  return { ...actual, requireControlTx: vi.fn(() => ({ sql: sqlMock, principal: { companyId: COMPANY, personId: USER } })) };
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
    // `lockBankTransactionForUpdate` does `SELECT *`, and `feed_state` is NOT
    // NULL (migration 675) — a row without it is a row no SELECT can return,
    // and `feedStateOf` refuses it rather than assume 'posted'.
    feed_state: 'posted',
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

describe('applyRules — per-line outcomes', () => {
  it('posts an account rule through the controlled allocation, carrying the rule and the resolved VAT code', async () => {
    withOneAutoPostRule();

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result.applied).toBe(1);
    expect(result.entries[0]).toMatchObject({ bankTxId: 'tx-1', journalEntryId: 'je-1' });
    const [company, txId, contra, user, , allocType, party, vatCode, , , , , opts] = allocateMock.mock.calls[0]!;
    expect([company, txId, contra, user, allocType, party, vatCode]).toEqual(
      [COMPANY, 'tx-1', 'acct-charges', USER, 'account', undefined, 'no_vat']);
    // The plan carries the attribution: a later UPDATE would break the receipt's fingerprint.
    expect(opts).toEqual({ rule: { id: 'rule-1', name: 'Bank charges' } });
  });

  it('a supplier rule names the party and carries NO VAT code — the control account moves gross', async () => {
    withOneAutoPostRule();
    sqlMock.mockImplementation(((strings: TemplateStringsArray) => {
      const text = Array.isArray(strings) ? strings.join('') : String(strings);
      if (text.includes('FROM bank_transactions') && text.includes('FOR UPDATE')) return Promise.resolve([lockedRow()]);
      if (text.includes('FROM bank_categorisation_rules')) {
        return Promise.resolve([{
          id: 'rule-1', rule_name: 'ACME', priority: 1, auto_create_entry: true,
          gl_account_id: null, supplier_id: 'sup-1', match_type: 'contains', match_pattern: 'ACME', vat_code: 'standard',
        }]);
      }
      if (text.includes('FROM suppliers')) return Promise.resolve([{ name: 'ACME (Pty) Ltd' }]);
      if (text.includes('FROM gl_accounts')) return Promise.resolve([{ id: BANK_GL }]);
      return Promise.resolve([]);
    }) as never);

    await applyRules(COMPANY, BANK_GL, USER);

    const [, , contra, , description, allocType, party, vatCode] = allocateMock.mock.calls[0]!;
    expect([contra, allocType, party, vatCode]).toEqual([null, 'supplier', 'sup-1', undefined]);
    expect(description).toBe('Payment to ACME (Pty) Ltd');
  });

  it('a policy refusal leaves the line unposted, counted, and the run continues', async () => {
    withOneAutoPostRule();
    findTxsMock.mockResolvedValue([
      { id: 'tx-1', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', period_status: 'open' },
      { id: 'tx-2', transaction_date: '2026-08-14', amount: -200, description: 'BANK FEE', period_status: 'open' },
    ]);
    allocateMock
      .mockRejectedValueOnce(new OperationApprovalRequiredError())
      .mockResolvedValueOnce({ journalEntryId: 'je-2', bankTransaction: {} });

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result.autoPostSkippedApprovalRequired).toBe(1);
    expect(result.applied).toBe(1);
    expect(result.entries.map(e => e.bankTxId)).toEqual(['tx-2']);
  });

  it('does not touch the row or post anything of its own for a refused line', async () => {
    withOneAutoPostRule();
    allocateMock.mockRejectedValue(new OperationApprovalRequiredError());

    await applyRules(COMPANY, BANK_GL, USER);

    const writes = sqlMock.mock.calls.filter(c => {
      const text = Array.isArray(c[0]) ? (c[0] as string[]).join('') : String(c[0]);
      return /^\s*(UPDATE|INSERT|DELETE)/.test(text);
    });
    expect(writes).toEqual([]);
  });

  it('every refusal the controlled path raises is its own counted outcome, and the run continues past each', async () => {
    withOneAutoPostRule();
    const refusals = [
      new ClosedFiscalPeriodError('closed'),
      new Error(LOCKDOWN_REFUSAL_MESSAGE),
      new Error(VAT_PERIOD_REFUSAL_MESSAGE),
      new SuppliedApprovalRefusal('Approval material changed'),
    ];
    findTxsMock.mockResolvedValue([...refusals, null].map((_, i) =>
      ({ id: `tx-${i}`, transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', period_status: 'open' })));
    for (const refusal of refusals) allocateMock.mockRejectedValueOnce(refusal);
    allocateMock.mockResolvedValueOnce({ journalEntryId: 'je-last', bankTransaction: {} });

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result).toMatchObject({
      applied: 1,
      autoPostSkippedClosedPeriod: 1, autoPostSkippedLockdown: 1, autoPostSkippedVatPeriodFiled: 1,
      autoPostSkippedRefused: 1, autoPostRefusalReasons: ['Approval material changed'],
    });
    expect(result.entries.map(e => e.bankTxId)).toEqual(['tx-4']);
  });

  it('one unverified beneficiary answers for every other line of the same supplier rule — counted, not attempted', async () => {
    withOneAutoPostRule();
    findTxsMock.mockResolvedValue([1, 2, 3].map(i =>
      ({ id: `tx-${i}`, transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', period_status: 'open' })));
    allocateMock.mockRejectedValueOnce(new BeneficiaryError('LEGACY_UNVERIFIED'));

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result.autoPostSkippedBeneficiaryUnverified).toBe(3);
    expect(allocateMock).toHaveBeenCalledTimes(1);
  });

  it('a line whose period is not open, or has none, is counted from the candidate row and never attempted', async () => {
    withOneAutoPostRule();
    findTxsMock.mockResolvedValue([
      { id: 'tx-1', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', period_status: 'closed' },
      { id: 'tx-2', transaction_date: '2022-01-01', amount: -100, description: 'BANK FEE', period_status: null },
      { id: 'tx-3', transaction_date: '2026-08-13', amount: -100, description: 'BANK FEE', period_status: 'open' },
    ]);

    const result = await applyRules(COMPANY, BANK_GL, USER);

    expect(result).toMatchObject({ applied: 1, autoPostSkippedClosedPeriod: 1, autoPostSkippedNoPeriod: 1 });
    expect(allocateMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a pg fault', Object.assign(new Error('deadlock detected'), { code: '40P01' })],
    ['a plain Error from inside the write', new Error('Bank allocation state changed')],
    ['a coding defect', new TypeError('Cannot read properties of undefined')],
  ])('%s is not a refusal: it aborts the run', async (_label, error) => {
    withOneAutoPostRule();
    allocateMock.mockRejectedValue(error);

    await expect(applyRules(COMPANY, BANK_GL, USER)).rejects.toThrow(error.message);
  });

  it('a refusal that already poisoned the request is a fault, whatever its class', async () => {
    withOneAutoPostRule();
    allocateMock.mockImplementation(async () => {
      // What runJournalControl does when assertPostingGuards fires INSIDE the write.
      als.getStore()!.controlWriteFailed = true;
      throw new ClosedFiscalPeriodError('closed');
    });

    // Counting it would report a 500 as a skip: withAuth answers
    // CONTROL_INTEGRITY_FAILED for the poisoned request regardless.
    await expect(applyRules(COMPANY, BANK_GL, USER)).rejects.toThrow(ClosedFiscalPeriodError);
  });
});
