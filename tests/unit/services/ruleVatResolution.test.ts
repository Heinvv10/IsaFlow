/**
 * The branch production actually runs.
 *
 * `bankRulesMatchingService` always passes BOTH the denial flag and the
 * account name, so the sweep always takes the batched branch — which had no
 * test at all until this file existed. Deleting the non-supply guard from it,
 * or the counter that reports it, failed nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { resolveRuleVatCode } from '@/modules/accounting/services/gl/ruleVatResolution';

const BASE = {
  allocType: 'account',
  companyId: 'aaaaaaaa-0000-0000-0000-000000000001',
  glAccountId: 'bbbbbbbb-0000-0000-0000-000000000002',
  denialContext: {},
  guardContext: { ruleName: 'Salary run' },
  // Resolved, so the bank-contra check spends no query. Its own cases below
  // override it; the `sql` mock in this file backs the two statutory guards
  // and a third lookup would eat their queued rows.
  ruleGlAccountIsBank: false,
};

beforeEach(() => vi.clearAllMocks());

describe('batched branch — what the sweep always takes', () => {
  it('coerces the salary claim and reports it as a non-supply', async () => {
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard',
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'Salaries & Wages - EX4000',
    });
    expect(r).toEqual({ vatCode: 'none', denied: false, nonSupplyCoerced: true, settlementDropped: false });
    expect(vi.mocked(sql), 'batched branch must not query').not.toHaveBeenCalled();
  });

  it('leaves a real supply claiming, and touches no counter', async () => {
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard',
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'Bank Charges - EX5006',
    });
    expect(r).toEqual({ vatCode: 'standard', denied: false, nonSupplyCoerced: false, settlementDropped: false });
  });

  it('reports an entertainment denial as denied, NOT as a non-supply', async () => {
    // Both counters exist so someone can fix the right configuration. A
    // denial relabelled as a non-supply sends them to the wrong screen.
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard',
      ruleGlAccountVatDenied: true, ruleGlAccountName: 'Staff Welfare - EX5040',
    });
    expect(r).toEqual({ vatCode: 'none', denied: true, nonSupplyCoerced: false, settlementDropped: false });
  });

  it('coerces a zero_rated claim on a non-supply account', async () => {
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'zero_rated',
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'Depreciation Expense',
    });
    expect(r).toEqual({ vatCode: 'none', denied: false, nonSupplyCoerced: true, settlementDropped: false });
  });

  it('leaves a non-claiming code alone', async () => {
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'none',
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'Salaries & Wages',
    });
    expect(r).toEqual({ vatCode: 'none', denied: false, nonSupplyCoerced: false, settlementDropped: false });
  });

  it('does not batch on the flag alone — a forgotten name must not half-run the guard', async () => {
    // Falls through to the per-line lookups instead. Two queries: the denial
    // resolver's, then the non-supply resolver's.
    vi.mocked(sql)
      .mockResolvedValueOnce([{ vat_input_denied: false, account_code: 'X', account_name: 'Salaries & Wages' }] as never)
      .mockResolvedValueOnce([{ account_name: 'Salaries & Wages' }] as never);
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard', ruleGlAccountVatDenied: false,
    });
    expect(r).toEqual({ vatCode: 'none', denied: false, nonSupplyCoerced: true, settlementDropped: false });
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(2);
  });
});

describe('per-line fallback', () => {
  it('coerces a salary claim it had to look up itself', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ vat_input_denied: false, account_code: 'X', account_name: 'Salaries & Wages' }] as never)
      .mockResolvedValueOnce([{ account_name: 'Salaries & Wages' }] as never);
    const r = await resolveRuleVatCode({ ...BASE, requestedVatCode: 'standard' });
    expect(r).toEqual({ vatCode: 'none', denied: false, nonSupplyCoerced: true, settlementDropped: false });
  });

  it('stops at the denial and never asks the second guard', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ vat_input_denied: true, account_code: 'X', account_name: 'Staff Welfare' }] as never);
    const r = await resolveRuleVatCode({ ...BASE, requestedVatCode: 'standard' });
    expect(r).toEqual({ vatCode: 'none', denied: true, nonSupplyCoerced: false, settlementDropped: false });
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(1);
  });
});

// Review follow-up, LOW. A transfer RULE stores its counterparty bank in
// `gl_account_id` and sets neither entity, so `bankRulesMatchingService`
// classifies it as `account` — the one arm that still splits. The non-supply
// guard cannot catch it: it classifies on NAME, and "FNB Cheque Account" reads
// like any other account. Judged on `account_subtype` instead.
describe('a contra account that IS a bank account', () => {
  it('drops the claim and reports it as a non-supply, not as a denial', async () => {
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard', ruleGlAccountIsBank: true,
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'FNB Cheque Account',
    });
    // `nonSupplyCoerced`, because that is exactly what a transfer between the
    // company's own accounts is — the sweep's counter stays honest.
    expect(r).toEqual({
      vatCode: 'none', denied: false, nonSupplyCoerced: true, settlementDropped: false,
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
  });

  it('spends no query and says nothing when the rule claims no VAT', async () => {
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'none', ruleGlAccountIsBank: true,
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'FNB Cheque Account',
    });
    expect(r.vatCode).toBe('none');
    expect(r.nonSupplyCoerced).toBe(false);
    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
  });

  // `claimsVat` is the same predicate the non-supply guard uses, so the two
  // agree on which codes are worth dropping: 'zero_rated' still declares a
  // supply on the VAT201 and goes; 'exempt' and 'no_vat' claim nothing and are
  // left exactly as the caller sent them.
  it('drops a zero_rated code, which still declares a supply', async () => {
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'zero_rated', ruleGlAccountIsBank: true,
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'FNB Cheque Account',
    });
    expect(r.vatCode).toBe('none');
    expect(r.nonSupplyCoerced).toBe(true);
  });

  it.each(['exempt', 'no_vat'])('leaves %s alone — it claims nothing', async (code) => {
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: code, ruleGlAccountIsBank: true,
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'FNB Cheque Account',
    });
    expect(r.vatCode).toBe(code);
    expect(r.nonSupplyCoerced).toBe(false);
  });

  it('yields to a statutory guard that already dropped the code', async () => {
    // Both land on 'none', so the ORDER only decides which counter reports it.
    // s17(2)(a) is the narrower, more actionable finding and it runs first, the
    // same precedence the denial guard already has over the non-supply one.
    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard', ruleGlAccountIsBank: true,
      ruleGlAccountVatDenied: true, ruleGlAccountName: 'Staff Welfare',
    });
    expect(r.vatCode).toBe('none');
    expect(r.denied).toBe(true);
    expect(r.nonSupplyCoerced).toBe(false);
  });

  it('spends no lookup on a code a statutory guard already dropped', async () => {
    // The reason it runs last: an unbatched caller pays a SELECT here, and a
    // code the guards already killed must not buy one.
    await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard', ruleGlAccountIsBank: undefined,
      ruleGlAccountVatDenied: true, ruleGlAccountName: 'Staff Welfare',
    });
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it('looks the subtype up itself when the caller did not resolve it', async () => {
    // Absent means "look it up", never "not a bank" — the same doctrine the
    // other two facts follow. Batched on neither fact here, so the queue is the
    // per-line path in order: denial flag, account name, then the subtype.
    vi.mocked(sql)
      .mockResolvedValueOnce([{ vat_input_denied: false }] as never)
      .mockResolvedValueOnce([{ account_name: 'FNB Cheque Account' }] as never)
      .mockResolvedValueOnce([{ account_subtype: 'bank' }] as never);

    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard', ruleGlAccountIsBank: undefined,
    });

    expect(r.vatCode).toBe('none');
    expect(r.nonSupplyCoerced).toBe(true);
    expect(vi.mocked(sql)).toHaveBeenCalledTimes(3);
  });

  it('leaves an ordinary expense account claiming after all three checks', async () => {
    // The control: the same three lookups, a subtype that is not a bank, and
    // the caller's code survives untouched.
    vi.mocked(sql)
      .mockResolvedValueOnce([{ vat_input_denied: false }] as never)
      .mockResolvedValueOnce([{ account_name: 'Computer Expenses' }] as never)
      .mockResolvedValueOnce([{ account_subtype: 'default_expense' }] as never);

    const r = await resolveRuleVatCode({
      ...BASE, requestedVatCode: 'standard', ruleGlAccountIsBank: undefined,
    });

    expect(r).toEqual({
      vatCode: 'standard', denied: false, nonSupplyCoerced: false, settlementDropped: false,
    });
  });
});

describe('non-account allocations', () => {
  // K-017. This used to pass the rule's code straight through, and
  // `buildAutoCreateLines` then relieved AP by the NET while the bank leg and
  // the payment document both carried the gross. A settlement is not a supply:
  // the code is dropped, and neither guard flag is raised because neither guard
  // is what dropped it.
  it.each(['supplier', 'customer'])('drops the code on a %s settlement', async (allocType) => {
    const r = await resolveRuleVatCode({
      ...BASE, allocType, requestedVatCode: 'standard',
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'Salaries & Wages',
    });
    expect(r).toEqual({
      vatCode: 'none', denied: false, nonSupplyCoerced: false, settlementDropped: true,
    });
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  // Review, MEDIUM: the drop was silent. The two statutory guards each log and
  // each raise a sweep counter; a third way for a code to vanish on the
  // UNATTENDED path has to say so, or a misconfigured rule leaves no evidence
  // but a journal nobody reads. It is its OWN flag, not a reuse of `denied` or
  // `nonSupplyCoerced` — a caller counting statutory denials must not count it.
  it('logs the drop once, with the code the rule asked for', async () => {
    await resolveRuleVatCode({
      ...BASE, allocType: 'supplier', requestedVatCode: 'standard',
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'Salaries & Wages',
    });
    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.info).mock.calls[0]![1]).toMatchObject({
      allocType: 'supplier', requestedVatCode: 'standard', companyId: BASE.companyId,
    });
  });

  it('stays quiet when the rule asked for no VAT in the first place', async () => {
    // Every supplier rule takes this branch. Logging each one would bury the
    // misconfigured rules this line exists to surface.
    const r = await resolveRuleVatCode({
      ...BASE, allocType: 'customer', requestedVatCode: 'none',
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'Salaries & Wages',
    });
    expect(r.settlementDropped).toBe(true);
    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
  });

  // The boundary on the other side: a transfer has no supply either, but it
  // never reaches a VAT line, so it keeps passing through untouched.
  it('passes the code straight through for a transfer line', async () => {
    const r = await resolveRuleVatCode({
      ...BASE, allocType: 'transfer', requestedVatCode: 'standard',
      ruleGlAccountVatDenied: false, ruleGlAccountName: 'Salaries & Wages',
    });
    expect(r).toEqual({ vatCode: 'standard', denied: false, nonSupplyCoerced: false, settlementDropped: false });
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });
});
