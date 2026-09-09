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
