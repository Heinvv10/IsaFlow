/**
 * Capture's slip-dimension re-plan (budgets P5-2b; coordinator's ruling, 2026-11-04: fail closed). The capture line
 * plan inherits a bank-first provisional's dimensions from the provisional `findAttachableProvisional` READ before
 * the lines are written (`captureBillLines`); the attach that links the slip runs later in the SAME request
 * transaction (`provisionalAttachSettle`) and may link a different provisional, or none (contention, a race, a
 * provisional evidenced meanwhile). Inherited dimensions must never come from a provisional the bill is not
 * attached to, so right after the attach:
 * - the attached provisional is the planned one: nothing to do;
 * - another one: the inherited lines are re-planned from it by the same rule (`inheritSlipDimensions`);
 * - none: the inherited lines take the supplier's defaults, as a line that inherits nothing does at plan time.
 * Only lines whose dimensions were inherited are touched (their ids come from `insertCaptureBillLines`); a line that
 * took the supplier default at plan time keeps it. Runs before the bill is posted and before an approval request is
 * raised for it (the routes raise it after the attach), so no digest binds the old dimensions.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { resolveBillLineDimensions } from '../gl/dimensions/supplierDimensionDefaults';
import { inheritSlipDimensions, provisionalDimLines } from '../ap/supplierInvoiceProvisionalDims';

/** What the capture plan inherited: the provisional it read, and the bill lines that took its dimensions. */
export interface CaptureSlipPlan {
  plannedJeId: string | null;
  inheritedItemIds: string[];
}

interface ItemRow { id: string; glAccountId: string | null; lineTotal: number; cc1Id?: string; cc2Id?: string; buId?: string }

const opt = (v: unknown): string | undefined => (v == null ? undefined : String(v));

async function defaultExpenseOrNull(companyId: string): Promise<string | null> {
  try {
    return await getSystemAccountId('default_expense', companyId);
  } catch (err) {
    if (err instanceof MissingSystemAccountError) return null; // no role: a line with no account matches nothing
    throw err;
  }
}

/** Re-plans the inherited lines when the attach linked another provisional than the plan read, or none. */
export async function replanCaptureSlipDimensions(
  companyId: string, invoiceId: string, supplierId: string, slip: CaptureSlipPlan | undefined, attachedJeId: string | null,
): Promise<void> {
  if (!slip || slip.inheritedItemIds.length === 0 || slip.plannedJeId === attachedJeId) return;
  const inheritedIds = new Set(slip.inheritedItemIds.map((v) => v.toLowerCase()));
  const [head] = (await sql`
    SELECT subtotal::TEXT AS subtotal, total_amount::TEXT AS total, tax_rate::TEXT AS tax_rate
      FROM supplier_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!head) throw new Error(`Capture slip re-plan: supplier invoice ${invoiceId} not found`);
  const rows = (await sql`
    SELECT sii.id::TEXT AS id, sii.gl_account_id::TEXT AS gl_account_id, sii.line_total::TEXT AS line_total,
           sii.cc1_id::TEXT AS cc1_id, sii.cc2_id::TEXT AS cc2_id, sii.bu_id::TEXT AS bu_id
      FROM supplier_invoice_items sii JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
     WHERE si.id = ${invoiceId}::UUID AND si.company_id = ${companyId}::UUID
     ORDER BY sii.id
  `) as DbRow[];
  // Every line of the bill (the posted-net allocation needs them all); the inherited ones blank again and eligible.
  const items: ItemRow[] = rows.map((r) => {
    const mine = inheritedIds.has(String(r.id).toLowerCase());
    return {
      id: String(r.id), glAccountId: r.gl_account_id ? String(r.gl_account_id) : null, lineTotal: Number(r.line_total),
      ...(mine ? {} : { cc1Id: opt(r.cc1_id), cc2Id: opt(r.cc2_id), buId: opt(r.bu_id) }),
    };
  });
  const eligible = items.map((i) => inheritedIds.has(i.id.toLowerCase()));
  let planned = items;
  let inherited = items.map(() => false);
  if (attachedJeId) {
    const [bank] = (await sql`
      SELECT bank_account_id::TEXT AS bank FROM bank_transactions
       WHERE provisional_je_id = ${attachedJeId}::UUID AND company_id = ${companyId}::UUID LIMIT 1
    `) as DbRow[];
    if (bank) {
      const header = { subtotal: Number(head.subtotal), totalAmount: Number(head.total), taxRate: Number(head.tax_rate) };
      ({ lines: planned, inherited } = await inheritSlipDimensions(companyId, items, header,
        await provisionalDimLines(companyId, attachedJeId, String(bank.bank)), await defaultExpenseOrNull(companyId), eligible));
    }
  }
  // The lines that inherit nothing from the attached provisional take the supplier's defaults.
  const fallback = planned.filter((_, i) => eligible[i] && !inherited[i]);
  const defaulted = await resolveBillLineDimensions(companyId, supplierId, fallback);
  const byId = new Map(defaulted.map((l) => [l.id, l]));
  const touched = planned.filter((_, i) => eligible[i]).map((l) => byId.get(l.id) ?? l);
  for (const l of touched) {
    const updated = (await sql`
      UPDATE supplier_invoice_items sii
         SET cc1_id = ${l.cc1Id ?? null}::UUID, cc2_id = ${l.cc2Id ?? null}::UUID, bu_id = ${l.buId ?? null}::UUID
        FROM supplier_invoices si
       WHERE sii.id = ${l.id}::UUID AND sii.supplier_invoice_id = si.id AND si.id = ${invoiceId}::UUID
         AND si.company_id = ${companyId}::UUID
      RETURNING sii.id
    `) as DbRow[];
    // The stored line must be what is posted: a line not found is a fault, never a silent skip.
    if (updated.length !== 1) throw new Error(`Capture slip re-plan: line ${l.id} of supplier invoice ${invoiceId} was not updated`);
  }
}
