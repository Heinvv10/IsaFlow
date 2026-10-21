/**
 * What the target IsaFlow company already has, read for a Sage take-on:
 *
 *   - readTakeOnContext: its chart and role holders, currency, the fiscal year
 *     holding the cut-over date (from fiscal_periods) and closed periods
 *     (TakeOnContext, which the builder checks).
 *   - findPriorTakeOn: whether it already carries a take-on. A second Sage
 *     import would post a second opening trial balance on top of the first
 *     (each import is its own migration session, and an opening-balance re-run
 *     only reverses its own session's entry), so it is refused.
 *
 * Every statement names company_id: the pull job calls readTakeOnContext as
 * the pool role, outside any request and so outside RLS.
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/types/db';
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import { OPENING_BALANCE_DESCRIPTION } from '../core/migrationWizardOpeningBalanceService';
import { findJournalChainHead } from '../shared/journalChainHead';
import { getSystemAccountCandidates } from '../gl/systemAccountResolver';
import type { ClosedPeriod, SystemRole, TakeOnContext } from './sageTakeOnTypes';

const ROLES: readonly SystemRole[] = [
  'bank', 'receivable', 'payable', 'vat_input', 'vat_output', 'retained_earnings',
  'default_revenue', 'default_expense', 'admin_expense',
];

/** `asAtDate` is the cut-over date: the fiscal year read is the one holding it. */
export async function readTakeOnContext(companyId: string, asAtDate: string): Promise<TakeOnContext> {
  const rows = (await sql`
    SELECT account_code, account_name, account_type, account_subtype, is_system_account, is_active
    FROM gl_accounts
    WHERE company_id = ${companyId}::UUID
    ORDER BY account_code
  `) as DbRow[];
  const existingRoles: TakeOnContext['existingRoles'] = {};
  for (const r of rows) {
    const role = String(r.account_subtype ?? '') as SystemRole;
    if (r.is_system_account === true && r.is_active === true && ROLES.includes(role) && !existingRoles[role]) {
      existingRoles[role] = { code: String(r.account_code), name: String(r.account_name), type: String(r.account_type) as GLAccountType };
    }
  }
  // Retained Earnings is where the fold puts this year's profit, so it is the
  // holder the year-end close will use: the resolver's, not the first by code.
  // Contested (two or more holders) is reported for the builder to refuse.
  delete existingRoles.retained_earnings;
  const contestedRoles: TakeOnContext['contestedRoles'][number][] = [];
  const re = await getSystemAccountCandidates('retained_earnings', companyId);
  if (re.length === 1) {
    existingRoles.retained_earnings = { code: re[0]!.accountCode, name: re[0]!.accountName, type: re[0]!.accountType as GLAccountType };
  } else if (re.length > 1) {
    contestedRoles.push({ role: 'retained_earnings', codes: re.map((a) => a.accountCode).sort() });
  }
  const company = ((await sql`
    SELECT functional_currency, default_currency
    FROM companies WHERE id = ${companyId}::UUID
  `) as DbRow[])[0];
  // The fiscal year holding the cut-over date, as its periods lay it out.
  const year = ((await sql`
    WITH holding AS (
      SELECT fiscal_year FROM fiscal_periods
      WHERE company_id = ${companyId}::UUID AND start_date <= ${asAtDate}::DATE AND end_date >= ${asAtDate}::DATE
      ORDER BY start_date LIMIT 1
    )
    SELECT MIN(p.start_date) AS start_date, MAX(p.end_date) AS end_date
    FROM fiscal_periods p JOIN holding h ON h.fiscal_year = p.fiscal_year
    WHERE p.company_id = ${companyId}::UUID
  `) as DbRow[])[0];
  const periods = (await sql`
    SELECT period_name, start_date, end_date, status
    FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID AND status IN ('closed', 'locked')
    ORDER BY start_date
  `) as DbRow[];
  return {
    takenCodes: rows.map((r) => String(r.account_code)),
    existingRoles,
    homeCurrency: String(company?.functional_currency || company?.default_currency || ''),
    fiscalYear: year?.start_date ? { startDate: fmtDate(year.start_date), endDate: fmtDate(year.end_date) } : null,
    contestedRoles,
    closedPeriods: periods.map((p): ClosedPeriod => ({
      name: String(p.period_name),
      startDate: fmtDate(p.start_date),
      endDate: fmtDate(p.end_date),
      status: p.status === 'locked' ? 'locked' : 'closed',
    })),
  };
}

/**
 * Why this company cannot take another Sage take-on, or null when it can:
 * a Sage pull already imported, or an opening-balance entry (from Sage or the
 * file wizard) still standing in the ledger. Call under lockMigrationImport.
 */
export async function findPriorTakeOn(companyId: string): Promise<string | null> {
  const imported = (await sql`
    SELECT sage_company_name, imported_at FROM sage_connect_pulls
    WHERE company_id = ${companyId}::UUID AND status = 'imported'
    LIMIT 1
  `) as DbRow[];
  if (imported[0]) {
    return `This company already has its books from Sage ("${String(imported[0].sage_company_name ?? 'a Sage company')}", imported ${fmtDate(imported[0].imported_at)}). Import from Sage runs once per company: a second import would count every opening balance twice. If the wrong Sage company was imported, ask IsaFlow support.`;
  }
  // Roots only: a reversal entry carries reversal_of_id. A root never reversed
  // is standing; one that was reversed may stand again (O <- R <- R2), which
  // only its chain can say.
  const roots = (await sql`
    SELECT id, reversed_at, entry_date FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID AND source = 'auto_migration'
      AND description = ${OPENING_BALANCE_DESCRIPTION} AND status = 'posted' AND reversal_of_id IS NULL
    ORDER BY created_at
  `) as DbRow[];
  for (const r of roots) {
    const head = r.reversed_at == null ? null : await findJournalChainHead(companyId, String(r.id));
    if (r.reversed_at == null || (head?.kind === 'head' && head.standing)) {
      return `This company already has opening balances from a migration (dated ${fmtDate(r.entry_date)}). Importing from Sage as well would count them twice. If Sage should replace them, reverse that opening-balance journal (Journal Entries) first, then import.`;
    }
  }
  return null;
}
