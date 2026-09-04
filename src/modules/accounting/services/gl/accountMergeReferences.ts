/**
 * Every non-ledger row still pointing at a GL account, found from the CATALOGUE
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
 * It is un-staleable FOR FOREIGN KEYS, and that is the whole of its claim.
 * A reference held BY CODE rather than by id is invisible to it by
 * construction — `group_accounts.account_code` is the consolidation chart and
 * resolves company accounts by code, so no constraint exists for this to find.
 * That one is named in the tool description's "does not cover" list instead.
 *
 * The identifiers come from `pg_catalog` and are quoted by `format(%I)`; the
 * ids are bound as parameters and quoted by `format(%L)`. Nothing is
 * concatenated in JavaScript.
 */
import { sql } from '@/lib/neon';

export interface ConfigurationReference {
  table: string;
  column: string;
  rows: number;
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
  // The merge's own history. A record of a previous merge is not configuration,
  // and treating it as such would make the first merge of an account block
  // every later one — including a corrective merge back.
  { table: 'gl_account_merges', column: 'source_account_id' },
  { table: 'gl_account_merges', column: 'target_account_id' },
];

export async function findConfigurationReferences(
  companyId: string, accountId: string,
): Promise<ConfigurationReference[]> {
  const excludedTables = CONFIGURATION_REFERENCE_EXCLUSIONS.map((e) => e.table);
  const excludedColumns = CONFIGURATION_REFERENCE_EXCLUSIONS.map((e) => e.column);
  const rows = (await sql`
    WITH fk AS (
      SELECT n.nspname                            AS sch,
             cl.relname                           AS tbl,
             a.attname                            AS col,
             EXISTS (SELECT 1 FROM pg_attribute ca
                      WHERE ca.attrelid = c.conrelid AND ca.attname = 'company_id'
                        AND ca.attnum > 0 AND NOT ca.attisdropped) AS has_company
        FROM pg_constraint c
        JOIN pg_class cl     ON cl.oid = c.conrelid
        JOIN pg_namespace n  ON n.oid = cl.relnamespace
        JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(att, fatt, ord) ON true
        JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum = k.att
        JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fatt
       WHERE c.contype = 'f'
         AND c.confrelid = 'gl_accounts'::regclass
         AND fa.attname = 'id'
         -- PAIRWISE. Two parallel arrays compared with two separate ANY()s form
         -- a cross product, so adding a (table, column) pair would silently
         -- exclude any other table that happens to carry that column name.
         AND NOT EXISTS (
           SELECT 1 FROM unnest(${excludedTables}::text[], ${excludedColumns}::text[]) AS x(t, c2)
            WHERE x.t = cl.relname AND x.c2 = a.attname
         )
    )
    SELECT tbl, col, n FROM (
      SELECT tbl, col,
             (xpath('/row/c/text()', query_to_xml(
                -- %I.%I, not regclass::text: the latter renders schema.table
                -- for anything off the search path and %I then quotes the whole
                -- string as ONE identifier. Case is handled the same way.
                --
                -- The tenant predicate is added only where the table has a
                -- company_id column; the rest are still correct without it
                -- (the FK targets one gl_accounts.id, which belongs to exactly
                -- one company) but a corrupt cross-company row would otherwise
                -- block a legitimate merge naming a table with no visible rows.
                format('SELECT COUNT(*) AS c FROM %I.%I WHERE %I = %L::uuid', sch, tbl, col, ${accountId}::TEXT)
                || CASE WHEN has_company
                        THEN format(' AND company_id = %L::uuid', ${companyId}::TEXT)
                        ELSE '' END,
                false, true, '')))[1]::text::bigint AS n
        FROM fk
    ) counted
     WHERE n > 0
     ORDER BY tbl, col
  `) as Record<string, unknown>[];
  return rows.map((r) => ({ table: String(r.tbl), column: String(r.col), rows: Number(r.n) }));
}
