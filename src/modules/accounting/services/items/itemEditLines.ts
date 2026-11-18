/**
 * Item links on a draft edit that REPLACES every line (supplier bill, customer invoice, quote).
 *
 * The create paths take `item_id` per line (itemLineDefaults). A replace has no stable line identity, so the rule is:
 *  - a line that names an item the identical stored line did not carry is CHECKED (this company's, not deleted, active)
 *    and, with no account of its own, takes the item's default account, exactly as on create;
 *  - a line sent WITHOUT an item inherits the item of an identical stored line (description, quantity, unit price; each
 *    stored line is used once, in order) and is NOT re-checked: like a stored account, an item deactivated since must not
 *    refuse every save of the draft (the document's approval re-checks what it posts);
 *  - `item_id: null` clears the link; a line whose description, quantity or price changed loses it.
 * Reads only (the item read of the lines that need a check); every refusal is an `ItemLineRefusal` before any write.
 */
import { applyItemLineDefaults, type ItemDefaultKind } from './itemLineDefaults';

export interface StoredItemLine {
  itemId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
}

interface EditLine {
  description: string;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  itemId?: string | null;
  glAccountId?: string | null;
}

const key = (description: string, quantity: unknown, unitPrice: unknown): string =>
  JSON.stringify([description, Number(quantity).toFixed(4), Number(unitPrice).toFixed(2)]);

export async function resolveEditLineItems<T extends EditLine>(
  companyId: string,
  kind: ItemDefaultKind,
  sent: readonly T[],
  stored: readonly StoredItemLine[],
  label: (index: number) => string,
): Promise<T[]> {
  const pool = stored.map((s) => ({ key: key(s.description, s.quantity, s.unitPrice), itemId: s.itemId?.toLowerCase() ?? null, used: false }));
  const inherited = sent.map((l) => {
    const hit = pool.find((p) => !p.used && p.key === key(l.description, l.quantity, l.unitPrice));
    if (hit) hit.used = true;
    return hit?.itemId ?? null;
  });
  // Only a line naming an item its identical stored line did not carry is read and defaulted.
  const check = sent.map((l, i) => typeof l.itemId === 'string' && l.itemId.toLowerCase() !== inherited[i]);
  const checked = await applyItemLineDefaults(
    companyId, sent.map((l, i) => ({ itemId: check[i] ? l.itemId : undefined, glAccountId: l.glAccountId })), kind, label,
  );
  return sent.map((l, i) => {
    if (check[i]) return { ...l, itemId: checked[i]!.itemId, glAccountId: checked[i]!.glAccountId };
    if (l.itemId === null) return l;
    return typeof l.itemId === 'string' ? { ...l, itemId: l.itemId.toLowerCase() } : (inherited[i] ? { ...l, itemId: inherited[i] } : l);
  });
}

interface AccountIdEditLine {
  description: string;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  itemId?: string | null;
  accountId?: string | null;
}

/** The same rule for lines that name their account `accountId` (quote lines). */
export async function resolveEditLineItemsAccountId<T extends AccountIdEditLine>(
  companyId: string, kind: ItemDefaultKind, sent: readonly T[], stored: readonly StoredItemLine[], label: (index: number) => string,
): Promise<T[]> {
  const out = await resolveEditLineItems(
    companyId, kind, sent.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, itemId: l.itemId, glAccountId: l.accountId })), stored, label,
  );
  return sent.map((l, i) => ({ ...l, itemId: out[i]!.itemId, accountId: out[i]!.glAccountId ?? l.accountId }));
}
