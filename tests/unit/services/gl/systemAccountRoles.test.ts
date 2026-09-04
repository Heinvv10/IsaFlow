/**
 * System account roles: the classification, and the coverage-vs-type invariant.
 *
 * The bug these exist for is not arithmetic. `validateSystemAccounts` carried a
 * hand-written list of 9 of the 14 roles, so the five it omitted could be empty
 * on every tenant in production and the health check reported them healthy by
 * never looking. A second hand-maintained list is a check that cannot fail on
 * the case it was built for, and no assertion about the nine it DID check would
 * ever have caught it.
 *
 * So the load-bearing test here is the last one: the checked set is the role
 * array itself, and a role added to the array without coverage goes red.
 */
import { describe, it, expect } from 'vitest';
import {
  MissingSystemAccountError,
  SYSTEM_ACCOUNT_KEYS,
  isSystemAccountKey,
  missingSystemAccountText,
  type NearMissClaimant,
} from '@/modules/accounting/services/gl/systemAccountKeys';
import { classifyRole } from '@/modules/accounting/services/gl/systemRoleCoverage';

function claimant(over: Partial<NearMissClaimant> = {}): NearMissClaimant {
  return {
    accountCode: '1110',
    accountName: 'Bank - Primary',
    accountType: 'asset',
    isActive: true,
    isSystemAccount: true,
    ...over,
  };
}

describe('classifyRole', () => {
  it('resolves a role held by exactly one active system account', () => {
    const r = classifyRole('bank', [claimant()]);
    expect(r.state).toBe('ok');
    expect(r.gap).toBeUndefined();
    expect(r.holder?.accountCode).toBe('1110');
  });

  it('reports no_claimant when nothing carries the subtype', () => {
    const r = classifyRole('disposal_profit_loss', []);
    expect(r.state).toBe('empty');
    expect(r.gap).toBe('no_claimant');
    expect(r.claimants).toEqual([]);
  });

  it('reports deactivated_claimants_only when the system rows are switched off', () => {
    const r = classifyRole('admin_expense', [
      claimant({ accountCode: '5500', isActive: false }),
      claimant({ accountCode: '6005', isActive: false }),
    ]);
    expect(r.state).toBe('empty');
    expect(r.gap).toBe('deactivated_claimants_only');
  });

  it('reports unflagged_active_claimant when the account is there and the flag is not', () => {
    const r = classifyRole('other_income', [
      claimant({ accountCode: '4300', accountName: 'Other Income', isSystemAccount: false }),
    ]);
    expect(r.state).toBe('empty');
    expect(r.gap).toBe('unflagged_active_claimant');
  });

  /**
   * Brightsphere's `bank`, exactly as production held it: two deactivated
   * system stubs with zero transactions between them, beside an active
   * unflagged account holding 8,342. Both gap shapes are present and the
   * remedies point at different accounts — "reactivate 1110" would have aimed
   * every future auto-posting at an account with no history.
   *
   * If this precedence ever flips, the migration that flags 1049686 becomes the
   * wrong fix, so it is asserted rather than left to the reading order of an
   * if/else.
   */
  it('prefers the unflagged ACTIVE account over a deactivated system one when both exist', () => {
    const r = classifyRole('bank', [
      claimant({ accountCode: '1001', accountName: 'Current Account', isActive: false }),
      claimant({ accountCode: '1110', isActive: false }),
      claimant({ accountCode: '1049686', accountName: 'Brighttech Absa', isSystemAccount: false }),
    ]);
    expect(r.state).toBe('empty');
    expect(r.gap).toBe('unflagged_active_claimant');
  });

  it('reports contested when two active system accounts claim one role', () => {
    const r = classifyRole('vat_input', [
      claimant({ accountCode: '1140' }),
      claimant({ accountCode: 'SYS-2' }),
    ]);
    expect(r.state).toBe('contested');
    expect(r.claimants).toHaveLength(2);
  });

  it('does not count a deactivated system row towards a contest', () => {
    const r = classifyRole('vat_input', [
      claimant({ accountCode: '1140' }),
      claimant({ accountCode: 'SYS-2', isActive: false }),
    ]);
    expect(r.state).toBe('ok');
  });
});

describe('MissingSystemAccountError', () => {
  it('names the role and the remedy, and carries the near misses', () => {
    const err = new MissingSystemAccountError(
      'bank',
      'd27bac33-cdc0-4e58-bf6b-709c1597d41c',
      'unflagged_active_claimant',
      [claimant({ accountCode: '1049686', accountName: 'Brighttech Absa', isSystemAccount: false })],
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.key).toBe('bank');
    expect(err.gap).toBe('unflagged_active_claimant');
    expect(err.remedy).toContain('is_system_account');
  });

  it('renders a tool message naming the account to fix, not a generic failure', () => {
    const err = new MissingSystemAccountError('bank', 'co-1', 'unflagged_active_claimant', [
      claimant({ accountCode: '1049686', accountName: 'Brighttech Absa', isSystemAccount: false }),
    ]);
    const text = missingSystemAccountText('allocate_bank_transaction', err);
    expect(text).toContain('allocate_bank_transaction');
    expect(text).toContain("'bank'");
    expect(text).toContain('1049686 Brighttech Absa');
    expect(text).toContain('active, not a system account');
    expect(text).toContain('Nothing was written');
    // The company id is the caller's own connection; echoing it back adds
    // nothing actionable and this asserts we do not.
    expect(text).not.toContain('co-1');
  });

  it('omits the candidate clause when there is nothing to name', () => {
    const text = missingSystemAccountText(
      'dispose_asset',
      new MissingSystemAccountError('disposal_profit_loss', 'co-1'),
    );
    expect(text).toContain('disposal_profit_loss');
    expect(text).not.toContain('Candidates already in the chart');
  });
});

describe('the role list is the single source of truth', () => {
  it('narrows a valid key and rejects an invalid one', () => {
    expect(isSystemAccountKey('disposal_profit_loss')).toBe(true);
    expect(isSystemAccountKey('payroll_liability')).toBe(false);
    expect(isSystemAccountKey(null)).toBe(false);
  });

  it('has no duplicates', () => {
    expect(new Set(SYSTEM_ACCOUNT_KEYS).size).toBe(SYSTEM_ACCOUNT_KEYS.length);
  });

  /**
   * The regression guard for the actual defect. `validateSystemAccounts` used to
   * check these nine and silently pass the other five; production was missing
   * three of the five on nearly every tenant while this reported healthy.
   *
   * Asserting the nine are still present would have passed against the broken
   * code. Asserting the five that were MISSING is what goes red if anyone
   * reintroduces a shortened list.
   */
  it('includes the five roles the old nine-role check omitted', () => {
    for (const key of [
      'opening_balance_equity',
      'other_income',
      'accumulated_depreciation',
      'depreciation_expense',
      'disposal_profit_loss',
    ] as const) {
      expect(SYSTEM_ACCOUNT_KEYS).toContain(key);
    }
    expect(SYSTEM_ACCOUNT_KEYS).toHaveLength(14);
  });
});
