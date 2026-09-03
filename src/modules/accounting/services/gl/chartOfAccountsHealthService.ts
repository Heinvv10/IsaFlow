/**
 * Chart-of-accounts health: the query, and the report it produces.
 *
 * The rules live in `chartOfAccountsHealth.ts` as pure functions. This file
 * reads the chart and assembles the answer.
 *
 * NOTE WHAT IS NOT FILTERED. Every account is read — inactive ones included,
 * and accounts with no postings included. Filtering `is_active` is the exact
 * defect that dropped a dormant account carrying R130,000 from a Caseware
 * export and left it out of balance by that amount, and a chart-health report
 * that hid the inactive accounts could not report the one finding it exists to
 * report.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { validateSystemAccounts } from './systemAccountResolver';
import {
  classifyAccount,
  summariseChart,
  type AccountFinding,
  type ChartAccount,
  type ChartHealthSummary,
} from './chartOfAccountsHealth';

export interface ChartHealthRow {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
  isActive: boolean;
  isSystemAccount: boolean;
  importedFrom: string | null;
  postedLines: number;
  balance: number;
  findings: AccountFinding[];
}

export interface ChartHealthReport {
  asAt: string;
  summary: ChartHealthSummary;
  /** Accounts with at least one finding, worst first. */
  rows: ChartHealthRow[];
  rowsTotal: number;
  /** Every account considered, so completeness is checkable. */
  universeTotal: number;
  /**
   * Roles with no system account at all. Every auto-posting path that needs one
   * throws, so this is a hard failure rather than untidiness.
   */
  missingSystemAccounts: string[];
  postedThrough: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getChartOfAccountsHealth(
  companyId: string,
  asAt: string,
  limit = 100,
): Promise<ChartHealthReport> {
  const rows = (await sql`
    SELECT ga.id::TEXT AS id, ga.account_code, ga.account_name, ga.account_type,
           ga.account_subtype, ga.is_active, ga.is_system_account, ga.imported_from,
           COALESCE(p.lines, 0)::INT AS posted_lines,
           COALESCE(p.balance, 0) AS balance,
           p.last_posted
    FROM gl_accounts ga
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::INT AS lines,
             SUM(jl.debit - jl.credit) AS balance,
             MAX(je.created_at) AS last_posted
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      WHERE jl.gl_account_id = ga.id
        AND jl.company_id = ga.company_id
        AND je.status = 'posted'
        AND je.entry_date <= ${asAt}::DATE
    ) p ON TRUE
    WHERE ga.company_id = ${companyId}::UUID
    ORDER BY ga.account_code
  `) as DbRow[];

  let postedThrough = '';
  const accounts: ChartAccount[] = rows.map((r) => {
    const last = r.last_posted instanceof Date ? r.last_posted.toISOString() : r.last_posted ? String(r.last_posted) : '';
    if (last > postedThrough) postedThrough = last;
    return {
      id: String(r.id),
      accountCode: String(r.account_code ?? ''),
      accountName: String(r.account_name ?? ''),
      accountType: String(r.account_type ?? ''),
      accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
      isActive: r.is_active === true,
      isSystemAccount: r.is_system_account === true,
      importedFrom: r.imported_from == null ? null : String(r.imported_from),
      postedLines: num(r.posted_lines),
      balance: num(r.balance),
    };
  });

  const flagged: ChartHealthRow[] = accounts
    .map((a) => ({ ...a, findings: classifyAccount(a) }))
    .filter((a) => a.findings.length > 0)
    // Findings first, then the largest balances: a mistyped account holding
    // R46m matters more than an empty one, and a reader scanning the first
    // page should see the money.
    .sort((a, b) => b.findings.length - a.findings.length || Math.abs(b.balance) - Math.abs(a.balance));

  return {
    asAt,
    summary: summariseChart(accounts),
    rows: flagged.slice(0, limit),
    rowsTotal: flagged.length,
    universeTotal: accounts.length,
    missingSystemAccounts: await validateSystemAccounts(companyId),
    postedThrough: postedThrough || `${asAt}T00:00:00.000Z`,
  };
}
