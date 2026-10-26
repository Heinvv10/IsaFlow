/**
 * The delete-usage refusal for a business unit, split from businessUnitService
 * (300-line rule). Every count is company-scoped.
 */
import { sql } from '@/lib/neon';
import { BusinessUnitActionError } from './businessUnitService';

/**
 * Throws a counted refusal when anything still carries the BU. The document and
 * default columns (migration 870) and the bank and journal columns (878 / 882, NOT
 * VALID) have RESTRICT FKs; the tag-history columns have none, so only this
 * count protects them. Budget amounts (migration 947) carry a composite FK, so
 * this count turns its 23503 into the same readable refusal.
 */
export async function assertBusinessUnitUnused(companyId: string, id: string): Promise<void> {
  const [row] = (await sql`
    SELECT
      (SELECT COUNT(*) FROM gl_journal_lines jl
        WHERE jl.bu_id = ${id}::UUID AND jl.company_id = ${companyId}::UUID) AS journal_lines,
      (SELECT COUNT(*) FROM bank_transactions bt
        WHERE bt.bu_id = ${id}::UUID AND bt.company_id = ${companyId}::UUID) AS bank_transactions,
      (
        (SELECT COUNT(*) FROM supplier_invoice_items sii
          JOIN supplier_invoices sip ON sip.id = sii.supplier_invoice_id
          WHERE sii.bu_id = ${id}::UUID AND sip.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM customer_invoice_items cii
          JOIN customer_invoices cip ON cip.id = cii.invoice_id
          WHERE cii.bu_id = ${id}::UUID AND cip.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM credit_notes cn
          WHERE cn.bu_id = ${id}::UUID AND cn.company_id = ${companyId}::UUID)
      ) AS documents,
      (
        (SELECT COUNT(*) FROM gl_accounts ga
          WHERE ga.default_bu_id = ${id}::UUID AND ga.company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM supplier_coding_rules scr
          WHERE scr.default_bu_id = ${id}::UUID AND scr.company_id = ${companyId}::UUID)
      ) AS defaults,
      (SELECT COUNT(*) FROM dimension_tag_batch_lines tl
        JOIN dimension_tag_batches tb ON tb.id = tl.batch_id
        WHERE tl.old_bu_id = ${id}::UUID AND tb.reversed_at IS NULL
          AND tb.company_id = ${companyId}::UUID) AS tag_history,
      (SELECT COUNT(*) FROM dimension_tag_batch_bank_rows br
        JOIN dimension_tag_batches tb ON tb.id = br.batch_id
        WHERE br.old_bu_id = ${id}::UUID AND tb.reversed_at IS NULL
          AND tb.company_id = ${companyId}::UUID AND br.company_id = ${companyId}::UUID) AS tag_bank_history,
      (SELECT COUNT(*) FROM budget_month_amounts bm
        WHERE bm.bu_id = ${id}::UUID AND bm.company_id = ${companyId}::UUID) AS budget_amounts
  `) as Record<string, unknown>[];
  const labels: [string, string][] = [
    ['journal_lines', 'journal line(s)'], ['bank_transactions', 'bank transaction(s)'],
    ['documents', 'document line(s)'], ['defaults', 'account default(s)'],
    ['tag_history', 'un-reversed tag batch line(s)'],
    ['tag_bank_history', 'un-reversed tag batch bank row(s)'],
    ['budget_amounts', 'budget amount(s)'],
  ];
  const used = labels
    .map(([key, label]) => [Number(row?.[key] ?? 0), label] as const)
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  if (used.length > 0) {
    throw new BusinessUnitActionError(`Cannot delete business unit that is used by ${used.join(', ')}. Deactivate instead.`);
  }
}
