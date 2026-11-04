/**
 * CC1 / CC2 / BU on purchase-order lines (budgets P5-3; columns from migration 954), under the bill lines' rules
 * (`gl/dimensions/.claude.md`), reads only, before the first write:
 *   - a value sent sets the slot, null (or '') clears it; on an update a slot LEFT OUT keeps the value every stored
 *     line shares, and is refused when they differ (`keepStoredDimensions`, the draft-edit rule);
 *   - CC1 is derived from the CC2's FNO; a CC1 the project contradicts is refused (`deriveLineDimensions`);
 *   - each id must be this company's ACTIVE centre of the slot's kind (CC1 'cc1', CC2 'cc2') or business unit
 *     (`assertDocumentDimensions`); a value that is not a UUID is refused here, never cast by the database.
 * Supplier default dimensions are not applied (bills only). 954's trigger repeats tenant and kind in the database.
 * Every refusal is a `DimensionRefusal` (400).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { keepStoredDimensions, type SentDimensions } from '../gl/dimensions/dimensionKeepStored';
import { deriveLineDimensions } from '../gl/dimensions/dimensionDerivation';
import { assertDocumentDimensions } from '../gl/dimensions/dimensionPolicy';
import { DimensionRefusal, type DimensionIds } from '../gl/dimensions/dimensionTypes';

const SLOTS = [['cc1Id', 'CC1'], ['cc2Id', 'CC2'], ['buId', 'BU']] as const;

/** One line's slots as sent: undefined = left out, null / '' = clear, a UUID = set. Anything else is refused. */
function sentOf(line: SentDimensions, index: number): SentDimensions {
  const out: SentDimensions = {};
  for (const [key, name] of SLOTS) {
    const v: unknown = line[key];
    if (v === undefined) continue;
    if (v === null || v === '') { out[key] = null; continue; }
    if (typeof v !== 'string' || !UUID_RE.test(v)) throw new DimensionRefusal(`Line ${index + 1}: ${name} must be a cost centre or business unit id`);
    out[key] = v.toLowerCase();
  }
  return out;
}

/**
 * The dimensions each line stores, in order. `stored`: the PO's current lines on an update (null on create: no
 * line to keep anything from).
 */
export async function resolvePoLineDimensions(
  companyId: string, lines: readonly SentDimensions[], stored: readonly DbRow[] | null,
): Promise<DimensionIds[]> {
  const sent = lines.map(sentOf);
  const kept = keepStoredDimensions(sent, stored ?? []);
  const derived = await deriveLineDimensions(companyId, kept, (i) => `Line ${i + 1}`);
  await assertDocumentDimensions(companyId, derived);
  return derived.map((d) => ({ ...(d.cc1Id ? { cc1Id: d.cc1Id } : {}), ...(d.cc2Id ? { cc2Id: d.cc2Id } : {}), ...(d.buId ? { buId: d.buId } : {}) }));
}

/** The stored dimensions of a PO's lines (the PUT's `stored`); the caller has already scoped the PO to the company. */
export async function readStoredPoLineDimensions(poId: string): Promise<DbRow[]> {
  return (await sql`
    SELECT cc1_id::TEXT AS cc1_id, cc2_id::TEXT AS cc2_id, bu_id::TEXT AS bu_id FROM po_items WHERE purchase_order_id = ${poId}::UUID
  `) as DbRow[];
}

/** The PUT's snake_case line fields → sent slots (absent stays absent). */
export const sentFromSnake = (i: { cc1_id?: string | null; cc2_id?: string | null; bu_id?: string | null }): SentDimensions => ({
  ...(i.cc1_id !== undefined ? { cc1Id: i.cc1_id } : {}),
  ...(i.cc2_id !== undefined ? { cc2Id: i.cc2_id } : {}),
  ...(i.bu_id !== undefined ? { buId: i.bu_id } : {}),
});
