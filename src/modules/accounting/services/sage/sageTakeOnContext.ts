/**
 * What the target IsaFlow company already has, read for a Sage take-on:
 *
 *   - readTakeOnContext: its chart and role holders, currency, financial year
 *     start and closed periods (TakeOnContext, which the builder checks).
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
import type { ClosedPeriod, SystemRole, TakeOnContext } from './sageTakeOnTypes';

const ROLES: readonly SystemRole[] = [
  'bank', 'receivable', 'payable', 'vat_input', 'vat_output', 'retained_earnings',
  'default_revenue', 'default_expense', 'admin_expense',
];

/** companies.financial_year_start as a month, or null — the builder reports a missing one rather than assume March. */
function monthOrNull(raw: unknown): number | null {
  const n = Math.trunc(Number(raw));
  return raw !== null && raw !== undefined && raw !== '' && n >= 1 && n <= 12 ? n : null;
}

export async function readTakeOnContext(companyId: string): Promise<TakeOnContext> {
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
  const company = ((await sql`
    SELECT functional_currency, default_currency, financial_year_start
    FROM companies WHERE id = ${companyId}::UUID
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
    fiscalYearStartMonth: monthOrNull(company?.financial_year_start),
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
    return `This company already has its books from Sage ("${String(imported[0].sage_company_name ?? 'a Sage company')}", imported ${fmtDate(imported[0].imported_at)}). A second import would count every opening balance twice. If the first import was the wrong company, reverse its opening balances first, or ask IsaFlow support.`;
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
      return `This company already has opening balances from a migration (dated ${fmtDate(r.entry_date)}). Importing from Sage as well would count them twice. Reverse that opening-balance journal first if Sage should replace it.`;
    }
  }
  return null;
}
