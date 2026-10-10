/**
 * Shared seed for the cost-centre pick suites (gl/dimensions/costCentrePick):
 * the late-claim fixture company with a route user, an employee and a
 * reimbursement account, plus the centres the rule tells apart —
 *   FT, HT: active CC1s · PH: a project under HT · OLD: an inactive CC1 ·
 *   UNT: an untyped centre · FX: another company's CC1.
 */
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { dropLateFixture, seedLateFixture, type LateFixture } from './vatLateClaimFixture';
import { dropRouteUser, seedRouteUser } from './vatLateClaimRoutes';

type Row = Record<string, unknown>;
export type Leg = { cc1: string | null; cc2: string | null; legacy: string | null; net: number };

export interface PickFixture {
  fx: LateFixture;
  token: string;
  reimbursementId: string;
  employeeId: string;
  otherCompany: string;
  FT: string; HT: string; PH: string; INACTIVE: string; UNTYPED: string; FOREIGN: string;
}

export async function seedPickFixture(prefix: string, databaseUrl: string): Promise<PickFixture> {
  const fx = await seedLateFixture(prefix, databaseUrl);
  const token = await seedRouteUser(fx, prefix.toLowerCase());
  const [FT, HT, PH, INACTIVE, UNTYPED, FOREIGN, employeeId, otherCompany] = Array.from({ length: 8 }, () => randomUUID());
  await sql`INSERT INTO companies (id, name) VALUES (${otherCompany}::UUID, ${`${prefix} other ${fx.tag}`})`;
  await sql`
    INSERT INTO cost_centres (id, company_id, code, name, cc_type, parent_id, is_active) VALUES
      (${FT}::UUID, ${fx.companyId}::UUID, 'FT', 'Fibertime', 'cc1', NULL, true),
      (${HT}::UUID, ${fx.companyId}::UUID, 'HT', 'Hometech', 'cc1', NULL, true),
      (${PH}::UUID, ${fx.companyId}::UUID, 'PH', 'Project under HT', 'cc2', ${HT}::UUID, true),
      (${INACTIVE}::UUID, ${fx.companyId}::UUID, 'OLD', 'Withdrawn', 'cc1', NULL, false),
      (${UNTYPED}::UUID, ${fx.companyId}::UUID, 'UNT', 'Untyped', NULL, NULL, true),
      (${FOREIGN}::UUID, ${otherCompany}::UUID, 'FX', 'Other company', 'cc1', NULL, true)`;
  const reimbursementId = String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                             normal_balance, is_active, level)
    VALUES (${fx.companyId}::UUID, '2300', ${`Employee reimbursements ${fx.tag}`}, 'liability',
            'other_current_liability', 'credit', true, 3)
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, employment_type, start_date, status)
    VALUES (${employeeId}::UUID, ${fx.companyId}::UUID, ${`${prefix}-${Date.now() % 1e9}`}, 'Pick', 'Slot', 'permanent', CURRENT_DATE, 'active')`;
  return { fx, token, reimbursementId, employeeId, otherCompany, FT, HT, PH, INACTIVE, UNTYPED, FOREIGN };
}

export async function dropPickFixture(p: PickFixture | undefined): Promise<void> {
  if (!p) return;
  const c = p.fx.companyId;
  await sql`DELETE FROM dimension_tag_batch_lines WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM dimension_tag_batches WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM expense_claim_lines WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM expense_claims WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM payroll_employees WHERE id = ${p.employeeId}::UUID`;
  await sql`DELETE FROM recurring_journals WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM recurring_transaction_templates WHERE company_id = ${c}::UUID`;
  await dropRouteUser(p.fx);
  await sql`UPDATE gl_journal_lines SET cc1_id = NULL, cc2_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`UPDATE supplier_invoice_items SET cc1_id = NULL, cc2_id = NULL WHERE supplier_invoice_id IN (
    SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
  await sql`UPDATE cost_centres SET parent_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM cost_centres WHERE company_id = ANY(${[c, p.otherCompany]}::UUID[])`;
  await sql`DELETE FROM companies WHERE id = ${p.otherCompany}::UUID`;
  await dropLateFixture(p.fx);
}

/** The entry's lines on `account` as (cc1, cc2, legacy cost_center_id, debit − credit), by amount. */
export async function legsOn(p: PickFixture, entryId: string, account: string): Promise<Leg[]> {
  return ((await sql`
    SELECT cc1_id::TEXT AS cc1, cc2_id::TEXT AS cc2, cost_center_id::TEXT AS legacy, (debit - credit)::FLOAT8 AS net
    FROM gl_journal_lines
    WHERE company_id = ${p.fx.companyId}::UUID AND journal_entry_id = ${entryId}::UUID AND gl_account_id = ${account}::UUID
    ORDER BY debit - credit`) as Leg[]);
}

/** True when no line of the entry on `account` carries a CC1, a CC2 or the legacy id. */
export async function bareOn(p: PickFixture, entryId: string, account: string): Promise<boolean> {
  const rows = await legsOn(p, entryId, account);
  return rows.length > 0 && rows.every((r) => r.cc1 === null && r.cc2 === null && r.legacy === null);
}
