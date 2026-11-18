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
import {
  ItemLineRefusal, applyItemLineDefaults, guardDerivedPurchaseRates, itemVatTreatments, type ItemDefaultKind, type ItemDefaultOptions,
} from './itemLineDefaults';

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
  taxRate?: number | null;
  vatClassification?: string;
}

const key = (description: string, quantity: unknown, unitPrice: unknown): string =>
  JSON.stringify([description, Number(quantity).toFixed(4), Number(unitPrice).toFixed(2)]);

export async function resolveEditLineItems<T extends EditLine>(
  companyId: string,
  kind: ItemDefaultKind,
  sent: readonly T[],
  stored: readonly StoredItemLine[],
  label: (index: number) => string,
  opts: ItemDefaultOptions = {},
): Promise<T[]> {
  // A non-string item id (123, true, {}) is not an id to cast: refused here, as the create path refuses it.
  sent.forEach((l, i) => {
    if (l.itemId !== undefined && l.itemId !== null && typeof l.itemId !== 'string') throw new ItemLineRefusal(`${label(i)}.item_id must be a UUID`);
  });
  const pool = stored.map((s) => ({ key: key(s.description, s.quantity, s.unitPrice), itemId: s.itemId?.toLowerCase() ?? null, used: false }));
  const inherited = sent.map((l) => {
    const hit = pool.find((p) => !p.used && p.key === key(l.description, l.quantity, l.unitPrice));
    if (hit) hit.used = true;
    return hit?.itemId ?? null;
  });
  // Only a line naming an item its identical stored line did not carry is read and defaulted.
  const check = sent.map((l, i) => typeof l.itemId === 'string' && l.itemId !== '' && l.itemId.toLowerCase() !== inherited[i]);
  const checked = await applyItemLineDefaults(
    companyId, sent.map((l, i) => ({
      itemId: check[i] ? l.itemId : undefined, glAccountId: l.glAccountId, taxRate: l.taxRate, vatClassification: l.vatClassification,
    })), kind, label, opts,
  );
  const resolved = sent.map((l, i) => {
    if (check[i]) {
      const c = checked[i]!;
      return { ...l, itemId: c.itemId, glAccountId: c.glAccountId, ...(c.taxRate !== l.taxRate ? { taxRate: c.taxRate } : {}), ...(c.vatClassification !== l.vatClassification ? { vatClassification: c.vatClassification } : {}) };
    }
    if (l.itemId === null) return l;
    if (l.itemId === '') return { ...l, itemId: null }; // "" is no item, not an id to cast
    return typeof l.itemId === 'string' ? { ...l, itemId: l.itemId.toLowerCase() } : (inherited[i] ? { ...l, itemId: inherited[i] } : l);
  });
  // A resent or inherited line (not newly named, so not read above) that ends with an item and no rate takes the item's VAT as
  // it did at create: an exempt item's line must not fall back to the document's 15% because it was saved again unchanged.
  if (!opts.deriveTax) return resolved;
  const need = resolved.flatMap((l, i) => (!check[i] && typeof l.itemId === 'string' && l.itemId !== '' && (l.taxRate === undefined || l.taxRate === null) ? [i] : []));
  if (need.length === 0) return resolved;
  const vat = await itemVatTreatments(companyId, kind, need.map((i) => resolved[i]!.itemId as string));
  const derived = new Set<number>(); // a standard rate taken from the item is a claim nobody chose: guarded as at create
  const rated = resolved.map((l, i) => {
    const t = need.includes(i) ? vat.get((l.itemId as string).toLowerCase()) : undefined;
    if (t && t.taxRate > 0) derived.add(i);
    return t ? { ...l, taxRate: t.taxRate, ...(t.vatClassification && !l.vatClassification ? { vatClassification: t.vatClassification } : {}) } : l;
  });
  return guardDerivedPurchaseRates(companyId, kind, rated, derived);
}

interface AccountIdEditLine {
  description: string;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  itemId?: string | null;
  accountId?: string | null;
  taxRate?: number | null;
}

/** The same rule for lines that name their account `accountId` (quote lines). */
export async function resolveEditLineItemsAccountId<T extends AccountIdEditLine>(
  companyId: string, kind: ItemDefaultKind, sent: readonly T[], stored: readonly StoredItemLine[], label: (index: number) => string,
  opts: ItemDefaultOptions = {},
): Promise<T[]> {
  const out = await resolveEditLineItems(
    companyId, kind, sent.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, itemId: l.itemId, glAccountId: l.accountId, taxRate: l.taxRate })),
    stored, label, opts,
  );
  return sent.map((l, i) => ({ ...l, itemId: out[i]!.itemId, accountId: out[i]!.glAccountId ?? l.accountId, taxRate: out[i]!.taxRate ?? l.taxRate }));
}

interface SnakeEditLine {
  description: string;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  item_id?: string | null;
  gl_account_id?: string | null;
  tax_rate?: number | null;
}

/** The same rule for lines in the REST bodies' snake_case (the purchase-order PUT). */
export async function resolveEditLineItemsSnake<T extends SnakeEditLine>(
  companyId: string, kind: ItemDefaultKind, sent: readonly T[], stored: readonly StoredItemLine[], label: (index: number) => string,
  opts: ItemDefaultOptions = {},
): Promise<T[]> {
  const out = await resolveEditLineItems(
    companyId, kind, sent.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unit_price, itemId: l.item_id, glAccountId: l.gl_account_id, taxRate: l.tax_rate })),
    stored, label, opts,
  );
  return sent.map((l, i) => ({ ...l, item_id: out[i]!.itemId, gl_account_id: out[i]!.glAccountId ?? l.gl_account_id, tax_rate: out[i]!.taxRate ?? l.tax_rate }));
}
