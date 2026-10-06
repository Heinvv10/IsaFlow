/**
 * The `bulk_approve_credit_notes` adapter for the shared bulk-approve runner
 * (bulkApproveRunner.ts): how a batch's states are read and how one note is
 * posted. Split from writeBulkApproveCreditNotes.ts for the 300-line cap; the
 * refuse/skip contract and the lock ordering live there.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { listCreditNoteAllocations, type CreditNoteAutoApply } from '@/modules/accounting/services/shared/creditNoteFifo';
import { mcpPostingOpts } from '../mcpActor';
import type { BulkApproveAdapter, DocumentState } from './bulkApproveRunner';

export const TOOL = 'bulk_approve_credit_notes';

/** approveCreditNote refuses anything that is not a draft. */
const APPROVABLE = ['draft'] as const;

export interface ApprovedNoteRow {
  index: number;
  id: string;
  credit_note_number: string;
  type: string;
  status: string;
  total_amount: number;
  gl_journal_entry_id: string | null;
  applied_amount: number;
  /** Every document this note settled — the FIFO walk can settle several. */
  applied_to_invoice_ids: { invoice_id: string; amount: number }[];
}

/**
 * The adapter is built per call rather than declared once, because `auto_apply`
 * is an argument and `postOne` has no other way to see it. A module-level
 * mutable would be shared by concurrent requests on the same process.
 */
export function buildAdapter(autoApply: CreditNoteAutoApply): BulkApproveAdapter<ApprovedNoteRow> {
  return {
  toolName: TOOL,
  // `bulk_appr_cn_99` — 15 characters at the widest index.
  savepointPrefix: 'bulk_appr_cn_',
  approvableStatuses: APPROVABLE,
  lockRow: lockCreditNoteForUpdate, // approveCreditNote's first lock
  async readStates(companyId, ids) {
    const rows = (await sql`
      SELECT id, status, credit_date, credit_note_number, type, total_amount,
             COALESCE(customer_invoice_id, supplier_invoice_id) AS linked_invoice_id
      FROM credit_notes
      WHERE company_id = ${companyId}::UUID AND id = ANY(${[...ids]}::UUID[])
    `) as DbRow[];
    return new Map<string, DocumentState>(rows.map((r) => [
      String(r.id),
      {
        id: String(r.id),
        status: String(r.status),
        entryDate: r.credit_date as string | Date,
        documentNumber: r.credit_note_number == null ? undefined : String(r.credit_note_number),
        documentType: String(r.type),
        totalAmount: Number(r.total_amount),
        // The invoice this note is linked to, or '' when standalone. Carried
        // because it decides the SECOND row lock each element takes — see the
        // ordering note in the handler.
        lockGroup: r.linked_invoice_id == null ? '' : String(r.linked_invoice_id),
      },
    ]));
  },
  async postOne(ctx, id) {
    const updated = await approveCreditNote(ctx.companyId, id, ctx.userId, {
      ...mcpPostingOpts(ctx, TOOL),
      autoApply,
    });
    return {
      index: -1,
      id: updated.id,
      credit_note_number: updated.creditNoteNumber,
      type: updated.type,
      status: updated.status,
      total_amount: updated.totalAmount,
      gl_journal_entry_id: updated.glJournalEntryId ?? null,
      applied_amount: updated.appliedAmount,
      // Read back from the allocation rows rather than inferred from the
      // status: a partially applied note settles documents too, and the status
      // alone cannot name them.
      applied_to_invoice_ids: (await listCreditNoteAllocations(ctx.companyId, id))
        .map((l) => ({ invoice_id: l.invoiceId, amount: l.amount })),
    };
  },
  };
}
