/**
 * The wiring, not the rule.
 *
 * `resolveVatCodeForAccount` is the single funnel every UNATTENDED path goes
 * through — the LLM categorisation pass, the smart-learning pass, and
 * autoPostRuleLine's per-line fallback. Removing the non-supply guard from it
 * broke no test until these existed, which meant the guard could be deleted
 * from all three callers at once and CI would stay green.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { resolveVatCodeForAccount } from '@/modules/accounting/services/gl/inputVatDenial';

const COMPANY = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACCT = 'bbbbbbbb-0000-0000-0000-000000000002';

const account = (name: string, denied = false) =>
  vi.mocked(sql).mockResolvedValueOnce(
    [{ vat_input_denied: denied, account_code: '49784360', account_name: name }] as never,
  );

beforeEach(() => vi.clearAllMocks());

describe('resolveVatCodeForAccount — the non-supply chain', () => {
  it('coerces the salary claim that produced the defect', async () => {
    account('Salaries & Wages - EX4000');
    const r = await resolveVatCodeForAccount(COMPANY, ACCT, 'standard');
    expect(r.vatCode).toBe('none');
    expect(r.nonSupplyReason).toBe('employment_cost');
    expect(r.denied).toBe(false);
  });

  it('coerces a zero_rated claim too — it still declares a supply value', async () => {
    account('Salaries & Wages - EX4000');
    const r = await resolveVatCodeForAccount(COMPANY, ACCT, 'zero_rated');
    expect(r.vatCode).toBe('none');
    expect(r.nonSupplyReason).toBe('employment_cost');
  });

  it('leaves a real supply alone', async () => {
    account('Bank Charges - EX5006');
    const r = await resolveVatCodeForAccount(COMPANY, ACCT, 'standard');
    expect(r.vatCode).toBe('standard');
    expect(r.nonSupplyReason).toBeUndefined();
  });

  it('lets the entertainment denial win when both could fire', async () => {
    // Staff Welfare is flagged vat_input_denied AND is not name-matched. The
    // denial is the narrower, statutory rule and reports its own counter, so
    // it must not be relabelled as a non-supply.
    account('Staff Welfare - EX5040', true);
    const r = await resolveVatCodeForAccount(COMPANY, ACCT, 'standard');
    expect(r.vatCode).toBe('none');
    expect(r.denied).toBe(true);
    expect(r.nonSupplyReason).toBeUndefined();
  });

  it('does not query at all when nothing is being claimed', async () => {
    const r = await resolveVatCodeForAccount(COMPANY, ACCT, 'none');
    expect(r.vatCode).toBe('none');
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it('does not query for exempt — correct on the accounts it would match', async () => {
    const r = await resolveVatCodeForAccount(COMPANY, ACCT, 'exempt');
    expect(r.vatCode).toBe('exempt');
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it('survives an account row that came back without a name', async () => {
    vi.mocked(sql).mockResolvedValueOnce(
      [{ vat_input_denied: false, account_code: 'X', account_name: null }] as never,
    );
    const r = await resolveVatCodeForAccount(COMPANY, ACCT, 'standard');
    expect(r.vatCode).toBe('standard');
    expect(r.nonSupplyReason).toBeUndefined();
  });
});
