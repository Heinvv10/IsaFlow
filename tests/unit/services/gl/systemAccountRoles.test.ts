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
import {
  BS_LINES,
  IS_LINES,
  SUBTYPE_TO_AFS_CODE,
} from '@/modules/accounting/services/afs/afsTaxonomySeeds';

function claimant(over: Partial<NearMissClaimant> = {}): NearMissClaimant {
  return {
    id: 'a',
    accountCode: '1110',
    accountName: 'Bank - Primary',
    accountType: 'asset',
    accountSubtype: 'bank',
    createdAt: Date.parse('2026-01-01T00:00:00Z'),
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
      claimant({ id: 'a', accountCode: '1140', accountSubtype: 'vat_input' }),
      claimant({ id: 'b', accountCode: 'SYS-2', accountSubtype: 'vat_input' }),
    ]);
    expect(r.state).toBe('contested');
    expect(r.claimants).toHaveLength(2);
  });

  /**
   * The Velocity Fibre state the resolver's own comment documents: two active
   * system rows claiming `vat_input`, one of them a LIABILITY named "VAT
   * Payable". The resolver applies `preferSystemAccount` — type-fit first — and
   * hands out the ASSET. A coverage report that ranked by account_code instead
   * would name `0900 VAT Payable` as the holder while every auto-posting went
   * to `1140`, and `chart_of_accounts_health` labels that field `resolverPicks`.
   *
   * `0900` sorts first by code AND is newer, so it wins on both of the tiebreaks
   * that come after type-fit. Only the type-fit rule saves it, which is why the
   * assertion is on `holder` and not merely on `state`.
   */
  it('names the account the RESOLVER would pick when a role is contested, not the first by code', () => {
    const vatPayable = claimant({
      id: 'b', accountCode: '0900', accountName: 'VAT Payable',
      accountType: 'liability', accountSubtype: 'vat_input',
      createdAt: Date.parse('2026-06-01T00:00:00Z'),
    });
    const vatInput = claimant({
      id: 'a', accountCode: '1140', accountName: 'VAT Input',
      accountType: 'asset', accountSubtype: 'vat_input',
      createdAt: Date.parse('2026-01-01T00:00:00Z'),
    });
    // Both orderings: the answer must not depend on fetch order.
    for (const rows of [[vatPayable, vatInput], [vatInput, vatPayable]]) {
      const r = classifyRole('vat_input', rows);
      expect(r.state).toBe('contested');
      expect(r.holder?.accountCode).toBe('1140');
    }
  });

  it('does not count a deactivated system row towards a contest', () => {
    const r = classifyRole('vat_input', [
      claimant({ accountCode: '1140' }),
      claimant({ accountCode: 'SYS-2', isActive: false }),
    ]);
    expect(r.state).toBe('ok');
  });
});

/**
 * A role the ledger can resolve but the AFS cannot place is a fix that opens a
 * hole one layer up. Migrations 605/606 create `3300 Opening Balance Equity`
 * and `4410 Profit / Loss on Disposal of Assets` for EVERY tenant;
 * `afsAutoMapper` tries subtype, then name patterns, then gives up and counts
 * the account as skipped. Neither name matches any pattern, so without a
 * subtype entry every one of those accounts is absent from the annual financial
 * statements — and for opening-balance equity that is equity missing from the
 * balance sheet.
 */
describe('every system role can be placed on the AFS', () => {
  const lines = [...BS_LINES, ...IS_LINES];
  const codes = new Set(lines.map((l) => l.code));

  it('maps both roles migrations 605/606 introduce', () => {
    expect(SUBTYPE_TO_AFS_CODE.opening_balance_equity).toBe('BS046');
    expect(SUBTYPE_TO_AFS_CODE.disposal_profit_loss).toBe('IS472');
  });

  it('maps them to codes that actually exist in the taxonomy', () => {
    // A typo'd code is indistinguishable from no mapping at all downstream.
    expect(codes.has(SUBTYPE_TO_AFS_CODE.opening_balance_equity)).toBe(true);
    expect(codes.has(SUBTYPE_TO_AFS_CODE.disposal_profit_loss)).toBe(true);
  });

  it('places opening balance equity inside capital and reserves, not in accumulated profit', () => {
    // The entire reason a dedicated clearing account exists is to keep opening
    // balances OUT of retained earnings, which is the first figure an auditor
    // reconciles. Landing it on BS045 would defeat the account.
    const line = lines.find((l) => l.code === SUBTYPE_TO_AFS_CODE.opening_balance_equity);
    expect(line?.parentCode).toBe('BS041');
    expect(SUBTYPE_TO_AFS_CODE.opening_balance_equity)
      .not.toBe(SUBTYPE_TO_AFS_CODE.retained_earnings);
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
