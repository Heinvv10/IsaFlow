/**
 * The revenue leg(s) of a customer invoice, carrying CC1 / CC2 / BU.
 *
 * Before migration 870 an invoice posted ONE revenue line for its subtotal. It
 * still does whenever its items carry no dimensions — byte-for-byte the old
 * journal. Otherwise the subtotal is split by distinct (CC1, CC2, BU) across
 * the items, each group a revenue line, with the cents left by rounding on the
 * last group so the lines sum EXACTLY to the subtotal the AR and VAT legs were
 * built from.
 *
 * The items' STORED dimensions, and nothing else: the customer's FNO is applied
 * when the invoice is saved (deriveRevenueDimensions), so it is covered by the
 * approval digest. An item saved without the FNO its customer now has is
 * refused before posting (dimensions/dimensionStoredPosting.ts), never filled.
 *
 * Pure: the caller reads the rows.
 */
import type { JournalLineInput } from '../../types/gl.types';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';

export interface RevenueItemDims extends DimensionIds {
  amount: number;
}

export interface RevenueLinesInput {
  revenueAccountId: string;
  subtotal: number;
  invoiceNumber: string;
  items: readonly RevenueItemDims[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildRevenueLines(input: RevenueLinesInput): JournalLineInput[] {
  const description = `Revenue: ${input.invoiceNumber}`;
  const single = (dims: DimensionIds): JournalLineInput[] => [{
    glAccountId: input.revenueAccountId, debit: 0, credit: Number(input.subtotal), description, ...dims,
  }];
  const items = input.items;
  if (!items.some((i) => i.cc1Id || i.cc2Id || i.buId)) return single({});

  const groups = new Map<string, { dims: DimensionIds; amount: number }>();
  for (const item of items) {
    const dims: DimensionIds = {
      ...(item.cc1Id ? { cc1Id: item.cc1Id } : {}),
      ...(item.cc2Id ? { cc2Id: item.cc2Id } : {}),
      ...(item.buId ? { buId: item.buId } : {}),
    };
    const key = JSON.stringify([dims.cc1Id ?? null, dims.cc2Id ?? null, dims.buId ?? null]);
    const group = groups.get(key) ?? { dims, amount: 0 };
    group.amount = round2(group.amount + Number(item.amount));
    groups.set(key, group);
  }
  const list = [...groups.values()];
  // The fallback single line keeps the one CC1 every item stores (the customer's FNO), if there is one.
  const cc1s = new Set(items.map((i) => i.cc1Id?.toLowerCase() ?? null));
  const shared = cc1s.size === 1 ? [...cc1s][0] : null;
  const fnoOnly: DimensionIds = shared ? { cc1Id: shared } : {};
  if (list.length === 0) return single(fnoOnly);
  if (list.length === 1) return single(list[0]!.dims);
  // A group that nets to nothing or below (a discount line on its own
  // dimensions) cannot post as a revenue CREDIT. Rather than refuse the
  // invoice, it posts as before — one line — keeping only the shared FNO.
  if (list.some((g) => g.amount <= 0)) return single(fnoOnly);

  const lines: JournalLineInput[] = [];
  let allocated = 0;
  list.forEach((group, idx) => {
    const credit = idx === list.length - 1 ? round2(Number(input.subtotal) - allocated) : group.amount;
    allocated = round2(allocated + credit);
    lines.push({ glAccountId: input.revenueAccountId, debit: 0, credit, description, ...group.dims });
  });
  // The last group absorbed the rounding; if that leaves it at or below zero
  // the items do not describe the subtotal, so post the one line instead.
  if (lines[lines.length - 1]!.credit <= 0) return single(fnoOnly);
  return lines;
}

/** Parse the `dim_items` json_agg the posting query returns. */
export function parseRevenueItems(raw: unknown): RevenueItemDims[] {
  const rows = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      amount: Number(o.amount ?? 0),
      ...(o.cc1_id ? { cc1Id: String(o.cc1_id) } : {}),
      ...(o.cc2_id ? { cc2Id: String(o.cc2_id) } : {}),
      ...(o.bu_id ? { buId: String(o.bu_id) } : {}),
    };
  });
}
