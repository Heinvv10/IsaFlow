/**
 * Consolidation Service
 *
 * Manages direct parent-child company relationships and produces consolidated
 * trial balances by aggregating GL data across group entities.
 *
 * NOTE: This is the lightweight "company_relationships" model.
 * The full group-reporting model (company_groups / company_group_members) is
 * in consolidatedTrialBalanceService.ts / consolidatedReportingService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  GroupCompany,
  ConsolidatedAccount,
  ConsolidatedTrialBalance,
  IntercompanyBalance,
} from './consolidationTypes';

export {
  createCompanyRelationship,
  deleteCompanyRelationship,
} from './companyRelationshipService';

export type {
  GroupCompany,
  ConsolidatedAccount,
  ConsolidatedTrialBalance,
  IntercompanyBalance,
};

type Row = DbRow;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Returns all child company IDs for a given parent (does NOT include self). */
async function getChildCompanyIds(parentCompanyId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT child_company_id
    FROM company_relationships
    WHERE parent_company_id = ${parentCompanyId}::UUID
      AND deleted_at IS NULL
    ORDER BY created_at
  `) as Row[];
  return rows.map((r) => String(r.child_company_id));
}

/** Returns eliminated account types for a given parent+period. */
async function getEliminatedTypes(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Set<string>> {
  const rows = (await sql`
    SELECT DISTINCT elimination_type
    FROM intercompany_eliminations
    WHERE group_company_id = ${companyId}::UUID
      AND period_start <= ${periodEnd}
      AND period_end   >= ${periodStart}
  `) as Row[];
  return new Set(rows.map((r) => String(r.elimination_type)));
}

function isAccountEliminated(accountType: string, eliminatedTypes: Set<string>): boolean {
  const t = accountType.toLowerCase();
  if (eliminatedTypes.has('receivable_payable') && ['asset', 'liability'].includes(t)) return true;
  if (eliminatedTypes.has('revenue_expense')    && ['income', 'expense'].includes(t)) return true;
  if (eliminatedTypes.has('investment_equity')  && ['equity'].includes(t))             return true;
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the parent company itself plus all direct subsidiaries/branches.
 * The parent row is included first with ownershipPercent = 100.
 */
export async function getGroupCompanies(companyId: string): Promise<GroupCompany[]> {
  try {
    const selfRows = (await sql`
      SELECT id, name FROM companies WHERE id = ${companyId}::UUID
    `) as Row[];

    if (selfRows.length === 0) throw new Error(`Company ${companyId} not found`);

    const parent: GroupCompany = {
      id: String(selfRows[0]!.id),
      name: String(selfRows[0]!.name),
      relationshipType: 'parent',
      ownershipPercent: 100,
    };

    const childRows = (await sql`
      SELECT cr.child_company_id AS id, c.name,
             cr.relationship_type, cr.ownership_percent
      FROM company_relationships cr
      JOIN companies c ON c.id = cr.child_company_id
      WHERE cr.parent_company_id = ${companyId}::UUID
        AND cr.deleted_at IS NULL
      ORDER BY c.name
    `) as Row[];

    const children: GroupCompany[] = childRows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      relationshipType: String(r.relationship_type),
      ownershipPercent: Number(r.ownership_percent),
    }));

    return [parent, ...children];
  } catch (err) {
    log.error('getGroupCompanies failed', { companyId, error: err }, 'consolidation');
    throw err;
  }
}

/**
 * Consolidated trial balance: merges GL data from parent + all subsidiaries.
 * Accounts that have a matching intercompany elimination are flagged isEliminated.
 */
export async function getConsolidatedTrialBalance(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<ConsolidatedTrialBalance> {
  try {
    const groupCompanies = await getGroupCompanies(companyId);
    const allIds = groupCompanies.map((g) => g.id);
    const entities = groupCompanies.map((g) => ({ companyId: g.id, companyName: g.name }));
    const eliminatedTypes = await getEliminatedTypes(companyId, periodStart, periodEnd);

    const accountMap = new Map<string, ConsolidatedAccount>();

    for (const entity of groupCompanies) {
      const rows = (await sql`
        SELECT
          ga.account_code,
          ga.account_name,
          ga.account_type,
          COALESCE(SUM(jl.debit),  0) AS total_debit,
          COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga        ON ga.id = jl.gl_account_id
        WHERE je.status      = 'posted'
          AND je.company_id  = ${entity.id}::UUID
          AND jl.company_id  = ${entity.id}::UUID
          AND ga.company_id  = ${entity.id}::UUID
          AND je.entry_date >= ${periodStart}
          AND je.entry_date <= ${periodEnd}
        GROUP BY ga.account_code, ga.account_name, ga.account_type
        HAVING COALESCE(SUM(jl.debit), 0) != 0 OR COALESCE(SUM(jl.credit), 0) != 0
        ORDER BY ga.account_code
      `) as Row[];

      for (const r of rows) {
        const key    = `${String(r.account_code)}|${String(r.account_type)}`;
        const debit  = Number(r.total_debit);
        const credit = Number(r.total_credit);

        let acc = accountMap.get(key);
        if (!acc) {
          acc = {
            accountCode: String(r.account_code),
            accountName: String(r.account_name),
            accountType: String(r.account_type),
            byEntity: {},
            totalDebit: 0,
            totalCredit: 0,
            isEliminated: isAccountEliminated(String(r.account_type), eliminatedTypes),
          };
          accountMap.set(key, acc);
        }
        const prev = acc.byEntity[entity.id] ?? { debit: 0, credit: 0 };
        acc.byEntity[entity.id] = { debit: prev.debit + debit, credit: prev.credit + credit };
        acc.totalDebit  += debit;
        acc.totalCredit += credit;
      }
    }

    // Ensure all entity columns present (even zeros)
    for (const acc of accountMap.values()) {
      for (const id of allIds) {
        if (!acc.byEntity[id]) acc.byEntity[id] = { debit: 0, credit: 0 };
      }
    }

    const accounts    = Array.from(accountMap.values()).sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    const totalDebits  = accounts.reduce((s, a) => s + a.totalDebit,  0);
    const totalCredits = accounts.reduce((s, a) => s + a.totalCredit, 0);

    return {
      groupName: groupCompanies[0]?.name ?? companyId,
      periodStart,
      periodEnd,
      entities,
      accounts,
      totalDebits,
      totalCredits,
    };
  } catch (err) {
    log.error('getConsolidatedTrialBalance failed', { companyId, periodStart, periodEnd, error: err }, 'consolidation');
    throw err;
  }
}

/**
 * Returns intercompany elimination balances between group entities for the period.
 * Scoped strictly to the parent company_id (IDOR safe).
 */
export async function getIntercompanyBalances(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<IntercompanyBalance[]> {
  try {
    const childIds = await getChildCompanyIds(companyId);
    if (childIds.length === 0) return [];

    const rows = (await sql`
      SELECT
        ie.from_company_id,
        fc.name AS from_company_name,
        ie.to_company_id,
        tc.name AS to_company_name,
        ie.elimination_type,
        ie.amount,
        ie.description
      FROM intercompany_eliminations ie
      JOIN companies fc ON fc.id = ie.from_company_id
      JOIN companies tc ON tc.id = ie.to_company_id
      WHERE ie.group_company_id = ${companyId}::UUID
        AND ie.period_start <= ${periodEnd}
        AND ie.period_end   >= ${periodStart}
      ORDER BY ie.elimination_type, ie.amount DESC
    `) as Row[];

    return rows.map((r) => ({
      fromCompanyId:   String(r.from_company_id),
      fromCompanyName: String(r.from_company_name),
      toCompanyId:     String(r.to_company_id),
      toCompanyName:   String(r.to_company_name),
      eliminationType: String(r.elimination_type),
      amount:          Number(r.amount),
      description:     r.description != null ? String(r.description) : null,
    }));
  } catch (err) {
    log.error('getIntercompanyBalances failed', { companyId, periodStart, periodEnd, error: err }, 'consolidation');
    throw err;
  }
}
