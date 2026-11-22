/**
 * Header billing for committed spend (Hein's ruling on PR #1703, 2026-11-20; isaflow-c8's requirements): a bill that ties a
 * purchase order by its HEADER, not by its lines, nets that PO's committed lines too. Without it a PO billed only through
 * `purchase_order_bill_links` or `supplier_invoices.purchase_order_id` (every bill the retired supplier_purchase_orders ever had,
 * and any canonical bill linked without line links) stayed committed in full while its bill was also actual.
 *
 * The amount per (bill, PO) is `billAttribution.billTies` (the one attribution billed and the unlink read use too): a bill whose
 * lines name a line of the PO nets it by lines only (`billedLinesByPoItem`, not here); else its link row's amount; else, header
 * only, its subtotal less what it attributes to every other PO, kept between 0 and the subtotal. Same bill statuses as line
 * netting (`BILLED_STATUSES`, or a bill in `own`), the PO's company and supplier, not soft-deleted (neither nets: its journal is
 * reversed out of actuals; PR #1703 R4-2).
 * The amount is spread over each PO line's ROOM (`spreadOverRoom`, breaker R3-1 / R4-2 / R4-3): what the line can still be netted
 * after the line billing and the header ties spread before it (bill id order), by room
 * share, then water-filled: what that pass could not place goes to the lines with room left, in order, until it is placed or every
 * line is full; a surplus past the room is netted nowhere. The core floors each line at 0 and caps it at its total
 * (`openPoLineCents`). Named limit: a line over-billed by its lines leaves its siblings' committed beside fully_billed true
 * (R4-5, `billAttribution`). Basis: all ex-VAT. Named limit
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

/**
 * `cents` over the lines' ROOM (what each can still be netted after its line billing; breaker R3-1): by room share, never more
 * than a line's room, then water-filled in line order (R4-3), so every cent that fits is placed. What is left once every line is
 * full is netted nowhere.
 */
export function spreadOverRoom(cents: number, roomCents: readonly number[]): number[] {
  const room = roomCents.map((c) => Math.max(0, c));
  const fits = Math.min(Math.max(0, cents), room.reduce((s, c) => s + c, 0));
  const out = spreadCents(fits, room).map((c, i) => Math.min(c, room[i]!));
  // Water-fill (breaker R4-3): the residual of the pro-rata pass can exceed the last line's room; place it where room is left.
  let left = fits - out.reduce((s, c) => s + c, 0);
  for (let i = 0; i < out.length && left > 0; i++) {
    const add = Math.min(left, room[i]! - out[i]!);
    out[i] = out[i]! + add;
    left -= add;
  }
  return out;
}

/**
 * Header billing per PO line (lower-case ids) for the POs these lines belong to, as postings the core sums with line billing.
 * `lineBilling`: the line billing of PO lines (remainingCommitted.billedLinesByPoItem, passed in: no import cycle). A header tie is
 * spread over each line's room after that line billing and after the header ties spread before it (bill id order), so a line a bill
 * already billed by its lines takes none of a header bill's rands (breaker R3-1).
 */
export async function headerBilledByPoItem(
  companyId: string, poItemIds: readonly string[], own: readonly string[], billedStatuses: readonly string[],
  lineBilling: (poItemIds: string[]) => Promise<Map<string, BilledPosting[]>>,
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
  const ties = (await headerTies(companyId, [...byPo.keys()], own, billedStatuses)).sort((a, b) => (a.billId < b.billId ? -1 : a.billId > b.billId ? 1 : 0));
  if (ties.length === 0) return out;
  const tied = new Set(ties.map((t) => t.poId));
  const lined = await lineBilling(lines.filter((l) => tied.has(lower(l.po))).map((l) => lower(l.id)));
  // Room = what the core would still leave open (openPoLineCents: never above the line's own total).
  const room = new Map(lines.map((l) => {
    const total = toCents(Number(l.line_total));
    return [lower(l.id), Math.min(total, total - (lined.get(lower(l.id)) ?? []).reduce((s, p) => s + toCents(p.amount), 0))];
  }));
  for (const tie of ties) {
    const poLines = byPo.get(tie.poId) ?? [];
    const shares = spreadOverRoom(tie.cents, poLines.map((l) => room.get(lower(l.id)) ?? 0));
    poLines.forEach((l, i) => {
      const id = lower(l.id);
      room.set(id, (room.get(id) ?? 0) - shares[i]!);
      if (!wanted.has(id) || shares[i] === 0) return;
      out.set(id, [...(out.get(id) ?? []), { glAccountId: null, cc1Id: null, cc2Id: null, buId: null, month: tie.month, amount: shares[i]! / 100 }]);
    });
  }
  return out;
}
