/**
 * `resolveVatCodeForAccount` must NOT coerce a non-supply account.
 *
 * It is the funnel the LLM and smart-learning passes use to write
 * `suggested_vat_code`, which a human then reviews on the bank screen. An
 * earlier cut chained the non-supply guard in here, which rewrote 'standard'
 * to 'none' before anyone saw it — and the screen's warning keys off
 * 'standard', so the reviewer was shown a plain "No VAT" with no hint that
 * anything had been decided for them. On an ambiguous name like
 * `COS - Casual wages`, a labour broker's genuinely claimable input tax would
 * disappear silently. Chain it back in and these go red.
 *
 * The unattended POSTER guards itself: see ruleVatResolution.test.ts.
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

describe('resolveVatCodeForAccount — s17(2)(a) only', () => {
  it('leaves a salary suggestion claiming, for the human to judge', () => {
    account('Salaries & Wages - EX4000');
    return expect(resolveVatCodeForAccount(COMPANY, ACCT, 'standard'))
      .resolves.toEqual({ vatCode: 'standard', denied: false });
  });

  it('leaves the ambiguous labour-broker name claiming', () => {
    account('COS - Casual wages - EX2009');
    return expect(resolveVatCodeForAccount(COMPANY, ACCT, 'standard'))
      .resolves.toEqual({ vatCode: 'standard', denied: false });
  });

  it('still coerces an entertainment account — that guard belongs here', () => {
    account('Staff Welfare - EX5040', true);
    return expect(resolveVatCodeForAccount(COMPANY, ACCT, 'standard'))
      .resolves.toEqual({ vatCode: 'none', denied: true });
  });

  it('does not query for a zero_rated code — only standard is ever denied', async () => {
    const r = await resolveVatCodeForAccount(COMPANY, ACCT, 'zero_rated');
    expect(r).toEqual({ vatCode: 'zero_rated', denied: false });
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });
});
