/**
 * The back-fill: apply the cash that is already in the ledger to the documents
 * nobody ever attached it to.
 *
 * The FIFO default stops the books PRODUCING unapplied payments. It does
 * nothing about the ones already there, and they are the reason a control
 * account and its subledger disagree by millions. This walks that backlog
 * oldest cash first and applies each remainder to that contact's oldest open
 * documents — the same rules, through the same helpers, as a fresh bank line.
 *
 * WHAT IT NEVER DOES, and each of these is a rule rather than an omission:
 *   · it posts NO journal. The cash left the bank when the payment was
 *     processed; a second journal would double it.
 *   · it creates NO document. Every payment and credit note it touches already
 *     exists.
 *   · it never applies ACROSS contacts. One supplier's cash settles one
 *     supplier's bills.
 *   · the remainder stays on the payment as on-account credit. Nothing is
 *     forced onto a document to make a number reach zero.
 *
 * ONE SAVEPOINT PER SOURCE. A backlog run is hundreds of independent
 * applications; a failure on the fortieth must not undo the thirty-nine that
 * worked. Each source is attempted inside its own savepoint, and a throw rolls
 * that source back WHOLE — never half its lines — and is reported in `failed`.
 * Sequential, never Promise.all: these share one pg connection, and concurrent
 * statements on it corrupt the savepoint stack (postgresql-gotchas §36).
 *
 * IDEMPOTENT BY CONSTRUCTION. A second run reads the population again, and a
 * payment that has been applied no longer has a remainder, so it is not in it.
 * The per-source re-read under the payment lock is the same check one layer
 * down, for cash applied between the population read and the write.
 *
 * REVERSIBLE. Every row it writes is an ordinary `payment_allocations` /
 * `customer_payment_allocations` row, so `void_payment`, `void_receipt` and
 * `bankAllocationUnwind` take them back through the paths that already exist.
 */

import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { SimulationDocument } from './autoApplySimulation';
import {
  fetchDocumentFacts,
  fetchOpenDocuments,
  readBackfillSources,
} from './autoApplyBackfillPopulation';
import {
  applyOneCreditNote,
  applyOnePayment,
  makeStrategyReader,
  type ApplyContext,
} from './autoApplyBackfillApply';
import {
  assembleBackfillPlan,
  buildBackfillPlan,
  type BackfillPlan,
  type BackfillSource,
  type PlannedLine,
  type Subledger,
} from './autoApplyBackfillPlan';

/** The most sources one call will walk, whatever the caller asks for. */
export const MAX_BACKFILL_LIMIT = 2000;
export const DEFAULT_BACKFILL_LIMIT = 500;

export interface BackfillRequest {
  companyId: string;
  subledger: Subledger;
  /** One supplier or customer, or null for the whole subledger. */
  entityId?: string | null;
  dryRun: boolean;
  limit?: number;
  userId: string;
  /** Carried into every live log line, so a run is traceable end to end. */
  idempotencyKey?: string | null;
}

/**
 * A failure's text, safe to hand back.
 *
 * A pg error's message names tables, columns and constraints, so a raw one is
 * never echoed. The typed refusals this path raises (`SupplierPaymentRefusal`,
 * `ReceiptRefusal`, `PaymentLockTimeoutError`) carry text written FOR a caller
 * and are passed through — that text is the whole reason they are typed.
 */
function safeReason(err: unknown): string {
  const code = typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code
    : undefined;
  // Every pg error carries a 5-character SQLSTATE; application errors here
  // carry either none or a named one, so the shape is what separates them.
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `database error ${code}`;
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * Attach the document NUMBER and DATE to every line of a finished run, in one
 * statement for the whole run rather than a query per line — a 500-source
 * back-fill names thousands of documents.
 *
 * The number is filled in as well as the date because the credit-note writer
 * returns ids only; the payment path already knows its numbers and they are
 * left alone.
 */
async function fillDocumentFacts(
  companyId: string,
  subledger: Subledger,
  decided: readonly { source: BackfillSource; lines: PlannedLine[] }[],
): Promise<void> {
  const facts = await fetchDocumentFacts(
    companyId, subledger, decided.flatMap((d) => d.lines.map((l) => l.document_id)),
  );
  for (const { lines } of decided) {
    for (const line of lines) {
      const fact = facts.get(line.document_id);
      line.invoice_date = fact?.invoiceDate ?? null;
      if (!line.document_number) line.document_number = fact?.invoiceNumber ?? '';
    }
  }
}

async function planDryRun(req: BackfillRequest, sources: BackfillSource[]): Promise<BackfillPlan> {
  const oldestFirstFor = makeStrategyReader(req.companyId, req.subledger);
  const openByEntity = new Map<string, SimulationDocument[]>();
  const oldestFirstByEntity = new Map<string, boolean>();
  // Only the contacts a source may actually be applied to. Reading open
  // documents for a skipped source would cost a query to populate a pool
  // nothing consumes.
  const entityIds = new Set(
    sources.filter((s) => !s.skippedReason && s.entityId).map((s) => s.entityId!),
  );
  for (const entityId of entityIds) {
    oldestFirstByEntity.set(entityId, await oldestFirstFor(entityId));
    // NOT locked: a dry run over a whole subledger would otherwise hold every
    // open document in the book for the length of a preview it throws away.
    openByEntity.set(entityId, await fetchOpenDocuments(
      req.companyId, req.subledger, entityId, true, false,
    ));
  }
  const facts = await fetchDocumentFacts(
    req.companyId,
    req.subledger,
    [...openByEntity.values()].flatMap((docs) => docs.map((d) => d.invoiceId)),
  );
  const documentDates = new Map(
    [...facts].map(([id, f]) => [id, f.invoiceDate]),
  );
  return buildBackfillPlan({
    subledger: req.subledger, sources, openByEntity, oldestFirstByEntity, documentDates,
  });
}

async function runLive(req: BackfillRequest, sources: BackfillSource[]): Promise<BackfillPlan> {
  const ctx: ApplyContext = {
    companyId: req.companyId,
    subledger: req.subledger,
    userId: req.userId,
    idempotencyKey: req.idempotencyKey ?? null,
    oldestFirstFor: makeStrategyReader(req.companyId, req.subledger),
  };

  const decided: { source: BackfillSource; lines: PlannedLine[] }[] = [];
  const failed: BackfillPlan['failed'] = [];

  for (const [index, source] of sources.entries()) {
    // THE SAME DECISION THE DRY RUN MADE, taken from the source rather than
    // retaken here. Every skip lives in the population for exactly this reason:
    // a rule applied in one mode and not the other is a preview that lies.
    if (source.skippedReason) {
      decided.push({ source, lines: [] });
      continue;
    }
    try {
      // ≤31 characters for every index up to 2000 — withSavepoint THROWS on a
      // longer name, which would fail the run before it applied anything.
      const lines = await withSavepoint(`backfill_src_${index}`, () => (
        source.kind === 'credit_note'
          ? applyOneCreditNote(ctx, source)
          : applyOnePayment(ctx, source)
      ));
      decided.push({ source, lines });
    } catch (err) {
      log.warn('Back-fill could not apply one source', {
        subledger: req.subledger,
        paymentId: source.paymentId,
        idempotencyKey: ctx.idempotencyKey,
        error: err,
      }, 'accounting');
      failed.push({
        payment_id: source.paymentId,
        payment_number: source.paymentNumber,
        error: safeReason(err),
      });
    }
  }

  await fillDocumentFacts(req.companyId, req.subledger, decided);
  return assembleBackfillPlan(false, req.subledger, decided, failed);
}

/**
 * Plan the back-fill (dry run) or perform it. The ONE entry point — the MCP
 * tool and the operator script both call this, so neither can act on a
 * population the other would not see.
 */
export async function autoApplyUnapplied(req: BackfillRequest): Promise<BackfillPlan> {
  const limit = Math.min(
    Math.max(1, Math.floor(req.limit ?? DEFAULT_BACKFILL_LIMIT)), MAX_BACKFILL_LIMIT,
  );
  const sources = await readBackfillSources(
    req.companyId, req.subledger, req.entityId ?? null, limit,
  );
  return req.dryRun ? planDryRun(req, sources) : runLive(req, sources);
}
