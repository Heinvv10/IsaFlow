/**
 * The column census without a database (breaker r2 N9): the integration census (audit-snapshots-columns) checks the
 * live schema, but GitHub's CI runs no integration tests, so a PR adding a ledger column would merge green. This reads
 * the migrations instead: every column a migration ADDs (or RENAMEs to) on gl_journal_entries / gl_journal_lines, and
 * has not dropped since, must be frozen in the snapshot's rows (snapshotRows.ts) or named as not material
 * (tests/helpers/auditSnapshotColumns.ts). Columns from the tables' original CREATE are the integration census's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { compareMigrationNames } from '../../../../scripts/lib/migrationFiles';
import { describe, expect, it } from 'vitest';
import { NOT_MATERIAL, RENAMED } from '../../../helpers/auditSnapshotColumns';

const ROOT = path.resolve(__dirname, '../../../..');
const MIGRATIONS = path.join(ROOT, 'scripts/migrations/sql');
type Table = 'gl_journal_entries' | 'gl_journal_lines';
const NOT_A_COLUMN = new Set(['constraint', 'primary', 'foreign', 'unique', 'check', 'exclude', 'default', 'not', 'identity', 'expression']);

const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** Where the statement starting at `from` ends: the first ';' outside a '…' literal and a $tag$…$tag$ body. */
function statementEnd(sql: string, from: number): number {
  let quoted = false;
  for (let i = from; i < sql.length; i++) {
    const dollar = !quoted && sql[i] === '$' ? /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i)) : null;
    if (dollar) {
      const close = sql.indexOf(dollar[0], i + dollar[0].length);
      if (close < 0) return sql.length;
      i = close + dollar[0].length - 1;
    } else if (sql[i] === "'") quoted = !quoted; // '' inside a literal toggles twice: still inside
    else if (sql[i] === ';' && !quoted) return i;
  }
  return sql.length;
}

const TABLE = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?(gl_journal_entries|gl_journal_lines)"?(?![\w"])/gi;
const IDENT = '"?([a-z_][a-z0-9_]*)"?';

/** The columns migrations add to the two tables (in file order: added, renamed to, dropped). */
function addedColumns(files: string[]): Record<Table, Set<string>> {
  const out: Record<Table, Set<string>> = { gl_journal_entries: new Set(), gl_journal_lines: new Set() };
  for (const raw of files) {
    const sql = stripComments(raw);
    for (const m of sql.matchAll(TABLE)) {
      const cols = out[m[1]!.toLowerCase() as Table];
      const body = sql.slice(m.index! + m[0].length, statementEnd(sql, m.index! + m[0].length));
      for (const [, name] of body.matchAll(new RegExp(`\\bADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENT}`, 'gi'))) {
        if (!NOT_A_COLUMN.has(name!.toLowerCase())) cols.add(name!.toLowerCase());
      }
      for (const [, from, to] of body.matchAll(new RegExp(`\\bRENAME\\s+(?:COLUMN\\s+)?${IDENT}\\s+TO\\s+${IDENT}`, 'gi'))) {
        cols.delete(from!.toLowerCase());
        cols.add(to!.toLowerCase());
      }
      for (const [, name] of body.matchAll(new RegExp(`\\bDROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?${IDENT}`, 'gi'))) {
        if (!NOT_A_COLUMN.has(name!.toLowerCase())) cols.delete(name!.toLowerCase());
      }
    }
  }
  return out;
}

/**
 * Migrations the census cannot read: dynamic SQL (EXECUTE) in a file that mentions a journal at all (a table name can
 * be built with ||), or a U&"…" identifier. Named limit: a name split inside the word itself is not caught; every
 * migration is still reviewed. The ones that exist were read by hand and pinned; a new one fails
 * until someone confirms it adds no ledger column and pins it.
 */
function unreadable(files: { name: string; sql: string }[]): string[] {
  return files.filter(({ sql }) => {
    const code = stripComments(sql);
    return (/\bEXECUTE\b/i.test(code) && /journal/i.test(code)) || /\bU&"/i.test(code)
      // a rebuilt table: CREATE … (LIKE gl_journal_…) or a rename swapped into its place (breaker r5 N2)
      || /\bLIKE\s+(?:"?public"?\s*\.\s*)?"?gl_journal_(?:entries|lines)\b/i.test(code)
      || /\bRENAME\s+TO\s+"?gl_journal_(?:entries|lines)\b/i.test(code);
  }).map(({ name }) => name);
}

/**
 * Read by hand (2026-10-12): none of their EXECUTEs adds or renames a column of gl_journal_entries / gl_journal_lines.
 * 903 (2026-10-21): its one EXECUTE revokes grants on categorization_decisions; "journal" is that table's own
 * posted_journal_entry_id column, and it ALTERs no journal table.
 */
const READ_BY_HAND = new Set([
  '000_users_and_auth.sql', '200_accounting_foundation.sql', '201_accounts_payable.sql',
  '202_accounts_receivable.sql', '203_bank_reconciliation.sql', '206_phase1_sage_alignment.sql',
  '240_group_companies.sql', '244_fixed_assets.sql', '414_provisional_je_bank_first.sql', '421_expense_claims.sql',
  '499_gl_account_balances_status_trigger.sql', '500_widen_journal_entry_number.sql',
  '501_je_fiscal_period_autoresolve.sql', '653_soft_delete_journal_reversals.sql',
  '940_fiscal_years.sql', '941_journal_period_from_entry_date.sql', // EXECUTE FUNCTION in CREATE TRIGGER only; adds no column (2026-10-23)
  '1019_intercompany_p2_mirror.sql', // EXECUTE FUNCTION in CREATE TRIGGER only; "journal" is intercompany_transactions' target_journal_entry_id and supplier_invoices.gl_journal_entry_id, read; it ALTERs no journal table (2026-11-19)
  '675_bank_feed_canonical_ingestion.sql', '701_vat_input_late_claim_account.sql',
  '708_approval_enforcement_infra.sql', '711_supplier_payment_settles_provisional.sql',
  '855_retire_data_archiving.sql', '862_credit_note_approval_enforcement.sql',
  '867_supplier_payment_approval_enforcement.sql', '869_manual_journal_approval_enforcement.sql',
  '871_fx_pr0_refuse_foreign_currency.sql', '872_approval_request_definer_writes.sql',
  '876_supplier_bank_verification.sql', '877_bank_controls_step2.sql',
  '881_approval_rule_enforcement_definer_writes.sql', '884_validate_dimension_fks.sql',
  '885_bank_rule_switch_definer.sql', '891_audit_snapshots.sql', '903_categorization_decisions.sql',
  // 930 (S-07c): GRANT/REVOKE EXECUTE ON FUNCTION and a definer list naming manual_journal_approval_gate(); no DDL on either table.
  '930_credential_membership_writes_off_app_pools.sql',
  // 951 (2026-10-31, pay-run approval): EXECUTE only as GRANT EXECUTE ON FUNCTION / EXECUTE FUNCTION in CREATE TRIGGER;
  // "journal" is only the R-035 document-type list ('journal_entry', 'manual_journal'), as in 708/862/881. No DDL on gl_journal_entries / gl_journal_lines, no dynamic SQL.
  '951_pay_run_approval.sql',
  // 978 (2026-11-12, transfer link log): EXECUTE only as EXECUTE FUNCTION in CREATE TRIGGER and a DO-block REVOKE on
  // bank_transfer_link_log itself; "journal" is that table's own journal_entry_id / journal_line_id columns and its
  // guard's read of gl_journal_lines. No DDL on gl_journal_entries / gl_journal_lines.
  '978_bank_transfer_link_log.sql',
  // 981 (2026-11-12, bank review reset): EXECUTE only as EXECUTE FUNCTION in CREATE TRIGGER on bank_transactions;
  // "journal" is only the bank line's matched_journal_line_id column. No DDL on gl_journal_entries / gl_journal_lines.
  '981_bank_tx_review_reset_on_rematch.sql',
  // 999n (2026-11-17, wave 6 FZ freeze): EXECUTE only as EXECUTE FUNCTION in its CREATE TRIGGERs (some on
  // gl_journal_entries / gl_journal_lines) and GRANT EXECUTE ON FUNCTION. Triggers only: no column added, renamed or rebuilt.
  '999n_freeze_final_pay_runs_and_posted_journals.sql',
  // 999r (2026-11-17, company-group row security): EXECUTE only as EXECUTE FUNCTION in CREATE TRIGGER; "journal" is the
  // read-only definer rls_intercompany_parties_ok's check that a journal entry id belongs to its company. No DDL on
  // gl_journal_entries / gl_journal_lines, no dynamic SQL.
  '999r_company_groups_rls.sql',
  // 1012 (2026-11-19, intercompany pairing): EXECUTE only as GRANT EXECUTE ON FUNCTION; "journal" is the read-only definer
  // intercompany_pairing_partner_loan_balance's SUM over gl_journal_entries / gl_journal_lines. No DDL on either table, no dynamic SQL.
  '1012_intercompany_pairing.sql',
  // 1025 (2026-11-23, intercompany P4-B allocation sender): EXECUTE only as GRANT EXECUTE ON FUNCTION and has_function_privilege(..., 'EXECUTE');
  // "journal" is the read-only definer intercompany_send_for_allocation's check that a payment's journal stands (intercompany_journal_chain_length)
  // and the message's source_journal_entry_id. No DDL on gl_journal_entries / gl_journal_lines, no dynamic SQL.
  '1025_intercompany_p4b_allocation_sender.sql',
  // 1026 (2026-11-23, intercompany P4-C allocation liveness): EXECUTE only as GRANT EXECUTE ON FUNCTION and has_function_privilege(..., 'EXECUTE');
  // "journal" is the read-only (STABLE) definer intercompany_allocation_message_live's check that the journal a message recorded still stands
  // (intercompany_journal_chain_length) and the payment's gl_journal_entry_id. No DDL on gl_journal_entries / gl_journal_lines, no dynamic SQL.
  '1026_intercompany_p4c_allocation_live.sql',
  // 1027 (2026-11-23, intercompany P4-D allocation clearing): EXECUTE only as GRANT EXECUTE ON FUNCTION and has_function_privilege(..., 'EXECUTE');
  // "journal" is the read-only liveness definer's SUM over the payer's gl_journal_lines (its loan credit) and the INVOKER guard helpers' reads of the
  // receiver's own gl_journal_entries / gl_journal_lines (the clearing journal's two lines, its reversal). No DDL on either table, no dynamic SQL.
  '1027_intercompany_p4d_allocation_clearing.sql',
  // 1029 (2026-11-24, intercompany P4-E receiver readiness + connection hold): EXECUTE only as GRANT EXECUTE ON FUNCTION, has_function_privilege(...,
  // 'EXECUTE') and the deploy-safe REVOKE loop's EXECUTE format('REVOKE ALL ON FUNCTION ...'); "journal" is the read-only payer-standing helper's
  // check that a message's recorded journal stands (intercompany_journal_chain_length, the payment's gl_journal_entry_id) and a receipt's journal
  // chain. No DDL on gl_journal_entries / gl_journal_lines.
  '1029_intercompany_p4e_receiver_readiness.sql',
  // 1030 (2026-11-24, intercompany P5 loan reconciliation, read only): EXECUTE only as GRANT EXECUTE ON FUNCTION, has_function_privilege(...,
  // 'EXECUTE') and the deploy-safe REVOKE loop's EXECUTE format('REVOKE ALL ON FUNCTION ...'); "journal" is the STABLE readers' walk of
  // gl_journal_entries (reversal chains) and their SUMs over gl_journal_lines on the loan accounts. No DDL on gl_journal_entries / gl_journal_lines.
  '1030_intercompany_p5_loan_reconciliation.sql',
  // 1018 (2026-11-20, ledger column immutability): EXECUTE only as EXECUTE FUNCTION in its CREATE TRIGGERs (on
  // gl_journal_entries and the three document tables). One column added, document_cancelled_at (NOT_MATERIAL); none renamed
  // or rebuilt, no dynamic SQL.
  '1018_ledger_column_immutability.sql',
]);

/** The columns a snapshot's canonical row freezes: what `je.` / `jl.` the row's jsonb_build_object reads. */
function frozenColumns(): Record<Table, Set<string>> {
  const src = readFileSync(path.join(ROOT, 'src/modules/accounting/services/audit/snapshotRows.ts'), 'utf8');
  const rowOf = (fn: string, alias: string) => {
    const from = src.indexOf(`export async function ${fn}(`);
    const block = src.slice(src.indexOf('jsonb_build_object(', from), src.indexOf(') AS row', from));
    return new Set([...block.matchAll(new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)`, 'g'))].map((m) => m[1]!));
  };
  return { gl_journal_entries: rowOf('journalRows', 'je'), gl_journal_lines: rowOf('lineRows', 'jl') };
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort(compareMigrationNames)
  .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS, name), 'utf8') }));
const migrations = () => migrationFiles().map((f) => f.sql);

describe('frozen columns, read from the migrations', () => {
  it('reads ADD / RENAME / DROP COLUMN in any spelling the migrations use', () => {
    const got = addedColumns([
      'ALTER TABLE gl_journal_lines ADD COLUMN IF NOT EXISTS brk_new_amount NUMERIC(15,2);',
      'alter table public.gl_journal_entries\n  add column a text,\n  ADD b uuid, ADD CONSTRAINT x CHECK (true);',
      "-- ALTER TABLE gl_journal_entries ADD COLUMN commented_out TEXT;\nALTER TABLE ONLY gl_journal_entries ALTER COLUMN a DROP DEFAULT;",
      'ALTER TABLE gl_journal_entries RENAME COLUMN b TO c; ALTER TABLE IF EXISTS gl_journal_entries DROP COLUMN IF EXISTS a;',
      "DO $$ BEGIN EXECUTE 'ALTER TABLE gl_journal_lines ADD COLUMN dyn TEXT'; END $$;",
      // Breaker r3 C1's spellings: quoted names, public."…", and a ';' inside a literal before the ADD.
      'ALTER TABLE "gl_journal_lines" ADD COLUMN q1 NUMERIC;',
      'ALTER TABLE public."gl_journal_entries" ADD COLUMN q2 NUMERIC;',
      "ALTER TABLE gl_journal_lines ALTER COLUMN description SET DEFAULT 'n/a;', ADD COLUMN q3 NUMERIC;",
      // Breaker r4 L5: a ';' inside a $$ body.
      "ALTER TABLE gl_journal_lines ALTER COLUMN description SET DEFAULT $$n/a;$$, ADD COLUMN q4 NUMERIC;",
      // Breaker r5 N2: a dollar tag with digits.
      "ALTER TABLE gl_journal_lines ALTER COLUMN description SET DEFAULT $t1$n/a;$t1$, ADD COLUMN q5 NUMERIC;",
    ]);
    expect([...got.gl_journal_lines].sort()).toEqual(['brk_new_amount', 'dyn', 'q1', 'q3', 'q4', 'q5']);
    expect([...got.gl_journal_entries].sort()).toEqual(['c', 'q2']);
    expect(unreadable([
      { name: 'format.sql', sql: "DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD COLUMN z NUMERIC', 'gl_journal_lines'); END $$;" },
      { name: 'split.sql', sql: "DO $$ BEGIN EXECUTE 'ALTER TABLE gl_' || 'journal_lines ADD COLUMN z NUMERIC'; END $$;" },
      { name: 'unicode.sql', sql: 'ALTER TABLE U&"gl\\005fjournal_lines" ADD COLUMN z NUMERIC;' },
      { name: 'plain.sql', sql: 'ALTER TABLE gl_journal_lines ADD COLUMN z NUMERIC;' },
      { name: 'like.sql', sql: 'CREATE TABLE gl_journal_lines_new (LIKE gl_journal_lines INCLUDING ALL, z NUMERIC);' },
      { name: 'swap.sql', sql: 'ALTER TABLE gl_journal_lines_new RENAME TO gl_journal_lines;' },
    ])).toEqual(['format.sql', 'split.sql', 'unicode.sql', 'like.sql', 'swap.sql']);
  });

  it('no new migration uses dynamic SQL near the journal tables, or a U& identifier, the census cannot read', () => {
    expect(unreadable(migrationFiles()).filter((name) => !READ_BY_HAND.has(name))).toEqual([]);
  });

  it('every column a migration adds to gl_journal_entries / gl_journal_lines is frozen or named as not material', () => {
    const added = addedColumns(migrations());
    const frozen = frozenColumns();
    expect(frozen.gl_journal_entries.size).toBeGreaterThan(20);
    expect(frozen.gl_journal_lines.size).toBeGreaterThan(8);
    for (const table of ['gl_journal_entries', 'gl_journal_lines'] as const) {
      const unaccounted = [...added[table]].filter((col) =>
        !frozen[table].has(col) && !frozen[table].has(RENAMED[col] ?? col) && !(col in NOT_MATERIAL[table])).sort();
      expect(unaccounted, `${table}: added by a migration, neither frozen nor listed as not material`).toEqual([]);
    }
  });
});
