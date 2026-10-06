/**
 * MCP write tool: approve and POST a whole set of credit notes.
 *
 * The third arm of the bulk approve family. Both note types post their own shape:
 *
 *   customer note  DR Revenue + DR VAT Output / CR Accounts Receivable
 *   supplier note  DR Accounts Payable / CR Expense + CR VAT Input
 *
 * ── THE SHARP EDGE THAT MAKES THIS THE MOST CONSEQUENTIAL OF THE THREE ──────
 *
 * Approving does not stop at the ledger: each note settles its linked document
 * and then walks the entity's other open ones oldest first, so ONE call can
 * reduce outstanding balances across far more documents than the hundred notes
 * it names. That is why every result row reports `applied_to_invoice_ids` and
 * `applied_amount` — an agent reading the status as cosmetic would go looking
 * for a second apply step and double-credit them.
 *
 * The two note types need different system-account roles, so the pre-write
 * refusal reads the union of what the batch actually contains: a batch of
 * customer notes must not be refused for a missing `vat_input`.
 *
 * Locking is handled below the tool: `approveCreditNote` takes the note's row
 * lock and `creditNoteApplicationWrites` takes every document's, and the runner
 * treats a lock timeout as a retryable skip.
 *
 * Free to call: `approve_credit_note` is `null` in TOOL_FLOW_OPERATIONS.
 */
import type { McpTool } from '../types';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import {
  CREDIT_NOTE_AUTO_APPLY,
  parseCreditNoteAutoApply,
} from '@/modules/accounting/services/shared/creditNoteFifo';
import { ApprovalRequiredError } from '@/modules/accounting/services/gl/approvalGate';
import { agentApprovalRefusals } from '@/modules/accounting/services/gl/approvalUnattended';
import { creditNoteApprovalType } from '@/modules/accounting/services/gl/approvalDocumentTypes';
import { type DocumentState, partitionDocuments, postPartitionedDocuments } from './bulkApproveRunner';
import { TOOL, buildAdapter } from './bulkApproveCreditNotesAdapter';
import {
  MAX_DOCUMENTS,
  nothingToApproveText,
  parseDocumentIds,
} from './bulkApproveArgs';
import { ok, toolError } from './toolHelpers';

/** The system-account roles each note type's journal needs. */
const ROLES_BY_TYPE: Record<string, readonly string[]> = {
  customer: ['default_revenue', 'receivable', 'vat_output'],
  supplier: ['payable', 'default_expense', 'vat_input'],
};

/**
 * `approveCreditNote` refuses a note whose status moved on with
 * `Cannot approve credit note with status: <status>`, raised UNDER the row lock
 * and before anything is posted — so an element that hits it wrote nothing and
 * is a skip. Matched on the wording because the service throws a bare Error.
 */
const STATUS_REFUSAL = /Cannot approve credit note with status: (\S+)/;
const NOT_FOUND_REFUSAL = /^Credit note \S+ not found$/;

/**
 * Exported for `bulkApproveRaceReasonDrift.test.ts`, which asserts it against
 * the message the REAL service throws — a test hardcoding the same string would
 * restate the drift rather than catch it.
 */
export function racedReason(err: unknown): string | null {
  // R-035: the gate refuses under the row lock, before any write — a skip.
  if (err instanceof ApprovalRequiredError) return `approval_required: ${err.message}`;
  if (!(err instanceof Error)) return null;
  const status = STATUS_REFUSAL.exec(err.message)?.[1];
  if (status) return `status became ${status} before it could be approved`;
  return NOT_FOUND_REFUSAL.test(err.message) ? 'not found' : null;
}

/**
 * R-035 (Q6): id → `approval_required: <why>` for each note an enforced rule
 * of ITS type holds. A batch may mix both types, so the notes are grouped by
 * the type the partition read from the row, never by what the agent sent.
 */
async function approvalRefusals(companyId: string, ids: readonly string[],
  states: Map<string, DocumentState>): Promise<Map<string, string>> {
  const byType = new Map<string, string[]>();
  for (const id of ids) {
    const type = states.get(id)?.documentType ?? '';
    byType.set(type, [...(byType.get(type) ?? []), id]);
  }
  const refusals = new Map<string, string>();
  for (const [type, typeIds] of byType) {
    for (const [id, why] of await agentApprovalRefusals(companyId, creditNoteApprovalType(type), typeIds)) {
      refusals.set(id, why);
    }
  }
  return refusals;
}

export const bulkApproveCreditNotesTool: McpTool = {
  name: TOOL,
  description:
    'Approve and POST up to 100 DRAFT credit notes in ONE call. Requires the write:post permission. '
    + 'Customer note: DR Revenue + DR VAT Output / CR Accounts Receivable. Supplier note: DR Accounts Payable / CR Expense + CR VAT Input. Both types may be mixed in one call. '
    + 'Approving also APPLIES each note: its linked document first, capped at that document\'s outstanding balance, then the REMAINDER FIFO across the same entity\'s other open documents, oldest first. auto_apply "none" applies only to the linked document. '
    + 'The status is DERIVED — "approved", "partially_applied" or "applied" — and each row reports applied_amount and applied_to_invoice_ids; do NOT apply those documents again. '
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
      auto_apply: {
        type: 'string',
        enum: [...CREDIT_NOTE_AUTO_APPLY],
        description:
          '"fifo" (default) applies each note\'s remainder to its entity\'s open documents oldest first; "none" applies only to the linked document.',
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

    // Refused rather than coerced — see the same guard in approve_credit_note.
    const autoApply = args.auto_apply === undefined
      ? 'fifo' as const
      : parseCreditNoteAutoApply(args.auto_apply);
    if (autoApply === null) {
      return toolError(`auto_apply must be one of: ${CREDIT_NOTE_AUTO_APPLY.join(', ')}`);
    }
    const adapter = buildAdapter(autoApply);

    const partitioned = await partitionDocuments(ctx.companyId, ids, adapter);
    const { states } = partitioned;
    // R-035 (Q6): gated by an enforced approval rule — skipped, never submitted.
    // Read, not written, so the dry run and the live call decide it alike.
    const refusals = await approvalRefusals(ctx.companyId, partitioned.postable.map((p) => p.id), states);
    const postable = partitioned.postable.filter((p) => !refusals.has(p.id));
    const skipped = [...partitioned.skipped, ...partitioned.postable.filter((p) => refusals.has(p.id))
      .map((p) => ({ index: p.index, document_id: p.id, reason: refusals.get(p.id)! }))]
      .sort((a, b) => a.index - b.index);

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
    // note is not enough, because approving takes locks on DOCUMENTS as well as
    // on the note: `lockCreditNoteForUpdate` first, then one `FOR UPDATE` over
    // every document the note will settle. With only the note sorted, the
    // document lock order is whatever the note order happens to imply — so batch
    // [CN1, CN2] (CN1 linked to invoice X) and batch [CN2] (also linked to X)
    // can hold and wait crosswise and deadlock (40P01).
    //
    // WHAT THE FIFO WALK ACTUALLY LOCKS, since the comment used to overstate it:
    // one statement takes every candidate document ORDERED BY id
    // (`creditNoteApplicationWrites.lockInvoicesForUpdate`), so two batches
    // contending for the same documents acquire them in one direction by
    // construction. Sorting the batch by linked invoice remains worth doing for
    // the note-to-first-document leg. Standalone notes sort under '' and are
    // mutually unconstrained.
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

    const applied = rows.filter((r) => r.applied_to_invoice_ids.length > 0);
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
