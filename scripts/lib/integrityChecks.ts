/**
 * Core double-entry / referential-integrity checks.
 * Tenant-isolation + balance-cache checks live in integrityChecksTenant.ts.
 */
import type { CheckResult, IntegrityCheck, IntegritySql } from './integrityTypes';
import { fmt, plural } from './integrityTypes';

export const coreChecks: IntegrityCheck[] = [
  // 1 — Journal entry balance (per entry)
  async (sql: IntegritySql): Promise<CheckResult> => {
    const rows = (await sql`
      SELECT je.id, je.entry_number, je.company_id, je.entry_date,
             SUM(jl.debit) AS total_debit, SUM(jl.credit) AS total_credit,
             ABS(SUM(jl.debit) - SUM(jl.credit)) AS imbalance
      FROM gl_journal_entries je
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      WHERE je.status = 'posted'
      GROUP BY je.id, je.entry_number, je.company_id, je.entry_date
      HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) > 0.01
      ORDER BY imbalance DESC LIMIT 20
    `) as Array<Record<string, string>>;
    if (rows.length === 0) return { label: 'JE balance (per entry)', status: 'pass', detail: '0 unbalanced entries' };
    return {
      label: 'JE balance (per entry)', status: 'fail',
      detail: `${rows.length} unbalanced ${plural(rows.length, 'entry', 'entries')}`,
      lines: rows.map((r) => `entry=${r.entry_number ?? r.id}  company=${String(r.company_id).slice(0, 8)}  date=${r.entry_date}  dr=${fmt(r.total_debit)}  cr=${fmt(r.total_credit)}  off=${fmt(r.imbalance)}`),
    };
  },

  // 2 — Overall TB balance per company
  async (sql: IntegritySql): Promise<CheckResult> => {
    const rows = (await sql`
      SELECT je.company_id,
             ROUND(SUM(jl.debit)::numeric, 2) AS total_debits,
             ROUND(SUM(jl.credit)::numeric, 2) AS total_credits,
             ROUND(ABS(SUM(jl.debit) - SUM(jl.credit))::numeric, 2) AS imbalance
      FROM gl_journal_entries je
      JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
      WHERE je.status = 'posted'
      GROUP BY je.company_id
      HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) > 0.01
    `) as Array<Record<string, string>>;
    if (rows.length === 0) return { label: 'Overall TB balance (per company)', status: 'pass', detail: '0 companies with imbalance' };
    return {
      label: 'Overall TB balance (per company)', status: 'fail',
      detail: `${rows.length} ${plural(rows.length, 'company', 'companies')} with imbalance`,
      lines: rows.map((r) => `company_id=${String(r.company_id).slice(0, 8)}  debits=${fmt(r.total_debits)}  credits=${fmt(r.total_credits)}  off=${fmt(r.imbalance)}`),
    };
  },

  // 3 — Orphaned journal lines
  async (sql: IntegritySql): Promise<CheckResult> => {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM gl_journal_lines jl
      LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.id IS NULL
    `) as Array<{ cnt: number }>;
    const cnt = row?.cnt ?? 0;
    return cnt === 0
      ? { label: 'Orphaned journal lines', status: 'pass', detail: '0 lines without a parent JE' }
      : { label: 'Orphaned journal lines', status: 'fail', detail: `${cnt} ${plural(cnt, 'line', 'lines')} have no parent JE` };
  },

  // 4 — Journal lines referencing invalid GL accounts
  async (sql: IntegritySql): Promise<CheckResult> => {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM gl_journal_lines jl
      LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE ga.id IS NULL
    `) as Array<{ cnt: number }>;
    const cnt = row?.cnt ?? 0;
    return cnt === 0
      ? { label: 'JE lines → valid GL accounts', status: 'pass', detail: '0 lines with missing GL account' }
      : { label: 'JE lines → valid GL accounts', status: 'fail', detail: `${cnt} ${plural(cnt, 'line', 'lines')} reference a non-existent GL account` };
  },

  // 5 — Bank transactions referencing invalid bank accounts
  async (sql: IntegritySql): Promise<CheckResult> => {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM bank_transactions bt
      LEFT JOIN gl_accounts ga ON ga.id = bt.bank_account_id
      WHERE ga.id IS NULL
    `) as Array<{ cnt: number }>;
    const cnt = row?.cnt ?? 0;
    return cnt === 0
      ? { label: 'Bank txns → valid bank accounts', status: 'pass', detail: '0 transactions with missing bank account' }
      : { label: 'Bank txns → valid bank accounts', status: 'fail', detail: `${cnt} ${plural(cnt, 'transaction', 'transactions')} reference a non-existent GL account` };
  },

  // 6 — Duplicate journal entry numbers per company
  async (sql: IntegritySql): Promise<CheckResult> => {
    const rows = (await sql`
      SELECT company_id, entry_number, COUNT(*)::int AS cnt
      FROM gl_journal_entries WHERE entry_number IS NOT NULL
      GROUP BY company_id, entry_number HAVING COUNT(*) > 1
      ORDER BY cnt DESC LIMIT 10
    `) as Array<{ company_id: string; entry_number: string; cnt: number }>;
    if (rows.length === 0) return { label: 'Duplicate JE numbers', status: 'pass', detail: '0 duplicate entry numbers per company' };
    const dups = rows.reduce((s, r) => s + r.cnt, 0);
    return {
      label: 'Duplicate JE numbers', status: 'fail',
      detail: `${rows.length} duplicate ${plural(rows.length, 'group', 'groups')} (${dups} entries involved)`,
      lines: rows.map((r) => `company=${r.company_id.slice(0, 8)}  entry_number=${r.entry_number}  count=${r.cnt}`),
    };
  },

  // 7 — Reconciled bank txns with no journal linkage.
  //     A reconciled txn must carry either a matched_journal_line_id (normal
  //     match, inherited through matched -> reconciled) OR a
  //     transfer_journal_entry_id (transfer reconciliations link via the JE,
  //     not a single line). Exempting transfers avoids false positives.
  async (sql: IntegritySql): Promise<CheckResult> => {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM bank_transactions
      WHERE status = 'reconciled'
        AND matched_journal_line_id IS NULL
        AND transfer_journal_entry_id IS NULL
    `) as Array<{ cnt: number }>;
    const cnt = row?.cnt ?? 0;
    return cnt === 0
      ? { label: 'Reconciled txns have journal match', status: 'pass', detail: '0 reconciled transactions missing a journal line or transfer' }
      : { label: 'Reconciled txns have journal match', status: 'fail', detail: `${cnt} reconciled ${plural(cnt, 'transaction', 'transactions')} have neither a matched line nor a transfer JE` };
  },

  // 8 — GL accounts with invalid parent references
  async (sql: IntegritySql): Promise<CheckResult> => {
    const [row] = (await sql`
      SELECT COUNT(*)::int AS cnt FROM gl_accounts ga
      WHERE ga.parent_account_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM gl_accounts p WHERE p.id = ga.parent_account_id)
    `) as Array<{ cnt: number }>;
    const cnt = row?.cnt ?? 0;
    return cnt === 0
      ? { label: 'GL account parent refs', status: 'pass', detail: '0 accounts with a broken parent reference' }
      : { label: 'GL account parent refs', status: 'fail', detail: `${cnt} ${plural(cnt, 'account', 'accounts')} point to a non-existent parent` };
  },

  // 9 — Company-level summary stats (informational)
  async (sql: IntegritySql): Promise<CheckResult> => {
    const companies = (await sql`
      SELECT id, name FROM companies WHERE is_active = true ORDER BY name
    `) as Array<{ id: string; name: string }>;
    if (companies.length === 0) {
      return { label: 'Company-level summary stats', status: 'info', lines: ['(no active companies found)'] };
    }
    const lines: string[] = [];
    for (const co of companies) {
      const [s] = (await sql`
        SELECT
          (SELECT COUNT(*)::int FROM gl_journal_entries WHERE company_id = ${co.id}::UUID AND status = 'posted') AS posted_jes,
          (SELECT COUNT(*)::int FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id WHERE je.company_id = ${co.id}::UUID AND je.status = 'posted') AS je_lines,
          (SELECT COUNT(*)::int FROM bank_transactions WHERE company_id = ${co.id}::UUID) AS bank_txns,
          (SELECT COUNT(*)::int FROM bank_categorisation_rules WHERE company_id = ${co.id}::UUID) AS bank_rules
      `) as Array<{ posted_jes: number; je_lines: number; bank_txns: number; bank_rules: number }>;
      if (s) lines.push(`${co.name.padEnd(30)}  JEs=${String(s.posted_jes).padStart(6)}  lines=${String(s.je_lines).padStart(7)}  bank_txns=${String(s.bank_txns).padStart(6)}  bank_rules=${String(s.bank_rules).padStart(4)}`);
    }
    return { label: 'Company-level summary stats', status: 'info', lines };
  },
];
