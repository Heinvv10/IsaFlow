/**
 * The system account roles, as a runtime value, and the refusal raised when one
 * is empty.
 *
 * WHY THIS FILE EXISTS AT ALL. `SystemAccountKey` used to be a bare type union
 * in `systemAccountResolver.ts`, and types are erased at runtime — so every
 * consumer that needed the LIST had to retype it by hand. Two did:
 * `RESOLVED_SUBTYPES` in the resolver, and `validateSystemAccounts`, whose copy
 * carried 9 of the 14 roles. The five it omitted were `opening_balance_equity`,
 * `other_income`, `accumulated_depreciation`, `depreciation_expense` and
 * `disposal_profit_loss` — and on 2026-09-04 production was missing three of
 * exactly those five on nearly every tenant, invisibly, because the health
 * check that exists to find them could not see them. A hand-maintained second
 * list is a check that cannot fail on the case it was built for.
 *
 * So the array is the source of truth and the type is derived from it. Adding a
 * role means adding one array entry, and every consumer picks it up.
 *
 * This module deliberately imports nothing. `registry.ts` renders
 * `MissingSystemAccountError` at the MCP boundary and must not depend on a
 * service that opens a database connection.
 */

/**
 * Every role the resolver hands out, in reporting order.
 *
 * Order is the order `chart_of_accounts_health` lists roles in; it carries no
 * other meaning.
 */
export const SYSTEM_ACCOUNT_KEYS = [
  'bank',                      // Primary bank account
  'receivable',                // Accounts Receivable
  'payable',                   // Accounts Payable
  'vat_input',                 // VAT Input (claimable)
  'vat_output',                // VAT Output (payable)
  'retained_earnings',         // Retained Earnings
  'opening_balance_equity',    // Opening Balance Equity (clearing; nets to zero once the opening TB is complete)
  'default_revenue',           // Default revenue account
  'other_income',              // Other Income
  'default_expense',           // Default expense (Materials & Supplies)
  'admin_expense',             // Administrative Expenses
  'accumulated_depreciation',  // Accumulated Depreciation
  'depreciation_expense',      // Depreciation Expense
  'disposal_profit_loss',      // Profit / Loss on Disposal of Assets
] as const;

/**
 * Subtypes that the system requires for auto-posting and reporting.
 * Each maps to exactly one system account (is_system_account = true).
 */
export type SystemAccountKey = (typeof SYSTEM_ACCOUNT_KEYS)[number];

/** Membership test that narrows, for callers holding an unvalidated string. */
export function isSystemAccountKey(v: unknown): v is SystemAccountKey {
  return typeof v === 'string' && (SYSTEM_ACCOUNT_KEYS as readonly string[]).includes(v);
}

/**
 * What the chart looks like for a role that the resolver could not serve.
 *
 * The distinction matters because the remedy differs. `no_claimant` means create
 * an account. The other two mean an account is already there and one column is
 * wrong — and creating a second one would be the wrong
 * fix. Brightsphere's `bank` role had two deactivated system rows AND
 * 8,342 bank transactions sitting on an active unflagged account; a new
 * "Bank - Primary" there would have been actively harmful. When both shapes are
 * present the unflagged-active one wins, because flagging the account that
 * already holds the history is the correct fix.
 */
export type SystemRoleGap =
  | 'no_claimant'
  | 'deactivated_claimants_only'
  | 'unflagged_active_claimant';

/** A row that nearly claims a role, named so the operator can go and look at it. */
export interface NearMissClaimant {
  accountCode: string;
  accountName: string;
  accountType: string;
  isActive: boolean;
  isSystemAccount: boolean;
}

/** The fix sentence for each shape of gap. */
const REMEDY: Record<SystemRoleGap, string> = {
  no_claimant:
    'No account carries this subtype. Create one, or set account_subtype on the account that should hold the role.',
  deactivated_claimants_only:
    'The only accounts claiming this role are deactivated. Reactivate the right one rather than creating another.',
  unflagged_active_claimant:
    'An active account carries this subtype but is not flagged is_system_account. Set that flag rather than creating another account.',
};

/**
 * No system account holds `key` for this company.
 *
 * THROWN, NOT RETURNED, and that is the whole design. `getSystemAccount` has
 * ~40 call sites and every one of them is inside a service that goes on to
 * write a journal. Returning a refusal there would make each of those sites
 * responsible for noticing it, and a site that forgot would post a journal
 * against `undefined` — a silent wrong answer, which is strictly worse than a
 * 500. The MCP registry's savepoint also unwinds on a throw and NOT on a
 * returned error, so a returned refusal after a partial write would commit it.
 *
 * What this class changes is only what the caller is TOLD afterwards. The
 * registry renders it (see `missingSystemAccountText`) into a named blocker
 * instead of "The operation failed. Please try again or contact support."
 *
 * Modelled on `PeriodCloseBlockedError`, which `writeFiscalPeriods.ts` catches
 * and turns into itemised blockers.
 */
export class MissingSystemAccountError extends Error {
  readonly key: SystemAccountKey;
  readonly companyId: string;
  readonly gap: SystemRoleGap;
  /** Rows that nearly claim the role — empty when `gap` is `no_claimant`. */
  readonly nearMisses: NearMissClaimant[];
  /** What to do about it, in one sentence. */
  readonly remedy: string;

  constructor(
    key: SystemAccountKey,
    companyId: string,
    gap: SystemRoleGap = 'no_claimant',
    nearMisses: NearMissClaimant[] = [],
  ) {
    super(
      `No system account holds the '${key}' role for company ${companyId}. ${REMEDY[gap]}`,
    );
    this.name = 'MissingSystemAccountError';
    this.key = key;
    this.companyId = companyId;
    this.gap = gap;
    this.nearMisses = nearMisses;
    this.remedy = REMEDY[gap];
  }
}

/**
 * The text an MCP tool result carries for a missing role. Never SQL, never a
 * stack, and never the company id — the caller already knows which company it
 * is connected to, and echoing it back adds nothing an agent can act on.
 */
export function missingSystemAccountText(
  toolName: string,
  err: MissingSystemAccountError,
): string {
  const near = err.nearMisses.length > 0
    ? ' Candidates already in the chart: '
      + err.nearMisses
        .map((c) => `${c.accountCode} ${c.accountName}`
          + ` (${c.isActive ? 'active' : 'deactivated'},`
          + ` ${c.isSystemAccount ? 'system' : 'not a system account'})`)
        .join('; ')
      + '.'
    : '';
  return `${toolName} could not run: the '${err.key}' system account role is not `
    + `configured for this company. ${err.remedy}${near}`
    + ' Nothing was written. Call chart_of_accounts_health for every empty role.';
}
