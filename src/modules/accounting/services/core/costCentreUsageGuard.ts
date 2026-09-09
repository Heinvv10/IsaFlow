/**
 * Cost centre usage guard.
 *
 * A cost centre is referenced from twenty-odd columns. Six carry a foreign key;
 * the rest carry none, so the database cannot refuse a delete that strands them.
 * Migration 649 makes the payroll and asset FKs ON DELETE RESTRICT, and this
 * guard covers the FK-less columns that live code writes, so the operator gets a
 * counted 400 instead of a dangling reference or a raw 23503.
 */

import { sql } from '@/lib/neon';

/** A pg foreign-key violation; the FKs migration 649 made RESTRICT raise this. */
export const FK_VIOLATION = '23503';

export const CANNOT_DELETE_PREFIX = 'Cannot delete cost centre that is used by ';
const CANNOT_DELETE_SUFFIX = '. Deactivate instead.';

/** Falls back to the uncounted wording when the guard did not see the reference. */
export function cannotDeleteMessage(parts: string[]): string {
  const what = parts.length > 0 ? parts.join(', ') : 'other records';
  return `${CANNOT_DELETE_PREFIX}${what}${CANNOT_DELETE_SUFFIX}`;
}

/**
 * Throws when anything still references the centre. Every count is scoped by
 * company_id, so a cross-tenant row is invisible here and is caught by the FK
 * instead — deleteCostCentre maps that 23503 back onto the same message.
 *
 * cost_centre_gl_mappings is deliberately absent: that FK is ON DELETE CASCADE
 * because a mapping has no meaning without its centre. capture_events
 * .resolved_cost_centre_id is absent too — it is an unposted classification
 * hint, so losing it re-triggers classification rather than stranding a posting.
 */
export async function assertCostCentreUnused(companyId: string, id: string): Promise<void> {
  const usage = (await sql`
    SELECT
      (SELECT COUNT(*) FROM gl_journal_lines jl
        WHERE (jl.cost_center_id = ${id}::UUID OR jl.cc1_id = ${id}::UUID OR jl.cc2_id = ${id}::UUID)
          AND jl.company_id = ${companyId}::UUID) AS journal_lines,
      (SELECT COUNT(*) FROM gl_journal_entries je
        WHERE je.cost_center_id = ${id}::UUID AND je.company_id = ${companyId}::UUID) AS journal_entries,
      (SELECT COUNT(*) FROM payroll_employees pe
        WHERE pe.cost_centre_id = ${id}::UUID AND pe.company_id = ${companyId}::UUID) AS employees,
      (SELECT COUNT(*) FROM payroll_employee_cost_allocations pa
        WHERE pa.cost_centre_id = ${id}::UUID AND pa.company_id = ${companyId}::UUID) AS allocations,
      (SELECT COUNT(*) FROM assets a
        WHERE a.cost_centre_id = ${id}::UUID AND a.company_id = ${companyId}::UUID) AS assets,
      (SELECT COUNT(*) FROM cost_centres cc
        WHERE cc.parent_id = ${id}::UUID AND cc.company_id = ${companyId}::UUID) AS children,
      (
        (SELECT COUNT(*) FROM supplier_invoices si
          WHERE si.cost_center_id = ${id}::UUID AND si.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM supplier_invoice_items sii
          JOIN supplier_invoices sip ON sip.id = sii.supplier_invoice_id
          WHERE sii.cost_center_id = ${id}::UUID AND sip.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM credit_notes cn
          WHERE cn.cost_center_id = ${id}::UUID AND cn.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM customer_payments cp
          WHERE cp.cost_center_id = ${id}::UUID AND cp.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM supplier_payments sp
          WHERE sp.cost_center_id = ${id}::UUID AND sp.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM supplier_purchase_orders po
          WHERE po.cost_center_id = ${id}::UUID AND po.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM expense_claim_lines ecl
          WHERE ecl.cost_centre_id = ${id}::UUID AND ecl.company_id = ${companyId}::UUID)
      ) AS documents,
      (
        (SELECT COUNT(*) FROM supplier_coding_rules scr
          WHERE scr.default_cost_centre_id = ${id}::UUID AND scr.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM supplier_coding_history sch
          WHERE sch.cost_centre_id = ${id}::UUID AND sch.company_id = ${companyId}::UUID)
      ) AS coding_rules
  `) as Record<string, unknown>[];

  const row = usage[0] ?? {};
  const labels: [string, string][] = [
    ['journal_lines', 'journal line(s)'],
    ['journal_entries', 'journal entry(ies)'],
    ['employees', 'employee(s)'],
    ['allocations', 'employee allocation(s)'],
    ['assets', 'asset(s)'],
    ['children', 'child cost centre(s)'],
    ['documents', 'document(s)'],
    ['coding_rules', 'coding rule(s)'],
  ];
  const used = labels
    .map(([key, label]) => [Number(row[key] ?? 0), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (used.length > 0) throw new Error(cannotDeleteMessage(used));
}
