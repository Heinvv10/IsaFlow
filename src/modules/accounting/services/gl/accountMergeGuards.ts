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

/**
 * Hard stop for the recursive walk, for the same reason as
 * `accountReclassifyService`: `gl_accounts.parent_account_id` has no constraint
 * preventing a cycle, and one already in the data makes a recursive CTE run
 * forever while holding its row locks. Observed once; it wedged the dev
 * database until the backend was terminated by hand.
 */
export const MAX_TREE_DEPTH = 32;

export type MergeRefusalCode =
  | 'account_not_found'
  | 'source_equals_target'
  | 'account_type_mismatch'
  | 'target_is_descendant_of_source'
  | 'source_is_system_account'
  | 'source_bank_subtype_referenced'
  | 'source_referenced_by_configuration'
  | 'lines_cannot_be_repointed';

export interface ConfigurationReference {
  table: string;
  column: string;
  rows: number;
}

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

/**
 * The three FK columns the sweep below deliberately does NOT treat as
 * configuration, and why. Everything else referencing `gl_accounts.id` is
 * configuration and blocks the merge.
 *
 * A DB-gated test asserts this list against `pg_constraint`, so a table added
 * tomorrow lands in the sweep with no code change and cannot be silently missed.
 */
export const CONFIGURATION_REFERENCE_EXCLUSIONS: readonly { table: string; column: string }[] = [
  // The ledger itself — this is what the merge repoints.
  { table: 'gl_journal_lines', column: 'gl_account_id' },
  // A trigger-maintained cache. `trg_gl_jl_balance_update` recomputes the source
  // and deltas the target on every repointed row, so it follows the ledger.
  { table: 'gl_account_balances', column: 'gl_account_id' },
  // The chart's own tree — handled explicitly by reparenting the children.
  { table: 'gl_accounts', column: 'parent_account_id' },
];

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
export async function findConfigurationReferences(accountId: string): Promise<ConfigurationReference[]> {
  const excludedTables = CONFIGURATION_REFERENCE_EXCLUSIONS.map((e) => e.table);
  const excludedColumns = CONFIGURATION_REFERENCE_EXCLUSIONS.map((e) => e.column);
  const rows = (await sql`
    WITH fk AS (
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true
        JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum = k.att
        JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fatt
       WHERE c.contype = 'f'
         AND c.confrelid = 'gl_accounts'::regclass
         AND fa.attname = 'id'
         AND NOT (c.conrelid::regclass::text = ANY(${excludedTables}::text[])
                  AND a.attname = ANY(${excludedColumns}::text[]))
    )
    SELECT tbl, col, n FROM (
      SELECT tbl, col,
             (xpath('/row/c/text()', query_to_xml(
                format('SELECT COUNT(*) AS c FROM %I WHERE %I = %L::uuid', tbl, col, ${accountId}::TEXT),
                false, true, '')))[1]::text::bigint AS n
        FROM fk
    ) counted
     WHERE n > 0
     ORDER BY tbl, col
  `) as Record<string, unknown>[];
  return rows.map((r) => ({ table: String(r.tbl), column: String(r.col), rows: Number(r.n) }));
}

/**
 * Moving an account off the bank subtype orphans its statement rows:
 * `bank_transactions.bank_account_id` FKs to `gl_accounts(id)`, but every
 * banking screen reaches those rows through `account_subtype = 'bank'`. Same
 * rule `accountReclassifyService` enforces, for the same reason — a merge that
 * deactivates a bank account leaves its transactions reachable from nothing.
 */
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
  if (source.accountType !== target.accountType) {
    throw new AccountMergeError(
      `${source.accountCode} is ${source.accountType} and ${target.accountCode} is `
      + `${target.accountType}. Merging across account types would move a balance to the `
      + 'wrong side of the balance sheet.',
      'account_type_mismatch',
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
  const references = await findConfigurationReferences(source.id);
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
