/**
 * The SQL of the wipe plan: one WHERE clause per step, from which the dry-run count, the delete and the cross-tenant check are all
 * built, so they cannot disagree. `$1` is always the company id, never interpolated. (Split from wipePlan.ts, which holds the data.)
 */
import type { WipeStep } from './wipePlan';

export function invoiceRequestWhere(): string {
  return "company_id = $1::uuid AND purpose = 'customer_invoice' AND customer_invoice_id IS NOT NULL";
}

/** The WHERE clause of a step; `$1` is always the company id, never interpolated. */
export function stepWhere(step: WipeStep): string {
  const scope = step.via
    ? [...(step.orCompany ? ['company_id = $1::uuid'] : []),
        ...step.via.map(([col, parent]) => `${col} IN (SELECT id FROM ${parent} WHERE company_id = $1::uuid)`)].join(' OR ')
    : 'company_id = $1::uuid';
  return step.preserve ? `(${scope}) AND NOT (${step.preserve})` : scope;
}

/**
 * For a child step with more than one foreign key: rows the step would delete (a Demo parent) that ALSO name a
 * parent row of another company. Corrupt data the run refuses rather than deleting another tenant's link silently.
 */
export function crossTenantSql(step: WipeStep): string | null {
  if (!step.via || step.via.length < 2) return null;
  const foreign = step.via.map(([col, parent]) => `${col} IN (SELECT id FROM ${parent} WHERE company_id <> $1::uuid)`).join(' OR ');
  return `SELECT count(*)::int AS n FROM ${step.table} WHERE (${stepWhere(step)}) AND (${foreign})`;
}

export function countSql(step: WipeStep): string {
  return `SELECT count(*)::int AS n FROM ${step.table} WHERE ${stepWhere(step)}`;
}

export function deleteSql(step: WipeStep): string {
  return `DELETE FROM ${step.table} WHERE ${stepWhere(step)}`;
}
