/**
 * Routing a bank allocation line that names an invoice to the service that
 * both posts the journal AND applies it to the subledger.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `allocate_bank_transaction` and `bulk_allocate_bank_transactions` accept
 * `invoice_id`, validate it, and echo it back from `dry_run` — and then posted
 * a journal that never touched the invoice. `allocateTransaction` reads
 * `invoiceId` in exactly one place, gated `allocType === 'supplier'`, where it
 * called `recordPaymentMatch`: a boolean flag and nothing else — no
 * `amount_paid`, no `status`, no `paid_at` — which also early-returned once the
 * flag was set, discarding any second payment. There was no customer branch.
 *
 * The GL was right the whole time, which is why it survived: the control
 * account nets to nil and the subledger never moves. In production that is 398
 * supplier invoices flagged-matched at `amount_paid = 0` (R16,151,543.00), and
 * all 39 of Velocity Fibre's unallocated receipts (R37,719,269.77) carrying a
 * `gl_journal_entry_id` — every one made by this path.
 *
 * ── WHY A ROUTE AND NOT A FIX INSIDE allocateTransaction ────────────────────
 *
 * `applyBankLineToSupplierInvoices` ALREADY calls `allocateTransaction` and
 * passes it an `invoiceId`. Teaching `allocateTransaction` to apply would make
 * that path create two payment documents and apply the money twice. So
 * `allocateTransaction` stays a single-purpose journal poster and the choice of
 * path moves up here, where exactly one writer owns each concern.
 *
 * ── NOTHING IS CAUGHT ONCE A WRITE HAS STARTED ──────────────────────────────
 *
 * A write tool gets ONE savepoint and it unwinds on a THROW only: a handler
 * that writes and then RETURNS an error releases the savepoint, the transport's
 * 200 commits what was already posted, and the idempotency key is freed so a
 * retry writes it again. `confirmReceiptMatch` re-runs its plan post-write as a
 * race guard, so it genuinely can throw after writing — catching that here
 * would commit a journal while reporting nothing happened. Every refusal must
 * therefore come from `invoiceSkipReason` BEFORE the first write; after that,
 * everything propagates.
 */

import type { McpToolContext } from '../types';
import { mcpPostingOpts } from '../mcpActor';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { confirmReceiptMatch } from '@/modules/accounting/services/ar/receiptMatchConfirmService';
import { applyBankLineToSupplierInvoices } from '@/modules/accounting/services/ap/supplierBankPaymentService';
import { fetchBankTransaction } from '@/modules/accounting/services/bank/bankMatchDbQueries';
import { BankLineDirectionError } from '../bankLineDirectionError';

/** The two allocation types that have a subledger document to apply to. */
export type ApplyKind = 'customer' | 'supplier';

/**
 * Which apply path a line takes, or null for "post a plain journal".
 *
 * `account` and `transfer` are excluded even when an `invoice_id` is present:
 * neither has a subledger document, so routing them would be a category error
 * rather than a courtesy.
 */
export function applyRouteFor(
  allocType: string,
  invoiceId: string | undefined,
): ApplyKind | null {
  if (!invoiceId) return null;
  if (allocType === 'customer' || allocType === 'supplier') return allocType;
  return null;
}

/**
 * The bank line's SIGNED amount — negative is money out, positive is money in.
 *
 * Signed, not absolute, and the distinction is the whole of the guard below.
 * This used to return `Math.abs(...)`, which is what the apply services want,
 * and the direction was simply gone by the time anything could check it.
 */
export async function bankLineSignedAmount(companyId: string, txId: string): Promise<number> {
  const tx = await fetchBankTransaction(txId, companyId);
  if (!tx) throw new Error(`Bank transaction ${txId} not found`);
  return Number(tx.amount);
}

/**
 * A PRE-WRITE reason this line's SIGN contradicts the document it names, or
 * null when the direction is consistent.
 *
 * Settling a bill is money going OUT; settling a customer invoice is money
 * coming IN. `confirmReceiptMatch` and `applyBankLineToSupplierInvoices` both
 * take the absolute value and apply it as a settlement, so a refund named
 * against an invoice would settle that invoice by the refund's value — cash
 * flowing the wrong way recorded as the document being paid.
 *
 * Pure, so the batch path and the single-line path cannot drift on the wording,
 * and so `dry_run` reports exactly what the live call will do.
 *
 * A ZERO line is not a mismatch: it contradicts no direction, and what is wrong
 * with it (nothing to settle) belongs to `skipReasonForInvoice`, which already
 * refuses it against the outstanding balance. One rule, one owner.
 */
export function signMismatchReason(kind: ApplyKind, signedAmount: number): string | null {
  if (kind === 'supplier' && signedAmount > 0) {
    return `R${signedAmount.toFixed(2)} is money IN and cannot settle a bill — `
      + 'drop invoice_id to book it as a supplier refund, or name a money-out line';
  }
  if (kind === 'customer' && signedAmount < 0) {
    return `R${Math.abs(signedAmount).toFixed(2)} is money OUT and cannot settle a customer `
      + 'invoice — drop invoice_id to book it as a customer refund, or name a money-in line';
  }
  return null;
}

/** What a batch needs to know about one invoice to decide if a line can post. */
export interface InvoiceState {
  invoiceNumber: string;
  outstanding: number;
  status: string;
}

/**
 * Invoice state for a WHOLE batch, in at most two company-scoped queries — one
 * per kind. The per-line alternative is 200 round trips inside a request that
 * is about to take 200 row locks, which is the same reason
 * `findBankTransactionAllocationStates` exists.
 *
 * Absent from the map means "no such invoice in this company". A row in another
 * tenant is indistinguishable from a missing one, deliberately.
 */
export async function fetchInvoiceStates(
  companyId: string,
  refs: readonly { kind: ApplyKind; invoiceId: string }[],
): Promise<Map<string, InvoiceState>> {
  const out = new Map<string, InvoiceState>();
  const byKind: Record<ApplyKind, string[]> = { customer: [], supplier: [] };
  for (const r of refs) byKind[r.kind].push(r.invoiceId);

  for (const kind of ['customer', 'supplier'] as const) {
    const ids = [...new Set(byKind[kind])];
    if (ids.length === 0) continue;
    const rows = (kind === 'customer'
      ? await sql`
          SELECT id, invoice_number, total_amount,
                 COALESCE(amount_paid, 0) AS amount_paid, status
          FROM customer_invoices
          WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])`
      : await sql`
          SELECT id, invoice_number, total_amount,
                 COALESCE(amount_paid, 0) AS amount_paid, status
          FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])`) as DbRow[];
    for (const row of rows) {
      out.set(String(row.id), {
        invoiceNumber: String(row.invoice_number ?? ''),
        outstanding: Math.round((Number(row.total_amount) - Number(row.amount_paid)) * 100) / 100,
        status: String(row.status),
      });
    }
  }
  return out;
}

/**
 * A PRE-WRITE reason this line cannot be applied, or null if it can. Pure, so
 * the batch path and the single-line path cannot drift on the wording.
 *
 * Every reason here is a fact about the DATA, not about the request — which is
 * what makes it a SKIP in the bulk tool rather than a refusal. `bulk_allocate`
 * already skips allocated and excluded rows on the same rule; one line whose
 * invoice was part-paid five minutes ago must not roll back 199 good ones and
 * leave the caller bisecting a batch by hand. The single-line tools treat the
 * identical reason as a refusal, because there the caller named one invoice and
 * one amount and the fault IS the request.
 */
export function skipReasonForInvoice(
  state: InvoiceState | undefined,
  invoiceId: string,
  amount: number,
): string | null {
  if (!state) return `invoice ${invoiceId} not found`;
  if (state.status === 'cancelled' || state.status === 'draft' || state.status === 'written_off') {
    return `invoice ${state.invoiceNumber} is ${state.status} and cannot take a payment`;
  }
  if (state.outstanding <= 0.01) return `invoice ${state.invoiceNumber} is already settled`;
  // The refusal `receiptAllocationLines` raises MID-WRITE, hoisted to a read so
  // the batch can skip around it instead of unwinding on it.
  if (amount > state.outstanding + 0.01) {
    return `R${amount.toFixed(2)} exceeds the R${state.outstanding.toFixed(2)} outstanding on `
      + `invoice ${state.invoiceNumber}`;
  }
  return null;
}

/** Single-line convenience over the two above. Read-only, company-scoped. */
export async function invoiceSkipReason(args: {
  companyId: string;
  kind: ApplyKind;
  invoiceId: string;
  amount: number;
}): Promise<string | null> {
  const states = await fetchInvoiceStates(args.companyId, [
    { kind: args.kind, invoiceId: args.invoiceId },
  ]);
  return skipReasonForInvoice(states.get(args.invoiceId), args.invoiceId, args.amount);
}

/**
 * Post the journal and apply it, through the service that owns both.
 *
 * NOT wrapped in try/catch — see the header. The caller decides whether a
 * throw becomes a single-line `toolError` (nothing else was written) or
 * unwinds the batch savepoint.
 */
export async function postAndApplyLine(args: {
  ctx: McpToolContext;
  txId: string;
  kind: ApplyKind;
  invoiceId: string;
  toolName: string;
}): Promise<{ journalEntryId: string; transactionId: string }> {
  const { ctx, txId, kind, invoiceId, toolName } = args;
  const signedAmount = await bankLineSignedAmount(ctx.companyId, txId);

  // BEFORE the first write, like every other refusal on this path — see the
  // header. `postAndApplyLine` is the single-line route; the bulk route runs
  // the same pure check in `partitionAllocationLines` and SKIPS instead, on the
  // rule this file already states: the single caller named one invoice and one
  // line, so the fault IS the request.
  const wrongWay = signMismatchReason(kind, signedAmount);
  if (wrongWay !== null) throw new BankLineDirectionError(txId, wrongWay);

  const amount = Math.abs(signedAmount);

  // The FULL actor identity, not just the posting agent: `actorTokenJti`
  // (migration 530) is what keeps the posting inside the token-scoped view of
  // `list_agent_postings`, and a stamp without it reads as derived-human in
  // `audit_trail`.
  const postingOpts = mcpPostingOpts(ctx, toolName);
  const params = {
    bankTxId: txId,
    userId: ctx.userId,
    allocations: [{ invoiceId, amount }],
    postingOpts,
  };

  const result = kind === 'customer'
    ? await confirmReceiptMatch(ctx.companyId, params)
    : await applyBankLineToSupplierInvoices(ctx.companyId, params);

  return { journalEntryId: result.journalEntryId, transactionId: txId };
}
