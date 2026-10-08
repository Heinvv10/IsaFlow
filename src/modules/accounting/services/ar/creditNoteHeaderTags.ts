/**
 * What a CUSTOMER credit note's own header tags (job `project_id`, CC1 / CC2 /
 * BU) do at posting — one rule, checked at create and again at approve, both
 * before the first write:
 *
 *  - LINKED to an invoice: nothing. The note reverses the invoice journal's own
 *    revenue legs, on all five dimensions (invoiceRevenuePosting), so a header
 *    tag could never post — and ignoring it would leave the note saying one
 *    thing while the ledger says another. It is REFUSED instead
 *    (CREDIT_NOTE_DIMENSIONS_REFUSED).
 *  - UNLINKED: they post on its one revenue debit (870's rule for CC1 / CC2 /
 *    BU, extended to the job so Project Profitability sees the credit). The
 *    job must be this company's and not cancelled — `credit_notes.project_id`
 *    was stored unchecked before 873.
 *
 * Supplier notes are unaffected (their CC1 / CC2 / BU ride on the expense leg,
 * as 870 posts them).
 */
import { sql } from '@/lib/neon';
import type { LegTags } from './invoiceRevenueLines';

export class CreditNoteDimensionRefusal extends Error {
  readonly code = 'CREDIT_NOTE_DIMENSIONS_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'CreditNoteDimensionRefusal';
  }
}

export interface CreditNoteHeader {
  customerInvoiceId: string | null;
  projectId: string | null;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

const id = (v: unknown): string | null => (v == null || v === '' ? null : String(v).toLowerCase());

/** The header as a stored credit_notes row carries it. */
export function creditNoteHeaderOf(row: Record<string, unknown>): CreditNoteHeader {
  return {
    customerInvoiceId: id(row.customer_invoice_id),
    projectId: id(row.project_id),
    cc1Id: id(row.cc1_id),
    cc2Id: id(row.cc2_id),
    buId: id(row.bu_id),
  };
}

/** The tags the note's revenue debit carries (none when linked), or a CreditNoteDimensionRefusal. */
export async function creditNoteHeaderTags(companyId: string, note: CreditNoteHeader): Promise<LegTags> {
  const tags: LegTags = { projectId: note.projectId, cc1Id: note.cc1Id, cc2Id: note.cc2Id, buId: note.buId };
  if (note.customerInvoiceId) {
    if (Object.values(tags).some((v) => v !== null)) {
      throw new CreditNoteDimensionRefusal(
        'A credit note linked to an invoice reverses that invoice\'s own revenue lines, so its job, CC1, CC2 and BU '
        + 'come from the invoice and cannot be set on the note. Leave them empty (cancel this draft and raise it again '
        + 'without them), or unlink the note from the invoice.',
      );
    }
    return tags;
  }
  if (note.projectId) {
    const rows = (await sql`
      SELECT project_number, name, status FROM projects
      WHERE company_id = ${companyId}::UUID AND id = ${note.projectId}::UUID
    `) as { project_number: string; name: string; status: string }[];
    if (rows.length === 0) throw new CreditNoteDimensionRefusal('The credit note names a job that is not in your company.');
    if (rows[0]!.status === 'cancelled') {
      throw new CreditNoteDimensionRefusal(
        `The credit note cannot be tagged to job ${rows[0]!.project_number} ${rows[0]!.name}: it is cancelled.`,
      );
    }
  }
  return tags;
}
