/**
 * MCP write tool: approve and POST a whole set of CUSTOMER invoices.
 *
 * The AR mirror of `bulk_approve_supplier_invoices`, batching `finalize_invoice`
 * the way that tool batches `approve_supplier_invoice`. Each element posts
 * DR Accounts Receivable / CR Revenue + CR VAT Output.
 *
 * ── WHY THIS ARM TAKES NO ROW LOCK ──────────────────────────────────────────
 *
 * `approveCustomerInvoice` claims the transition inside the UPDATE itself
 * (`AND status = ANY('{draft,pending_approval}')`) and raises
 * `InvoiceNotApprovableError` when it matched zero rows. That is a
 * compare-and-swap, and it is STRONGER than the lock the AP arm needed: two
 * concurrent callers cannot both win the UPDATE, so only one posts. Adding a
 * `FOR UPDATE` here would be ceremony over a race the UPDATE already settles.
 *
 * The refusal is raised BEFORE the GL post, so an element that loses the CAS
 * wrote nothing and is a skip rather than a batch failure.
 *
 * ── THE COST THIS ARM CARRIES AND THE AP ARM DOES NOT ───────────────────────
 *
 * `approveCustomerInvoice` also seals a PDF (PRD-06 evidence): it RENDERS the
 * invoice with jsPDF and UPLOADS it to object storage, once per element. A full
 * batch is therefore 100 renders and 100 uploads inside the one request
 * transaction — in-process rendering, so tens of milliseconds each, but the
 * uploads are network calls made while the transaction is open.
 *
 * The seal is deliberately NOT skipped on this path. An agent-approved invoice
 * that silently lacks the evidence a human-approved one carries is a divergence
 * nobody would see until the evidence was needed. If batch latency becomes the
 * binding constraint, the answer is a smaller cap for this tool — not a
 * quieter approval.
 *
 * Free to call: `finalize_invoice` is `null` in TOOL_FLOW_OPERATIONS ("already
 * paid for at draft time"), and N x 0 is 0.
 */
import type { McpTool } from '../types';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  approveCustomerInvoice,
  InvoiceNotApprovableError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
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

const TOOL = 'bulk_finalize_invoices';

/** Mirrors APPROVABLE_STATUSES in customerInvoiceApprovalService. */
const APPROVABLE = ['draft', 'pending_approval'] as const;

interface FinalizedRow {
  index: number;
  id: string;
  status: string;
  gl_journal_entry_id: string | null;
  evidence_document_id: string | null;
}

/**
 * `InvoiceNotApprovableError` is raised by the guarded UPDATE matching zero
 * rows — before the GL post — so an element that hits it wrote NOTHING and is a
 * skip, not a batch failure. Matched by CLASS here (unlike the AP arm, whose
 * service throws a bare Error), which is why no message parsing is needed: the
 * class is the contract, and `notFound` separates the two cases the agent can
 * act on differently.
 */
function racedReason(err: unknown): string | null {
  if (!(err instanceof InvoiceNotApprovableError)) return null;
  // The service's own message names the settled status, which is the fact that
  // distinguishes "someone else approved it" from "it was cancelled". Passed
  // through rather than restated: it is text the service wrote for this
  // audience, carries no SQL, and restating it would let the two drift.
  return err.notFound ? 'not found' : err.message;
}

const adapter: BulkApproveAdapter<FinalizedRow> = {
  toolName: TOOL,
  // `bulk_fin_inv_99` — 15 characters at the widest index; withSavepoint THROWS
  // above 31, which would fail the batch before it posted anything.
  savepointPrefix: 'bulk_fin_inv_',
  approvableStatuses: APPROVABLE,
  async readStates(companyId, ids) {
    // ONE query for the batch. `invoice_date` is what postCustomerInvoiceToGL
    // uses as the entry date (via fmtDate), so it is what the fiscal-period
    // verdict must be read for.
    const rows = (await sql`
      SELECT id, status, invoice_date, invoice_number
      FROM customer_invoices
      WHERE company_id = ${companyId}::UUID AND id = ANY(${[...ids]}::UUID[])
    `) as DbRow[];
    return new Map<string, DocumentState>(rows.map((r) => [
      String(r.id),
      {
        id: String(r.id),
        status: String(r.status),
        entryDate: r.invoice_date as string | Date,
        documentNumber: r.invoice_number == null ? undefined : String(r.invoice_number),
      },
    ]));
  },
  async postOne(ctx, id) {
    const result = await approveCustomerInvoice(
      ctx.companyId, id, ctx.userId, mcpPostingOpts(ctx, TOOL),
    );
    return {
      index: -1,
      id: result.id,
      status: result.status,
      gl_journal_entry_id: result.glJournalEntryId,
      evidence_document_id: result.evidenceDocumentId,
    };
  },
};

export const bulkFinalizeInvoicesTool: McpTool = {
  name: TOOL,
  description:
    'Approve and POST up to 100 DRAFT customer invoices in ONE call — each posts DR Accounts Receivable / CR Revenue + CR VAT Output and seals its PDF as evidence. Irreversible except by a reversing entry. Requires the write:post permission. '
    + 'Identify each invoice by its invoice_id (from list_customer_invoices or bulk_create_customer_invoices). '
    + 'An invoice that cannot be approved is SKIPPED, not a failure: not found, already approved, cancelled, or dated in a CLOSED fiscal period — each is listed in "skipped" with its reason and the rest of the batch still posts. '
    + 'ALL OR NOTHING for real faults: if an invoice genuinely fails to post, the whole batch is rolled back, nothing is posted, and the error names the element. '
    + 'A repeated invoice_id is REFUSED (not skipped) — each invoice may appear once. '
    + 'Every posting is attributed to the agent and visible in list_agent_postings. Use dry_run to see what would post and what would be skipped.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      invoice_ids: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_DOCUMENTS,
        items: { type: 'string', description: 'Customer invoice UUID' },
        description: `The invoices to approve — at most ${MAX_DOCUMENTS}, each named once.`,
      },
      dry_run: {
        type: 'boolean',
        description: 'Report what would post and what would be skipped, and write nothing.',
      },
      idempotency_key: { type: 'string' },
    },
    required: ['invoice_ids', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const ids = parseDocumentIds(args.invoice_ids, 'invoice_ids');
    if (typeof ids === 'string') return toolError(ids);

    // A chart missing one of these roles fails EVERY element, so it is refused
    // once about the request's preconditions rather than reported as 100
    // identical skips — and it names the subtypes to create, where a bare batch
    // failure would invite a retry that cannot succeed.
    const NEEDED = ['receivable', 'default_revenue', 'vat_output'];
    const missing = (await validateSystemAccounts(ctx.companyId)).filter((k) => NEEDED.includes(k));
    if (missing.length > 0) {
      return toolError(
        `Cannot approve: this company has no GL account with subtype ${missing.join(', ')}. `
        + 'Create one with create_gl_account (needs the write:accounts permission), then retry.',
      );
    }

    const { postable, skipped, states } = await partitionDocuments(ctx.companyId, ids, adapter);

    if (args.dry_run === true) {
      const preview = ok({
        dry_run: true,
        posted: 0,
        would_post: postable.length,
        would_post_ids: postable.map((p) => p.id),
        skipped,
      });
      // Wrote nothing, so it must not occupy the idempotency key — the real
      // call carries the same intent and would be served this preview forever.
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }

    if (postable.length === 0) {
      return toolError(nothingToApproveText(skipped));
    }

    // ── Everything below WRITES. No try/catch: a throw must reach the
    // registry's savepoint, the only thing that unwinds journals already
    // posted. Ordered by id rather than the agent's order for the same reason
    // the AP arm is — a stable total order over the rows two batches might
    // share is what keeps them from deadlocking on each other.
    const ordered = [...postable].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const { posted, raced } = await postPartitionedDocuments(ctx, ordered, adapter, racedReason);

    const byId = new Map(ordered.map((o) => [o.id, o.index]));
    const rows = posted
      .map((r) => ({
        ...r,
        index: byId.get(r.id) ?? -1,
        invoice_number: states.get(r.id)?.documentNumber ?? null,
      }))
      .sort((a, b) => a.index - b.index);
    const allSkipped = [...skipped, ...raced].sort((a, b) => a.index - b.index);

    if (rows.length === 0) {
      // Every postable invoice lost its race. Nothing written, so the key is
      // left free — same reasoning as the dry run.
      const nothing = ok({ posted: 0, invoices: [], skipped: allSkipped });
      nothing.wroteNothing = true;
      nothing.billable = false;
      return nothing;
    }

    return ok({
      posted: rows.length,
      skipped_count: allSkipped.length,
      journal_entry_ids: rows.map((r) => r.gl_journal_entry_id).filter(Boolean),
      invoices: rows,
      skipped: allSkipped,
    });
  },
};
