/**
 * Supplier merge and the source's bills that carry a goods received note (#1708; docs/design/mcp-goods-received.md "A bill's GRN").
 * A bill's `grn_id` ties it to the note's PO as a link row does. The rule was set when a merge moved bills but no `purchase_orders`
 * (a moved noted bill would have named a note on another supplier's PO); since #1655 the merge moves the source's POs too, and the
 * refusal is kept, fail-closed. Both merge paths (core/duplicateMergeService.ts, pages/api/accounting/supplier-merge.ts)
 * refuse, twice:
 *   - `assertSupplierMergeMovesNoNotedBill`, before anything moves, after the merge holds both supplier rows FOR UPDATE;
 *   - `refuseIfMovedNotedBills`, on the RETURNING rows of the merge's own bill UPDATE (review of 3010bf7e, M1): a write that makes a bill
 *     live and noted without the supplier lock (a bare grn_id update) is invisible to the check, and the UPDATE, having waited on the
 *     row, moves it after that write commits (EvalPlanQual). The caller's transaction (a savepoint) then takes the whole merge back.
 * Live bills only (not deleted, not cancelled: the cancel's rule). The exit is named per bill state, in the app's terms (both merge
 * paths are the app's pages; no MCP tool merges suppliers).
 */
import { sql } from '@/lib/neon';
import { SupplierMergeRefusal } from './supplierMergeRefusal';

const SHOWN = 10;
const PAID = ['paid', 'partially_paid'];

/** The exits for the states present: a draft is deleted, a paid bill has its payments reversed first, any other bill is cancelled. */
function exits(statuses: readonly string[]): string {
  const out: string[] = [];
  // The deleted draft still moves with the merge (deleted bills are not live), and since #1699 the merge moves the note's purchase
  // order too, so it can be restored on the surviving supplier afterwards (mcp-goods-received-merge-races R2): say so (review of
  // 0d51f4a5, L3; corrected with PR #1703).
  if (statuses.includes('draft')) {
    out.push('a draft bill: delete it, merge, then restore it on the surviving supplier (the deleted draft moves with the merge, and its note\'s purchase order moves with it)');
  }
  if (statuses.some((s) => s !== 'draft' && !PAID.includes(s))) out.push('a pending-approval, disputed or approved bill: cancel it');
  if (statuses.some((s) => PAID.includes(s))) out.push('a paid or partially paid bill: reverse its payments, then cancel it');
  return out.join('; ');
}

function refusal(numbers: readonly string[], total: number, statuses: readonly string[]): SupplierMergeRefusal {
  const named = numbers.join(', ') + (total > numbers.length ? ` and ${total - numbers.length} more` : '');
  return new SupplierMergeRefusal(
    `This supplier has ${total === 1 ? 'a bill' : `${total} bills`} carrying a goods received note (${named}), and a merge does not move a live `
    + `bill tied to a note. Before merging, ${exits(statuses)}.`,
  );
}

export async function assertSupplierMergeMovesNoNotedBill(companyId: string, sourceId: string): Promise<void> {
  const rows = (await sql`
    WITH noted AS (
      SELECT si.id, si.invoice_number, si.status FROM supplier_invoices si
       WHERE si.company_id = ${companyId}::UUID AND si.supplier_id = ${sourceId}::UUID AND si.grn_id IS NOT NULL
         AND si.deleted_at IS NULL AND si.status IS DISTINCT FROM 'cancelled'
    )
    SELECT n.invoice_number, (SELECT count(*) FROM noted)::INT AS total,
           (SELECT array_agg(DISTINCT x.status) FROM noted x) AS statuses
      FROM noted n ORDER BY n.invoice_number, n.id LIMIT ${SHOWN}
  `) as Array<{ invoice_number: string; total: number; statuses: string[] }>;
  if (rows.length === 0) return;
  throw refusal(rows.map((r) => String(r.invoice_number)), Number(rows[0]!.total), rows[0]!.statuses.map(String));
}

/** The merge's bill UPDATE ... RETURNING invoice_number, grn_id, deleted_at, status: refused when it moved a live noted bill. */
export function refuseIfMovedNotedBills(moved: ReadonlyArray<Record<string, unknown>>): void {
  const live = moved.filter((r) => r.grn_id != null && r.deleted_at == null && r.status !== 'cancelled');
  if (live.length === 0) return;
  throw refusal(live.slice(0, SHOWN).map((r) => String(r.invoice_number)), live.length, [...new Set(live.map((r) => String(r.status)))]);
}
