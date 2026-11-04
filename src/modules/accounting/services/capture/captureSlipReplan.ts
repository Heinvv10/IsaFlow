/**
 * A slip bill's dimensions once its slip is ATTACHED to a bank-first provisional (budgets P5-2b; coordinator's
 * rulings, 2026-11-04: fail closed). Inherited dimensions only ever come from the provisional the bill is attached to.
 *
 * Capture (`replanCaptureSlipDimensions`, run by `provisionalAttachSettle` right after the automatic attach, in the
 * same request transaction): the line plan inherited from the provisional `findAttachableProvisional` READ before the
 * lines were written (`captureBillLines`), and the attach may link another one, or none:
 * - the planned one: nothing to do;
 * - another one: the inherited lines are re-planned from it by the same rule (`inheritSlipDimensions`);
 * - none: the inherited lines take the supplier's defaults, as a line that inherits nothing does at plan time. The
 *   plan resolved those defaults for every line already (a refused one is the plan's 400 before any write, breaker
 *   R3-2), so they cannot be refused here; if one still is (a master changed in between), it throws: rolled back, 500;
 * - the plan inherited nothing but the attach linked one: the lines that were blank BEFORE the supplier's defaults
 *   (`blankItemIds`; the stored lines may carry those defaults already) are re-planned from it by the same rule, so
 *   an auto-approved bill (the settlement posts it next, reclassing the provisional's slice) posts on that slice.
 *   The bill was inserted on this request transaction and its approval request is raised after the attach.
 * Otherwise only the inherited lines are re-planned; a line that took the supplier default or nothing keeps it.
 *
 * Manual attach (`inheritOnAttach`, from `provisionalEvidenceAttach`; breaker R3-4): each bill raised from the slip
 * that is a DRAFT with NO approval request bound to it (pending or approved) has its blank lines inherit from the
 * attached provisional; otherwise it is skipped and the attach says so, so no digest moves under a request (migration
 * 873 hashes the lines' dimensions). The capture routes raise their request after the attach, so it holds there too.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { resolveBillLineDimensions } from '../gl/dimensions/supplierDimensionDefaults';
import { inheritSlipDimensions, provisionalDimLines, type ProvisionalDimLine } from '../ap/supplierInvoiceProvisionalDims';
import { withContentEditorStamp } from '../ap/supplierInvoiceContentEditor';
import { lockSupplierInvoiceForUpdate } from '../ap/supplierInvoiceLock';
import { SUPPLIER_INVOICE_LINE_ORDER_BY } from '../ap/supplierInvoiceLineOrder';

/**
 * What the capture plan inherited: the provisional it read, the bill lines that took its dimensions, and the lines
 * that carried no dimensions before the supplier's defaults (re-planned when the plan inherited nothing).
 */
export interface CaptureSlipPlan {
  plannedJeId: string | null;
  inheritedItemIds: string[];
  blankItemIds: string[];
}

/** One bill's outcome at an attach: how many lines inherited, or why it was skipped. */
export type AttachInheritance = { invoiceId: string; inheritedLines: number } | { invoiceId: string; skipped: string };

interface ItemRow { id: string; glAccountId: string | null; lineTotal: number; cc1Id?: string; cc2Id?: string; buId?: string; costCenterId?: string }
type Header = { subtotal: number; totalAmount: number; taxRate: number; costCenterId: string | null };

const opt = (v: unknown): string | undefined => (v == null ? undefined : String(v));

async function defaultExpenseOrNull(companyId: string): Promise<string | null> {
  try {
    return await getSystemAccountId('default_expense', companyId);
  } catch (err) {
    if (err instanceof MissingSystemAccountError) return null; // no role: a line with no account matches nothing
    throw err;
  }
}

/** The bill's header and every line (with its stored dimensions), company-scoped; null when it is not found. */
async function readBill(companyId: string, invoiceId: string): Promise<{ head: Header; items: ItemRow[] } | null> {
  const [h] = (await sql`
    SELECT subtotal::TEXT AS subtotal, total_amount::TEXT AS total, tax_rate::TEXT AS tax_rate, cost_center_id::TEXT AS cc
      FROM supplier_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!h) return null;
  const rows = (await sql`
    SELECT sii.id::TEXT AS id, sii.gl_account_id::TEXT AS gl_account_id, sii.line_total::TEXT AS line_total,
           sii.cc1_id::TEXT AS cc1_id, sii.cc2_id::TEXT AS cc2_id, sii.bu_id::TEXT AS bu_id, sii.cost_center_id::TEXT AS cost_center_id
      FROM supplier_invoice_items sii JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
     WHERE si.id = ${invoiceId}::UUID AND si.company_id = ${companyId}::UUID
     ${sql.unsafe(SUPPLIER_INVOICE_LINE_ORDER_BY)}
  `) as DbRow[];
  return {
    head: { subtotal: Number(h.subtotal), totalAmount: Number(h.total), taxRate: Number(h.tax_rate), costCenterId: h.cc ? String(h.cc) : null },
    items: rows.map((r) => ({
      id: String(r.id), glAccountId: r.gl_account_id ? String(r.gl_account_id) : null, lineTotal: Number(r.line_total),
      cc1Id: opt(r.cc1_id), cc2Id: opt(r.cc2_id), buId: opt(r.bu_id), costCenterId: opt(r.cost_center_id),
    })),
  };
}

/** The attached provisional's lines (all but its bank line); none when its bank line is gone. */
async function attachedLines(companyId: string, jeId: string): Promise<ProvisionalDimLine[]> {
  const [bank] = (await sql`
    SELECT bank_account_id::TEXT AS bank FROM bank_transactions
     WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID LIMIT 1
  `) as DbRow[];
  return bank ? provisionalDimLines(companyId, jeId, String(bank.bank)) : [];
}

/** Writes each line's dimensions; the stored line must be what is posted, so a line not found is a fault. */
async function writeDims(companyId: string, invoiceId: string, lines: readonly ItemRow[]): Promise<void> {
  for (const l of lines) {
    const updated = (await sql`
      UPDATE supplier_invoice_items sii
         SET cc1_id = ${l.cc1Id ?? null}::UUID, cc2_id = ${l.cc2Id ?? null}::UUID, bu_id = ${l.buId ?? null}::UUID
        FROM supplier_invoices si
       WHERE sii.id = ${l.id}::UUID AND sii.supplier_invoice_id = si.id AND si.id = ${invoiceId}::UUID
         AND si.company_id = ${companyId}::UUID
      RETURNING sii.id
    `) as DbRow[];
    if (updated.length !== 1) throw new Error(`Slip dimensions: line ${l.id} of supplier invoice ${invoiceId} was not updated`);
  }
}

/** Whether an approval request (pending or approved) binds the bill's digest: its lines are then never changed here. */
async function boundRequest(companyId: string, invoiceId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM approval_requests
     WHERE company_id = ${companyId}::UUID AND document_type = 'supplier_invoice' AND document_id = ${invoiceId}::UUID
       AND status IN ('pending', 'approved')
     LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}

/** Capture, right after the automatic attach (see the header). */
export async function replanCaptureSlipDimensions(
  companyId: string, invoiceId: string, supplierId: string, slip: CaptureSlipPlan | undefined, attachedJeId: string | null,
): Promise<void> {
  if (!slip || slip.plannedJeId === attachedJeId) return;
  // Nothing inherited: the originally blank lines, whose stored supplier defaults would otherwise block the
  // inheritance and leave an auto-approved bill posting off the slice the settlement reclasses (Codex, 1b316ed36).
  // The asymmetry is deliberate, fail closed (review round 7): when the plan DID inherit, only those lines are re-planned
  // (the others took the supplier default or nothing on purpose, after a provisional was read); when it inherited
  // nothing, no provisional was matched at plan time, so every originally blank line is re-planned against the one
  // actually attached. Either way inherited dimensions only ever come from the attached provisional.
  const eligibleIds = slip.inheritedItemIds.length > 0 ? slip.inheritedItemIds : attachedJeId ? slip.blankItemIds : [];
  if (eligibleIds.length === 0) return;
  // R-035 (round 7): only a bill that has not posted and has no approval request bound may change lines here (an
  // auto-approved capture bill qualifies until the settlement below posts it: no request binds its digest). The
  // bill was inserted on this transaction, so its row lock never waits. The request check is DEFENSIVE: both capture
  // routes raise their request after the attach, so none can be bound yet; it guards a future caller that raises first.
  const row = await lockSupplierInvoiceForUpdate(companyId, invoiceId);
  if (!row) throw new Error(`Capture slip re-plan: supplier invoice ${invoiceId} not found`);
  const why = row.gl_journal_entry_id ? 'it has posted' : await boundRequest(companyId, invoiceId) ? 'an approval request is bound to it' : null;
  if (why) {
    log.info('Capture slip re-plan skipped', { invoiceId, jeId: attachedJeId, reason: why }, 'capture-slip');
    return;
  }
  const bill = await readBill(companyId, invoiceId);
  if (!bill) throw new Error(`Capture slip re-plan: supplier invoice ${invoiceId} not found`);
  const ids = new Set(eligibleIds.map((v) => v.toLowerCase()));
  // Only the eligible lines are re-planned, read blank again; the others are neither matched nor written.
  const items: ItemRow[] = bill.items.map((i) => ({ id: i.id, glAccountId: i.glAccountId, lineTotal: i.lineTotal }));
  const eligible = items.map((i) => ids.has(i.id.toLowerCase()));
  let planned = items;
  let inherited = items.map(() => false);
  if (attachedJeId) {
    ({ lines: planned, inherited } = await inheritSlipDimensions(companyId, items, bill.head,
      await attachedLines(companyId, attachedJeId), await defaultExpenseOrNull(companyId), eligible));
  }
  // The lines that inherit nothing from the attached provisional take the supplier's defaults (already accepted by the
  // plan for every line; a refusal now would mean a master changed in between: it throws, rolled back, 500).
  const defaulted = await resolveBillLineDimensions(companyId, supplierId, planned.filter((_, i) => eligible[i] && !inherited[i]));
  const byId = new Map(defaulted.map((l) => [l.id, l]));
  await writeDims(companyId, invoiceId, planned.filter((_, i) => eligible[i]).map((l) => byId.get(l.id) ?? l));
}

/** The bill row, locked FOR UPDATE without waiting (`SKIP LOCKED`; this transaction's own lock never skips). */
async function lockBillOrSkip(companyId: string, invoiceId: string): Promise<DbRow | 'busy' | null> {
  if (!als.getStore()?.client) throw new Error('Slip bill locks require a request transaction (withAuth / als.run)');
  const [row] = (await sql`
    SELECT * FROM supplier_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE SKIP LOCKED
  `) as DbRow[];
  if (row) return row;
  const exists = (await sql`
    SELECT 1 FROM supplier_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return exists.length > 0 ? 'busy' : null;
}

/**
 * The live DRAFT bills raised from slip `documentId`, each locked FOR UPDATE without waiting, in id order: 'busy' when
 * another transaction holds any of them. The manual attach takes these BEFORE its first write (after its bank line,
 * journal and document locks), so a held bill answers contended with nothing written: an attach that committed and
 * then skipped the bill could never be retried (the journal is evidenced), leaving the bill on its old dimensions.
 */
export async function lockSlipBillsOrBusy(companyId: string, documentId: string): Promise<string[] | 'busy'> {
  // Drafts only (review round 7): only a draft can inherit, so a payment holding a paid bill never 503s the attach.
  // The status is read unlocked here and re-checked under the lock (`inheritOnAttach`).
  const bills = (await sql`
    SELECT id FROM supplier_invoices
     WHERE company_id = ${companyId}::UUID AND source_document_id = ${documentId}::UUID AND deleted_at IS NULL
       AND status = 'draft'
     ORDER BY id`) as DbRow[];
  const ids: string[] = [];
  for (const b of bills) {
    const row = await lockBillOrSkip(companyId, String(b.id));
    if (row === 'busy') return 'busy';
    if (row) ids.push(String(b.id));
  }
  return ids;
}

/**
 * The blank lines of bill `invoiceId` inherit from the provisional `jeId` its slip was just attached to, when the bill
 * is a draft with no approval request bound (pending or approved); otherwise skipped, with the reason. The caller
 * already holds the bill's row lock: the manual attach takes every slip bill with `lockSlipBillsOrBusy` (id order, no
 * wait) BEFORE its first write, so a held bill is a contended 503 with nothing written and the retry really retries
 * (breaker R5-3; the one contention mechanism). The re-entrant lock below only reads the locked row. The session user becomes
 * a content author of the bill when its lines change (`withContentEditorStamp`), so segregation of duties counts them
 * (round 5, LOW 4). A request raised meanwhile waits on this lock (`approvalDocuments.raiseOnce` takes the bill FOR
 * SHARE), so it binds the inherited lines (breaker R4-2).
 */
export async function inheritOnAttach(companyId: string, invoiceId: string, jeId: string): Promise<AttachInheritance> {
  const row = await lockSupplierInvoiceForUpdate(companyId, invoiceId);
  if (!row) return { invoiceId, skipped: 'not found' };
  if (String(row.status) !== 'draft') return { invoiceId, skipped: `the bill is ${String(row.status)}, not a draft: its lines are not changed` };
  if (await boundRequest(companyId, invoiceId)) {
    return { invoiceId, skipped: 'an approval request is bound to the bill: its lines are not changed (cancel the request to inherit)' };
  }
  const bill = await readBill(companyId, invoiceId);
  if (!bill) return { invoiceId, skipped: 'not found' };
  const items = bill.items.map((i) => (bill.head.costCenterId ? { ...i, costCenterId: bill.head.costCenterId } : i));
  const { lines, inherited } = await inheritSlipDimensions(companyId, items, bill.head,
    await attachedLines(companyId, jeId), await defaultExpenseOrNull(companyId));
  const changed = lines.filter((_, i) => inherited[i]);
  if (changed.length > 0) {
    const editor = als.getStore()?.userId;
    if (editor) await withContentEditorStamp(companyId, invoiceId, editor, () => writeDims(companyId, invoiceId, changed));
    else await writeDims(companyId, invoiceId, changed); // no session user (a service caller): nobody to stamp
  }
  return { invoiceId, inheritedLines: changed.length };
}
