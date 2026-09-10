/**
 * MCP write tool: approve and POST a whole set of supplier invoices (bills).
 *
 * `bulk_create_supplier_invoices` reloads a payables subledger 100 drafts at a
 * time; until now the only way to get those drafts into the ledger was one
 * `approve_supplier_invoice` call each. Velocity's ~2,200-bill rebuild is 22
 * create calls and was 2,200 approve calls.
 *
 * Every element posts DR Expense (per line) + DR VAT Input / CR Accounts
 * Payable and is irreversible except by a reversing entry, so this carries
 * `requiresPost`. The refuse/skip/throw contract, the per-element savepoint and
 * the pre-write partition all live in `bulkApproveRunner.ts` — read that first.
 *
 * Free to call: `approve_supplier_invoice` is `null` in TOOL_FLOW_OPERATIONS
 * ("already paid for at draft time"), and N x 0 is 0. If the single tool ever
 * gains a price this must become a per-element debit, not a flat one.
 */
import type { McpTool } from '../types';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
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

const TOOL = 'bulk_approve_supplier_invoices';

/** Mirrors approveSupplierInvoice's own guard. */
const APPROVABLE = ['draft', 'pending_approval'] as const;

interface ApprovedRow {
  index: number;
  id: string;
  invoice_number: string;
  status: string;
  total_amount: number;
  gl_journal_entry_id: string | null;
}

/**
 * `approveSupplierInvoice` refuses a document whose status moved on with
 * `Cannot approve invoice with status: <status>`. Matched on the wording rather
 * than by class because the service throws a bare Error — and the refusal is
 * raised from a READ taken under the row lock, before anything is posted, so an
 * element that hits it wrote nothing and is a skip rather than a batch failure.
 *
 * Anchored on both halves so it cannot swallow an unrelated message, and the
 * STATUS is captured: reporting every race as "already approved" would tell an
 * agent its cancelled bill had been posted.
 */
const STATUS_REFUSAL = /Cannot approve invoice with status: (\S+)/;

/** A bill that vanished between the partition and the post — same shape. */
const NOT_FOUND_REFUSAL = /^Supplier invoice \S+ not found$/;

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

const adapter: BulkApproveAdapter<ApprovedRow> = {
  toolName: TOOL,
  // `bulk_appr_si_99` — 15 characters at the widest index. withSavepoint THROWS
  // above 31, which would fail the batch before it posted anything.
  savepointPrefix: 'bulk_appr_si_',
  approvableStatuses: APPROVABLE,
  operation: 'supplier_invoice.post',
  entityType: 'supplier_invoice',
  async readStates(companyId, ids) {
    // ONE query for the batch. `invoice_date` is what createJournalEntry uses
    // as the entry date, so it is what the fiscal-period verdict must be read
    // for — not today's date, and not due_date.
    const rows = (await sql`
      SELECT id, status, invoice_date
      FROM supplier_invoices
      WHERE company_id = ${companyId}::UUID AND id = ANY(${[...ids]}::UUID[])
    `) as DbRow[];
    return new Map<string, DocumentState>(rows.map((r) => [
      String(r.id),
      { id: String(r.id), status: String(r.status), entryDate: r.invoice_date as string | Date },
    ]));
  },
  async postOne(ctx, id) {
    const updated = await approveSupplierInvoice(
      ctx.companyId, id, ctx.userId, mcpPostingOpts(ctx, TOOL),
    );
    return {
      // Filled in by the caller, which knows the agent's own index.
      index: -1,
      id: updated.id,
      invoice_number: updated.invoiceNumber,
      status: updated.status,
      total_amount: updated.totalAmount,
      gl_journal_entry_id: updated.glJournalEntryId ?? null,
    };
  },
};

export const bulkApproveSupplierInvoicesTool: McpTool = {
  name: TOOL,
  description:
    'Approve and POST up to 100 DRAFT supplier invoices (bills) in ONE call — each posts DR Expense (per line) + DR VAT Input / CR Accounts Payable. Irreversible except by a reversing entry. Requires the write:post permission. '
    + 'Identify each bill by its invoice_id (from list_supplier_invoices or bulk_create_supplier_invoices). '
    + 'A bill that cannot be approved is SKIPPED, not a failure: not found, already approved, cancelled, or dated in a CLOSED fiscal period — each is listed in "skipped" with its reason and the rest of the batch still posts. '
    + 'ALL OR NOTHING for real faults: if a bill genuinely fails to post, the whole batch is rolled back, nothing is posted, and the error names the element. '
    + 'A repeated invoice_id is REFUSED (not skipped) — each bill may appear once. '
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
        items: { type: 'string', description: 'Supplier invoice UUID' },
        description: `The bills to approve — at most ${MAX_DOCUMENTS}, each named once.`,
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

    // A chart missing one of these roles fails EVERY element, so it is a
    // refusal about the request's preconditions rather than 100 identical
    // skips. Pre-write, and it names the subtypes to create — left to throw it
    // would reach the agent as a batch failure inviting a retry that cannot
    // succeed, the chart being identical on the second call.
    const NEEDED = ['payable', 'vat_input', 'default_expense'];
    const missing = (await validateSystemAccounts(ctx.companyId)).filter((k) => NEEDED.includes(k));
    if (missing.length > 0) {
      return toolError(
        `Cannot approve: this company has no GL account with subtype ${missing.join(', ')}. `
        + 'Create one with create_gl_account (needs the write:accounts permission), then retry.',
      );
    }

    const { postable, skipped, states } = await partitionDocuments(
      ctx.companyId, ids, adapter, { preview: args.dry_run === true },
    );

    if (args.dry_run === true) {
      const preview = ok({
        dry_run: true,
        posted: 0,
        would_post: postable.length,
        would_post_ids: postable.map((p) => p.id),
        skipped,
      });
      // Wrote nothing, so it must not occupy the idempotency key: the real call
      // carries the same intent and would otherwise be served this preview
      // forever.
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }

    if (postable.length === 0) {
      // Pre-write refusal, so a toolError is the right shape — nothing to
      // unwind, and the registry audits it with a NULL key, leaving the key
      // usable once the agent has fixed its list.
      return toolError(nothingToApproveText(skipped));
    }

    // ── Everything below WRITES. No try/catch: a throw must reach the
    // registry's savepoint, the only thing that unwinds the journals already
    // posted. Catching here would commit a half-approved batch.
    //
    // Sorted by invoice id, NOT the agent's order: each element takes a row
    // lock held to the end of the request, so two overlapping batches in
    // opposite orders would deadlock (40P01).
    const ordered = [...postable]
      // The date rides along so the posting loop can tell a failed fiscal-period
      // creation (a skip) from a genuine fault (which unwinds the batch).
      .map((p) => ({ ...p, entryDate: states.get(p.id)?.entryDate }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const { posted, raced } = await postPartitionedDocuments(ctx, ordered, adapter, racedReason);

    // Back into the agent's own order, carrying its indexes — a human reads
    // this against the list they sent.
    const byId = new Map(ordered.map((o) => [o.id, o.index]));
    const rows = posted
      .map((r) => ({ ...r, index: byId.get(r.id) ?? -1 }))
      .sort((a, b) => a.index - b.index);
    const allSkipped = [...skipped, ...raced].sort((a, b) => a.index - b.index);

    if (rows.length === 0) {
      // Every postable bill lost its race. Nothing was written, so the key is
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
