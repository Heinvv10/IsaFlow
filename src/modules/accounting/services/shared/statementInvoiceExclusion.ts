/**
 * Classifies one invoice/bill candidate row for a statement (customer or
 * supplier) into its transaction list or its `excluded` bucket, with a
 * machine-stable reason and an accurate detail sentence per status.
 *
 * ONE definition, used by both `ar/statementEmailService` and
 * `ap/supplierStatementService` (R-082 round 2 gave each its own copy of the
 * reason map; round 3's review found the two could drift, and that the
 * shared "not yet issued" detail text was wrong for a cancelled document —
 * one was issued and then voided, the other two never were). Both statement
 * builders were also over the 300-line file cap; extracting this is a size
 * fix with no behaviour change, not a new feature.
 */
import type { DbRow } from '@/lib/neon';
import { documentInPopulation } from './documentPopulation';

type ExcludableInvoice = DbRow;

export interface StatementInvoiceExclusion {
  id: string;
  reason: string;
  detail: string;
  amount: number;
  documentNumber: string;
}

/** Machine-stable reason AND an accurate detail sentence, per excluded status. */
const EXCLUSION_TEXT: Record<string, { reason: string; detail: string }> = {
  draft: {
    reason: 'invoice_draft',
    detail: `is 'draft'; it has not yet been issued and is not on the statement.`,
  },
  pending_approval: {
    reason: 'invoice_pending_approval',
    detail: `is 'pending_approval'; it has not yet been issued and is not on the statement.`,
  },
  cancelled: {
    reason: 'invoice_cancelled',
    detail: `is 'cancelled'; it was issued and then voided, and is not on the statement.`,
  },
};

/**
 * Returns the exclusion row when `inv`'s status puts it outside the ageing's
 * population (shared/documentPopulation), or `null` when it belongs on the
 * statement. `noun` is "Invoice" or "Bill", for the detail sentence.
 */
export function classifyStatementInvoice(
  inv: ExcludableInvoice,
  noun: 'Invoice' | 'Bill',
): StatementInvoiceExclusion | null {
  if (documentInPopulation(inv.status as string | null)) return null;
  const status = String(inv.status ?? '');
  const text = EXCLUSION_TEXT[status];
  return {
    id: String(inv.id),
    reason: text?.reason ?? 'invoice_not_issued',
    detail: `${noun} ${text?.detail ?? `is '${status}'; it is not on the statement.`}`,
    amount: Number(inv.total_amount),
    documentNumber: String(inv.invoice_number ?? ''),
  };
}
