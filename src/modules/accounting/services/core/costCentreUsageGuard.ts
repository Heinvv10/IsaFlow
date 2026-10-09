/**
 * Cost centre usage guard.
 *
 * A cost centre is referenced from twenty-odd columns. Six carry a foreign key;
 * the rest carry none, so the database cannot refuse a delete that strands them.
 * Migration 649 makes the payroll and asset FKs ON DELETE RESTRICT, and this
 * guard covers the FK-less columns that live code writes, so the operator gets a
 * counted 400 instead of a dangling reference or a raw 23503.
 *
 * The FK-less counts take no locks, so a row written against the centre between
 * the count and the DELETE is still stranded; only more foreign keys can close
 * that window. The FK-backed columns are immune because the database re-checks
 * at delete time — since migration 878 that includes the journal and bank
 * cc1_id / cc2_id (NOT VALID: checked for every new row, not for old ones).
 */

import { sql } from '@/lib/neon';

/** A pg foreign-key violation; the FKs migration 649 made RESTRICT raise this. */
export const FK_VIOLATION = '23503';

/**
 * A refusal written for the operator, not an internal failure. The action route
 * genericises every other error to 'Action failed' (pentest H16), which would
 * throw away the counted message this guard exists to produce, so the messages
 * that are safe to read carry this type instead of being matched by string.
 */
export class CostCentreActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostCentreActionError';
  }
}

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
      -- The CC1 / CC2 columns migration 870 put on the documents.
      + (SELECT COUNT(*) FROM supplier_invoice_items sii
          JOIN supplier_invoices sip ON sip.id = sii.supplier_invoice_id
          WHERE (sii.cc1_id = ${id}::UUID OR sii.cc2_id = ${id}::UUID) AND sip.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM customer_invoice_items cii
          JOIN customer_invoices cip ON cip.id = cii.invoice_id
          WHERE (cii.cc1_id = ${id}::UUID OR cii.cc2_id = ${id}::UUID) AND cip.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM credit_notes cn
          WHERE (cn.cc1_id = ${id}::UUID OR cn.cc2_id = ${id}::UUID) AND cn.company_id = ${companyId}::UUID)
      ) AS documents,
      (SELECT COUNT(*) FROM bank_transactions bt
        WHERE (bt.cc1_id = ${id}::UUID OR bt.cc2_id = ${id}::UUID)
          AND bt.company_id = ${companyId}::UUID) AS bank_transactions,
      (
        (SELECT COUNT(*) FROM supplier_coding_rules scr
          WHERE scr.default_cost_centre_id = ${id}::UUID AND scr.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM supplier_coding_history sch
          WHERE sch.cost_centre_id = ${id}::UUID AND sch.company_id = ${companyId}::UUID)
      ) AS coding_rules,
      (
        (SELECT COUNT(*) FROM customers cu
          WHERE cu.default_cc1_id = ${id}::UUID AND cu.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM gl_accounts ga
          WHERE (ga.default_cc1_id = ${id}::UUID OR ga.default_cc2_id = ${id}::UUID)
            AND ga.company_id = ${companyId}::UUID)
      ) AS defaults,
      -- No FK: an un-reversed tag batch would restore this id on reversal.
      (SELECT COUNT(*) FROM dimension_tag_batch_lines tl
        JOIN dimension_tag_batches tb ON tb.id = tl.batch_id
        WHERE (tl.old_cc1_id = ${id}::UUID OR tl.old_cc2_id = ${id}::UUID)
          AND tb.reversed_at IS NULL AND tb.company_id = ${companyId}::UUID) AS tag_history
      -- payroll_employee_history is deliberately NOT counted. Its old_value /
      -- new_value hold a cost_centre_id as display-only TEXT: nothing joins it
      -- back, posts from it or restores it, so a deleted id there strands
      -- nothing. Counting it would make every centre ever assigned to anyone
      -- undeletable for good (#683 review round 2).
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
    ['bank_transactions', 'bank transaction(s)'],
    ['coding_rules', 'coding rule(s)'],
    ['defaults', 'customer/account default(s)'],
    ['tag_history', 'un-reversed tag batch line(s)'],
  ];
  const used = labels
    .map(([key, label]) => [Number(row[key] ?? 0), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (used.length > 0) throw new CostCentreActionError(cannotDeleteMessage(used));
}

/**
 * How many lines, documents, defaults and un-reversed tag lines carry any of
 * these cost centres AS A CC2. Each of them stored the CC1 that was derived when
 * it was written, so moving the CC2 under another FNO would leave that CC1 wrong.
 */
export async function countCc2Carriers(companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const [row] = (await sql`
    SELECT
      (SELECT COUNT(*) FROM gl_journal_lines jl
        WHERE jl.cc2_id = ANY(${ids}::UUID[]) AND jl.company_id = ${companyId}::UUID)
    + (SELECT COUNT(*) FROM bank_transactions bt
        WHERE bt.cc2_id = ANY(${ids}::UUID[]) AND bt.company_id = ${companyId}::UUID)
    + (SELECT COUNT(*) FROM supplier_invoice_items sii
        JOIN supplier_invoices sip ON sip.id = sii.supplier_invoice_id
        WHERE sii.cc2_id = ANY(${ids}::UUID[]) AND sip.company_id = ${companyId}::UUID)
    + (SELECT COUNT(*) FROM customer_invoice_items cii
        JOIN customer_invoices cip ON cip.id = cii.invoice_id
        WHERE cii.cc2_id = ANY(${ids}::UUID[]) AND cip.company_id = ${companyId}::UUID)
    + (SELECT COUNT(*) FROM credit_notes cn
        WHERE cn.cc2_id = ANY(${ids}::UUID[]) AND cn.company_id = ${companyId}::UUID)
    + (SELECT COUNT(*) FROM gl_accounts ga
        WHERE ga.default_cc2_id = ANY(${ids}::UUID[]) AND ga.company_id = ${companyId}::UUID)
    + (SELECT COUNT(*) FROM dimension_tag_batch_lines tl
        JOIN dimension_tag_batches tb ON tb.id = tl.batch_id
        WHERE tl.old_cc2_id = ANY(${ids}::UUID[]) AND tb.reversed_at IS NULL
          AND tb.company_id = ${companyId}::UUID) AS carriers
  `) as { carriers: unknown }[];
  return Number(row?.carriers ?? 0);
}

/**
 * The defaults that name this cost centre, as the deactivation refusal words
 * them ('' when none): a default pointing at an inactive centre would put it
 * back on every new line, document and coding suggestion that takes it.
 */
export async function costCentreDefaultUsage(companyId: string, id: string): Promise<string> {
  const [row] = (await sql`
    SELECT
      (SELECT COUNT(*) FROM customers cu
        WHERE cu.default_cc1_id = ${id}::UUID AND cu.company_id = ${companyId}::UUID) AS customers,
      (SELECT COUNT(*) FROM gl_accounts ga
        WHERE (ga.default_cc1_id = ${id}::UUID OR ga.default_cc2_id = ${id}::UUID)
          AND ga.company_id = ${companyId}::UUID) AS accounts,
      (SELECT COUNT(*) FROM supplier_coding_rules scr
        WHERE scr.default_cost_centre_id = ${id}::UUID AND scr.company_id = ${companyId}::UUID) AS coding_rules
  `) as Record<string, unknown>[];
  return countedParts(row, [['customers', 'customer(s)'], ['accounts', 'account(s)'], ['coding_rules', 'supplier coding rule(s)']]);
}

/** "2 customer(s), 1 account(s)" from the non-zero counts, in label order. */
export function countedParts(row: Record<string, unknown> | undefined, labels: [string, string][]): string {
  return labels
    .map(([key, label]) => [Number(row?.[key] ?? 0), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(', ');
}
