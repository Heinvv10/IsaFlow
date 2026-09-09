/**
 * The guards standing between "merge these two control accounts" and a wrong
 * merge. Each one is earned from a defect this repo has already had.
 *
 * Velocity Fibre carries two accounts per side, holding disjoint populations
 * posted in two eras — `SYS-7 Trade Receivables` (74 human journals, no credits
 * ever) beside `1120 Accounts Receivable` (agent-posted), and `SYS-8 Trade
 * Payables` beside `2110 Accounts Payable`. Every cash-application path writes
 * to the second, so R32.7m of receivables and R37.7m of payables sit in
 * accounts the write path cannot reach. Merging them is the remedy. It is also
 * a production data correction, which is a HUMAN decision — nothing here runs
 * unattended, and the dry run is what a person reads before deciding.
 *
 * Note what is deliberately NOT here: no opinion about which account is
 * canonical. Brightsphere's controls are `1101`/`2001` and its `1120`/`2110`
 * are all but empty — exactly the inverse of Velocity. The caller names both
 * accounts; this file only refuses the combinations that would corrupt the
 * ledger or the chart.
 */
import { sql } from '@/lib/neon';
import { reportingClassFor } from './accountReportingClass';
import { hasChildAccounts, isReportVisibleLeaf } from './isReportVisibleLeaf';
import {
  CONFIGURATION_REFERENCE_EXCLUSIONS,
  findConfigurationReferences,
  type ConfigurationReference,
} from './accountMergeReferences';

export { reportingClassFor, type ReportingClass } from './accountReportingClass';

export {
  CONFIGURATION_REFERENCE_EXCLUSIONS,
  findConfigurationReferences,
  type ConfigurationReference,
};

/**
 * Hard stop for the recursive walk, for the same reason as
 * `accountReclassifyService`: `gl_accounts.parent_account_id` has no constraint
 * preventing a cycle, and one already in the data makes a recursive CTE run
 * forever while holding its row locks. Observed once; it wedged the dev
 * database until the backend was terminated by hand.
 */
/** Every refusal, so a caller can map the whole class to one toolError / 400. */
export class AccountMergeError extends Error {
  constructor(
    message: string,
    readonly code: MergeRefusalCode,
    readonly references: ConfigurationReference[] = [],
  ) {
    super(message);
    this.name = 'AccountMergeError';
  }
}

export interface MergeAccount {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  isSystemAccount: boolean;
  isActive: boolean;
  parentAccountId: string | null;
  level: number;
}

export async function loadMergeAccount(companyId: string, id: string): Promise<MergeAccount | null> {
  const rows = (await sql`
    SELECT id, account_code, account_name, account_type, account_subtype,
           is_system_account, is_active, parent_account_id, level
      FROM gl_accounts
     WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
     LIMIT 1
  `) as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
    accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
    isSystemAccount: r.is_system_account === true,
    isActive: r.is_active === true,
    parentAccountId: r.parent_account_id == null ? null : String(r.parent_account_id),
    level: Number(r.level ?? 1),
  };
}

/**
 * Every non-ledger row still pointing at the account, found from the CATALOGUE
 * rather than from a hand-kept list.
 *
 * A hand-kept list of 35 (table, column) pairs is a list that goes stale the
 * first time somebody adds a table, and the failure is silent: the merge
 * finishes, and a bank rule or an AFS mapping is left addressing an account
 * nobody posts to any more. So the FK set is read from `pg_constraint` and each
 * one counted through `query_to_xml`, which is also why this survives the
 * dev/production schema drift — `payroll_gl_accounts` exists on dev and not on
 * production, and a statically-written query naming it would fail outright on
 * production.
 *
 * The identifiers come from `pg_catalog` and are quoted by `format(%I)`; the
 * account id is bound as a parameter and quoted by `format(%L)`. Nothing here
 * is concatenated in JavaScript.
 */
export const MAX_TREE_DEPTH = 32;

export type MergeRefusalCode =
  | 'account_not_found'
  | 'source_equals_target'
  | 'account_type_mismatch'
  | 'account_subtype_reporting_class'
  | 'target_is_inactive'
  | 'target_becomes_header'
  | 'target_is_descendant_of_source'
  | 'source_is_system_account'
  | 'source_bank_subtype_referenced'
  | 'source_referenced_by_configuration'
  | 'lines_cannot_be_repointed'
  | 'ledger_moved_during_merge';

async function countBankTransactions(companyId: string, accountId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS cnt FROM bank_transactions
     WHERE bank_account_id = ${accountId}::UUID AND company_id = ${companyId}::UUID
  `) as { cnt: number }[];
  return Number(rows[0]?.cnt ?? 0);
}

/** True when `targetId` sits at or below `sourceId` in the account tree. */
async function targetIsBelowSource(
  companyId: string, sourceId: string, targetId: string,
): Promise<boolean> {
  const rows = (await sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 1 AS depth FROM gl_accounts
       WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT ch.id, s.depth + 1 FROM gl_accounts ch
        JOIN subtree s ON ch.parent_account_id = s.id
       WHERE ch.company_id = ${companyId}::UUID AND s.depth < ${MAX_TREE_DEPTH}
    )
    SELECT 1 FROM subtree WHERE id = ${targetId}::UUID LIMIT 1
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Every REQUEST-level refusal, run before anything is read about the ledger and
 * long before anything is written. A refusal here is about the request the
 * caller made; a row the DATA will not let move is a skip, and lives in
 * `accountMergePreview`.
 */
export async function assertMergeable(
  companyId: string, source: MergeAccount, target: MergeAccount,
): Promise<void> {
  if (source.id === target.id) {
    throw new AccountMergeError('An account cannot be merged into itself', 'source_equals_target');
  }
  if (!target.isActive) {
    throw new AccountMergeError(
      `${target.accountCode} is deactivated. Merging into it would hide the balance from every `
      + 'picker and every report that filters on is_active — the same "money the write path '
      + 'cannot reach" state this merge exists to end.',
      'target_is_inactive',
    );
  }
  // The same failure as `target_is_inactive`, reached through the chart rather
  // than the flag: the balance sheet and the trend report select an account
  // only when `level >= 3 OR it has no children`. A level 1 or 2 target is on
  // the reports while it is childless — and `mergeAccounts` reparents every
  // direct child of the source onto it, so a source WITH children turns the
  // target into a header and drops the target's own balance and the merged one
  // off both reports, with the trial balance identical either way.
  if (target.level < 3
    && (await hasChildAccounts(companyId, source.id)
      || !(await isReportVisibleLeaf(companyId, target.id, target.level)))) {
    throw new AccountMergeError(
      `${target.accountCode} sits at level ${target.level} and would carry children after this `
      + 'merge. The balance sheet and the trend report select an account only when its level is '
      + '3 or higher or it has no children, so the merged balance would vanish from both while '
      + 'the trial balance still foots. Merge into a leaf account, or give the chart a leaf '
      + `child under ${target.accountCode} and merge into that.`,
      'target_becomes_header',
    );
  }
  if (source.accountType !== target.accountType) {
    throw new AccountMergeError(
      `${source.accountCode} is ${source.accountType} and ${target.accountCode} is `
      + `${target.accountType}. Merging across account types would move a balance to the `
      + 'wrong side of the balance sheet.',
      'account_type_mismatch',
    );
  }
  const sourceClass = reportingClassFor(source.accountSubtype);
  const targetClass = reportingClassFor(target.accountSubtype);
  if (sourceClass !== targetClass) {
    throw new AccountMergeError(
      `${source.accountCode} (subtype ${source.accountSubtype ?? 'none'}, reporting class `
      + `${sourceClass}) and ${target.accountCode} (subtype ${target.accountSubtype ?? 'none'}, `
      + `reporting class ${targetClass}) are read as different populations by the reports that `
      + 'select on account_subtype — the VAT201 membership filter and the banking screens. '
      + 'Moving lines across that boundary changes a statutory figure in one direction and '
      + 'silently drops it in the other, with the trial balance identical either way.',
      'account_subtype_reporting_class',
    );
  }

  // A system account is resolved BY ITS SUBTYPE for every auto-posting path
  // (`systemAccountResolver`), and the resolver's cache only loads rows that
  // are `is_active = true`. Deactivating the source would leave the role
  // unclaimed and every auto-posting path would start throwing.
  if (source.isSystemAccount) {
    throw new AccountMergeError(
      `${source.accountCode} is a system account. Auto-posting resolves it by its subtype `
      + `(${source.accountSubtype ?? 'none set'}), and deactivating it would leave that role `
      + 'unclaimed for every automatic journal.',
      'source_is_system_account',
    );
  }
  if (await targetIsBelowSource(companyId, source.id, target.id)) {
    throw new AccountMergeError(
      `${target.accountCode} sits below ${source.accountCode} in the chart — merging into it `
      + 'would create a cycle, and every recursive walk over the tree would stop terminating.',
      'target_is_descendant_of_source',
    );
  }
  if (source.accountSubtype === 'bank') {
    const count = await countBankTransactions(companyId, source.id);
    if (count > 0) {
      throw new AccountMergeError(
        `${count} bank transaction${count === 1 ? '' : 's'} still reference ${source.accountCode}. `
        + 'Deactivating it would leave them unreachable from every banking screen.',
        'source_bank_subtype_referenced',
      );
    }
  }
  const references = await findConfigurationReferences(companyId, source.id);
  if (references.length > 0) {
    throw new AccountMergeError(
      `${source.accountCode} is still named by ${references.length} configuration `
      + `reference${references.length === 1 ? '' : 's'}: `
      + `${references.map((r) => `${r.table}.${r.column} (${r.rows})`).join(', ')}. `
      + 'Repoint or clear them first — this merge does not touch configuration.',
      'source_referenced_by_configuration',
      references,
    );
  }
}
