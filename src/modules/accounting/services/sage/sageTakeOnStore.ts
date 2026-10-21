/**
 * Persistence for "Connect to Sage" between review and import
 * (table sage_connect_pulls, migration 898). Stores what was READ from Sage —
 * never the Sage login — and clears it once imported or discarded.
 *
 * Also reads the target company's chart (TakeOnContext) the builder needs.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import type { SagePull } from './sageApiTypes';
import type { SageTakeOn, SystemRole, TakeOnContext } from './sageTakeOnTypes';

const ROLES: readonly SystemRole[] = [
  'bank', 'receivable', 'payable', 'vat_input', 'vat_output', 'retained_earnings',
  'default_revenue', 'default_expense', 'admin_expense',
];

export interface TakeOnSummary {
  sageCompanyName: string;
  asAtDate: string;
  counts: { accounts: number; customers: number; suppliers: number; arInvoices: number; apInvoices: number; openingLines: number };
  totals: SageTakeOn['totals'];
  errors: number;
  warnings: number;
}

export function summarise(t: SageTakeOn): TakeOnSummary {
  return {
    sageCompanyName: t.sageCompany.name,
    asAtDate: t.asAtDate,
    counts: {
      accounts: t.accounts.length,
      customers: t.customers.length,
      suppliers: t.suppliers.length,
      arInvoices: t.arInvoices.length,
      apInvoices: t.apInvoices.length,
      openingLines: t.openingBalances.length,
    },
    totals: t.totals,
    errors: t.issues.filter((i) => i.severity === 'error').length,
    warnings: t.issues.filter((i) => i.severity === 'warning').length,
  };
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
  return { takenCodes: rows.map((r) => String(r.account_code)), existingRoles };
}

export async function savePull(
  companyId: string, userId: string, pull: SagePull, summary: TakeOnSummary,
): Promise<string> {
  const rows = (await sql`
    INSERT INTO sage_connect_pulls (company_id, created_by, sage_company_id, sage_company_name, as_at_date, pull, summary)
    VALUES (${companyId}::UUID, ${userId}::UUID, ${pull.company.id}, ${pull.company.name}, ${pull.asAtDate}::DATE,
            ${JSON.stringify(pull)}::JSONB, ${JSON.stringify(summary)}::JSONB)
    RETURNING id
  `) as DbRow[];
  return String(rows[0]!.id);
}

export interface StoredPull { id: string; status: string; pull: SagePull | null }

/** Locks the row for the rest of the request so two Import clicks cannot both run. */
export async function loadPullForImport(companyId: string, pullId: string): Promise<StoredPull | null> {
  const rows = (await sql`
    SELECT id, status, pull FROM sage_connect_pulls
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[];
  const r = rows[0];
  if (!r) return null;
  const pull = typeof r.pull === 'string' ? (JSON.parse(r.pull) as SagePull) : (r.pull as SagePull | null);
  return { id: String(r.id), status: String(r.status), pull };
}

export async function markImported(companyId: string, pullId: string, sessionId: string, summary: TakeOnSummary): Promise<void> {
  await sql`
    UPDATE sage_connect_pulls
    SET status = 'imported', pull = NULL, migration_session_id = ${sessionId}::UUID,
        summary = ${JSON.stringify(summary)}::JSONB, imported_at = NOW()
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID
  `;
}

export async function discardPull(companyId: string, pullId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE sage_connect_pulls SET status = 'discarded', pull = NULL
    WHERE id = ${pullId}::UUID AND company_id = ${companyId}::UUID AND status = 'ready'
    RETURNING id
  `) as DbRow[];
  return rows.length > 0;
}
