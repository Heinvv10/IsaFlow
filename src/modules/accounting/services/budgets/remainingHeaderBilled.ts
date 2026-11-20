/**
 * Header billing for committed spend (Hein's ruling on PR #1703, 2026-11-20; isaflow-c8's requirements): a bill that ties a
 * purchase order by its HEADER, not by its lines, nets that PO's committed lines too. Without it a PO billed only through
 * `purchase_order_bill_links` or `supplier_invoices.purchase_order_id` (every bill the retired supplier_purchase_orders ever had,
 * and any canonical bill linked without line links) stayed committed in full while its bill was also actual.
 *
 * The amount per (bill, PO) is `billAttribution.billTies` (the one attribution billed and the unlink read use too): a bill whose
 * lines name a line of the PO nets it by lines only (`billedLinesByPoItem`, not here); else its link row's amount; else, header
 * only, its subtotal less what it attributes to every other PO, kept between 0 and the subtotal. Same bill statuses as line
 * netting (`BILLED_STATUSES`, or a bill in `own`), the PO's company and supplier, not soft-deleted. (Line netting still counts a
 * soft-deleted approved bill, a pre-existing behaviour flagged to Hein: its journal is reversed out of actuals, so netting
 * committed by it would understate; header netting does not copy that.)
 * The amount is spread over ALL the PO's lines by their positive `line_total` cents (sort_order, id), the residual on the last
 * positive line; the core floors each line at 0 and caps it at its total (`openPoLineCents`). Basis: all ex-VAT. Named limit
 * (the slice): header billing nets at the PO line, not at the bill's own account / centre / month; the posting carries no
 * account or dimensions (null) and the bill's month.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { toCents } from './grid/cents';
import type { BilledPosting } from './remainingBudgetCore';
import { billTies } from './billAttribution';

/** One header tie that nets: a bill, a PO, the ex-VAT cents it nets there, the bill's month. */
export interface HeaderTie { billId: string; poId: string; cents: number; month: string }

const lower = (v: unknown): string => String(v).toLowerCase();

/**
 * The header ties of these POs that net committed: link or header ties (never a bill whose lines name the PO), not
 * soft-deleted, above zero. `billedStatuses` is passed in (remainingCommitted's BILLED_STATUSES) so this module does not
 * import its caller.
 */
export async function headerTies(
  companyId: string, poIds: readonly string[], own: readonly string[], billedStatuses: readonly string[],
): Promise<HeaderTie[]> {
  return (await billTies(companyId, poIds, { statuses: billedStatuses, own }))
    .filter((t) => t.via !== 'lines' && !t.deleted && t.cents > 0)
    .map(({ billId, poId, cents, month }) => ({ billId, poId, cents, month }));
}

/**
 * `cents` over the lines by their share of the POSITIVE line totals (BigInt: no float error), the residual on the last line with a
 * positive total; a zero or negative line takes nothing, and nothing is spread when no line is positive.
 */
export function spreadCents(cents: number, lineCents: readonly number[]): number[] {
  const pos = lineCents.map((c) => Math.max(0, c));
  const total = pos.reduce((s, c) => s + c, 0);
  if (total <= 0) return lineCents.map(() => 0);
  const shares = pos.map((c) => Number((BigInt(cents) * BigInt(c)) / BigInt(total)));
  const last = pos.reduce((at, c, i) => (c > 0 ? i : at), -1);
  shares[last] = cents - shares.reduce((s, c, i) => (i === last ? s : s + c), 0);
  return shares;
}

/** Header billing per PO line (lower-case ids) for the POs these lines belong to, as postings the core sums with line billing. */
export async function headerBilledByPoItem(
  companyId: string, poItemIds: readonly string[], own: readonly string[], billedStatuses: readonly string[],
): Promise<Map<string, BilledPosting[]>> {
  const out = new Map<string, BilledPosting[]>();
  if (poItemIds.length === 0) return out;
  const lines = (await sql`
    SELECT pi.id::TEXT AS id, pi.purchase_order_id::TEXT AS po, pi.line_total::TEXT AS line_total
      FROM po_items pi JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.purchase_order_id IN (SELECT x.purchase_order_id FROM po_items x WHERE x.id = ANY(${[...poItemIds]}::UUID[]))
     ORDER BY pi.purchase_order_id, pi.sort_order, pi.id
  `) as DbRow[];
  const byPo = new Map<string, DbRow[]>();
  for (const l of lines) byPo.set(lower(l.po), [...(byPo.get(lower(l.po)) ?? []), l]);
  const wanted = new Set(poItemIds.map(lower));
  for (const tie of await headerTies(companyId, [...byPo.keys()], own, billedStatuses)) {
    const poLines = byPo.get(tie.poId) ?? [];
    const shares = spreadCents(tie.cents, poLines.map((l) => toCents(Number(l.line_total))));
    poLines.forEach((l, i) => {
      const id = lower(l.id);
      if (!wanted.has(id) || shares[i] === 0) return;
      out.set(id, [...(out.get(id) ?? []), { glAccountId: null, cc1Id: null, cc2Id: null, buId: null, month: tie.month, amount: shares[i]! / 100 }]);
    });
  }
  return out;
}
