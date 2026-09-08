/**
 * MCP write tool: approve and POST a whole set of credit notes.
 *
 * The third arm of the bulk approve family, batching `approve_credit_note`.
 * Both note types are accepted in one call and each posts its own shape:
 *
 *   customer note  DR Revenue + DR VAT Output / CR Accounts Receivable
 *   supplier note  DR Accounts Payable / CR Expense + CR VAT Input
 *
 * ── THE SHARP EDGE THAT MAKES THIS THE MOST CONSEQUENTIAL OF THE THREE ──────
 *
 * Approving a LINKED note does not stop at the ledger. `approveCreditNote` also
 * adds the note's total to the linked invoice's `amount_paid` and lands the note
 * in `applied` rather than `approved` — so one call can reduce a customer's
 * outstanding balance on up to 100 invoices at once. That is why every result
 * row reports `applied_to_invoice_id` explicitly: an agent reading `approved`
 * against `applied` as cosmetic would go looking for a second apply step and
 * double-credit the invoice.
 *
 * ── SYSTEM ACCOUNTS ARE CHECKED PER TYPE PRESENT ────────────────────────────
 *
 * The two note types need different roles, so the pre-write refusal reads the
 * union of what the batch actually contains. A batch of customer notes must not
 * be refused because the chart lacks `vat_input`, which nothing in it would use.
 *
 * Locking is already handled: `approveCreditNote` takes
 * `lockCreditNoteForUpdate` itself, and the runner treats that lock's timeout
 * as a retryable skip.
 *
 * Free to call: `approve_credit_note` is `null` in TOOL_FLOW_OPERATIONS, and
 * N x 0 is 0.
 */
import type { McpTool } from '../types';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import { mcpPostingOpts } from '../mcpActor';
import {
  type BulkApproveAdapter,
  type DocumentState,
  partitionDocuments,
  postPartitionedDocuments,
} from './bulkApproveRunner';
import {
  MAX_DOCUMENTS,
  nothingToApproveText,
  parseDocumentIds,
} from './bulkApproveArgs';
import { ok, toolError } from './toolHelpers';

const TOOL = 'bulk_approve_credit_notes';

/** approveCreditNote refuses anything that is not a draft. */
const APPROVABLE = ['draft'] as const;

/** The system-account roles each note type's journal needs. */
const ROLES_BY_TYPE: Record<string, readonly string[]> = {
  customer: ['default_revenue', 'receivable', 'vat_output'],
  supplier: ['payable', 'default_expense', 'vat_input'],
};

interface ApprovedNoteRow {
  index: number;
  id: string;
  credit_note_number: string;
  type: string;
  status: string;
  total_amount: number;
  gl_journal_entry_id: string | null;
  applied_to_invoice_id: string | null;
}

/**
 * `approveCreditNote` refuses a note whose status moved on with
 * `Cannot approve credit note with status: <status>`, raised from a read taken
 * UNDER the row lock and before anything is posted — so an element that hits it
 * wrote nothing and is a skip. Matched on the wording because the service
 * throws a bare Error, anchored on both halves, and the status is captured
 * rather than flattened to "already approved".
 */
const STATUS_REFUSAL = /Cannot approve credit note with status: (\S+)/;
const NOT_FOUND_REFUSAL = /^Credit note \S+ not found$/;

/**
 * Exported for `bulkApproveRaceReasonDrift.test.ts`, which asserts it against
 * the message the REAL service throws rather than against a second copy of the
 * literal. The regex below matches text owned by another module; a test that
 * hardcoded the same string would restate the drift rather than catch it.
 */
export function racedReason(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const status = STATUS_REFUSAL.exec(err.message)?.[1];
  if (status) return `status became ${status} before it could be approved`;
  return NOT_FOUND_REFUSAL.test(err.message) ? 'not found' : null;
}

const adapter: BulkApproveAdapter<ApprovedNoteRow> = {
  toolName: TOOL,
  // `bulk_appr_cn_99` — 15 characters at the widest index.
  savepointPrefix: 'bulk_appr_cn_',
  approvableStatuses: APPROVABLE,
  async readStates(companyId, ids) {
    const rows = (await sql`
      SELECT id, status, credit_date, credit_note_number, type,
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
        // The invoice this note is linked to, or '' when standalone. Carried
        // because it decides the SECOND row lock each element takes — see the
        // ordering note in the handler.
        lockGroup: r.linked_invoice_id == null ? '' : String(r.linked_invoice_id),
      },
    ]));
  },
  async postOne(ctx, id) {
    const updated = await approveCreditNote(ctx.companyId, id, ctx.userId, mcpPostingOpts(ctx, TOOL));
    return {
      index: -1,
      id: updated.id,
      credit_note_number: updated.creditNoteNumber,
      type: updated.type,
      status: updated.status,
      total_amount: updated.totalAmount,
      gl_journal_entry_id: updated.glJournalEntryId ?? null,
      // 'applied' is the auto-apply having fired — see the header.
      applied_to_invoice_id: updated.status === 'applied'
        ? (updated.customerInvoiceId ?? updated.supplierInvoiceId ?? null)
        : null,
    };
  },
};

export const bulkApproveCreditNotesTool: McpTool = {
  name: TOOL,
  description:
    'Approve and POST up to 100 DRAFT credit notes in ONE call. Requires the write:post permission. '
    + 'Customer note: DR Revenue + DR VAT Output / CR Accounts Receivable. Supplier note: DR Accounts Payable / CR Expense + CR VAT Input. Both types may be mixed in one call. '
    + 'A LINKED note is also AUTO-APPLIED — the linked invoice\'s amount_paid rises by the note total and the note lands in status "applied" instead of "approved". The result reports applied_to_invoice_id per note; do NOT apply it again. '
    + 'A note that cannot be approved is SKIPPED, not a failure: not found, not a draft, or dated in a CLOSED fiscal period — each is listed in "skipped" with its reason and the rest of the batch still posts. '
    + 'ALL OR NOTHING for real faults: if a note genuinely fails to post, the whole batch is rolled back, nothing is posted, and the error names the element. '
    + 'A repeated credit_note_id is REFUSED (not skipped) — each note may appear once. '
    + 'Reverse a posted note with cancel_credit_note. Use dry_run to see what would post and what would be skipped.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_ids: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_DOCUMENTS,
        items: { type: 'string', description: 'Credit note UUID' },
        description: `The notes to approve — at most ${MAX_DOCUMENTS}, each named once.`,
      },
      dry_run: {
        type: 'boolean',
        description: 'Report what would post and what would be skipped, and write nothing.',
      },
      idempotency_key: { type: 'string' },
    },
    required: ['credit_note_ids', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ids = parseDocumentIds(args.credit_note_ids, 'credit_note_ids');
    if (typeof ids === 'string') return toolError(ids);

    const { postable, skipped, states } = await partitionDocuments(ctx.companyId, ids, adapter);

    // Checked AFTER the partition, unlike the two invoice arms, because the
    // roles needed depend on which note TYPES the batch actually contains — and
    // only the partition has read them. Refusing a batch of customer notes for
    // a missing `vat_input` it would never touch is the mistake this avoids.
    // Still pre-write: nothing has posted yet.
    const needed = new Set<string>();
    for (const { id } of postable) {
      for (const role of ROLES_BY_TYPE[states.get(id)?.documentType ?? ''] ?? []) needed.add(role);
    }
    if (needed.size > 0) {
      const missing = (await validateSystemAccounts(ctx.companyId)).filter((k) => needed.has(k));
      if (missing.length > 0) {
        return toolError(
          `Cannot approve: this company has no GL account with subtype ${missing.join(', ')}. `
          + 'Create one with create_gl_account (needs the write:accounts permission), then retry.',
        );
      }
    }

    if (args.dry_run === true) {
      const preview = ok({
        dry_run: true,
        posted: 0,
        would_post: postable.length,
        would_post_ids: postable.map((p) => p.id),
        skipped,
      });
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }

    if (postable.length === 0) {
      return toolError(nothingToApproveText(skipped));
    }

    // ── Everything below WRITES. No try/catch — a throw must reach the
    // registry's savepoint.
    //
    // Ordered by (LINKED INVOICE, note id), not by note id alone. Sorting by the
    // note is not enough, because approveCreditNote takes TWO row locks: it locks
    // the note (lockCreditNoteForUpdate), then UPDATEs the linked invoice's
    // amount_paid, which locks the invoice too. With only the note sorted, the
    // invoice lock order is whatever the note order happens to imply — so batch
    // [CN1, CN2] (CN1 linked to invoice X) and batch [CN2] (also linked to X)
    // can hold and wait crosswise and deadlock (40P01). Ordering by the invoice
    // first gives a total order over the rows two batches can actually contend
    // for. Standalone notes sort under '' and are mutually unconstrained, which
    // is correct: they take no second lock.
    const ordered = [...postable]
      .map((p) => ({ ...p, group: states.get(p.id)?.lockGroup ?? '', entryDate: states.get(p.id)?.entryDate }))
      .sort((a, b) => (a.group !== b.group
        ? (a.group < b.group ? -1 : 1)
        : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    const { posted, raced } = await postPartitionedDocuments(ctx, ordered, adapter, racedReason);

    const byId = new Map(ordered.map((o) => [o.id, o.index]));
    const rows = posted
      .map((r) => ({
        ...r,
        index: byId.get(r.id) ?? -1,
        credit_note_number: r.credit_note_number || (states.get(r.id)?.documentNumber ?? ''),
      }))
      .sort((a, b) => a.index - b.index);
    const allSkipped = [...skipped, ...raced].sort((a, b) => a.index - b.index);

    if (rows.length === 0) {
      const nothing = ok({ posted: 0, credit_notes: [], skipped: allSkipped });
      nothing.wroteNothing = true;
      nothing.billable = false;
      return nothing;
    }

    const applied = rows.filter((r) => r.applied_to_invoice_id !== null);
    return ok({
      posted: rows.length,
      skipped_count: allSkipped.length,
      journal_entry_ids: rows.map((r) => r.gl_journal_entry_id).filter(Boolean),
      credit_notes: rows,
      skipped: allSkipped,
      // Surfaced at batch level as well as per row: a caller reading only the
      // summary of a 100-note run would otherwise never see that 40 of them
      // also reduced an invoice's outstanding balance.
      ...(applied.length > 0 ? { applied_count: applied.length } : {}),
    });
  },
};
