/**
 * A document line may name the catalogue item it is for (`item_id`, migration 1002) on a purchase order, a bill, a
 * customer invoice or a quote. With an item and no `gl_account_id` the line takes the item's default account: the
 * PURCHASES account on a PO or bill, the SALES account on an invoice or quote. An account the line names itself always
 * wins. Dimensions (CC1 / CC2 / BU) are not touched.
 *
 * An item that is not this company's, that has been deleted, or that is inactive refuses the line. The refusal is
 * raised BEFORE the document's first write, by every writer that calls this, and the message for another company's
 * item is the one for an item that does not exist.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';

/** Registered in `mcp/tools/refusalCodes.ts`: the message reaches an MCP caller. Names only the caller's own line. */
export class ItemLineRefusal extends Error {
  readonly code = 'ITEM_LINE_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'ItemLineRefusal';
  }
}

export type ItemDefaultKind = 'purchase' | 'sales';

interface LineWithItem {
  itemId?: string | null;
  glAccountId?: string | null;
}

/**
 * Returns the lines with `glAccountId` filled from the item where the line named an item and no account. A batch with
 * no item is returned as given and reads nothing.
 */
export async function applyItemLineDefaults<T extends LineWithItem>(
  companyId: string,
  lines: readonly T[],
  kind: ItemDefaultKind,
  label: (index: number) => string,
): Promise<T[]> {
  const named = lines.flatMap((l, i) => (l.itemId === undefined || l.itemId === null || l.itemId === '' ? [] : [{ id: l.itemId, i }]));
  if (named.length === 0) return [...lines];
  for (const { id, i } of named) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new ItemLineRefusal(`${label(i)}.item_id must be a UUID`);
  }
  const ids = [...new Set(named.map((n) => n.id.toLowerCase()))];
  const rows = (await sql`
    SELECT id, is_active, sales_account_id, purchases_account_id FROM items
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND deleted_at IS NULL
  `) as DbRow[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const { id, i } of named) {
    const item = byId.get(id.toLowerCase());
    if (!item) throw new ItemLineRefusal(`${label(i)}.item_id is not an item of your company`);
    if (item.is_active === false) throw new ItemLineRefusal(`${label(i)}.item_id is an inactive item`);
  }
  // The account a line would take from its item must be this company's and active (the UI stores an item's
  // accounts unchecked, and a document line has no later guard on every path).
  const column = kind === 'purchase' ? 'purchases_account_id' : 'sales_account_id';
  const defaults = named
    .filter(({ i }) => !lines[i]!.glAccountId)
    .map(({ id }) => byId.get(id.toLowerCase())?.[column])
    .filter((a): a is string => typeof a === 'string');
  if (defaults.length > 0) {
    const accounts = (await sql`
      SELECT id, is_active FROM gl_accounts WHERE company_id = ${companyId}::UUID AND id = ANY(${[...new Set(defaults)]}::UUID[])
    `) as DbRow[];
    const live = new Set(accounts.filter((a) => a.is_active !== false).map((a) => String(a.id)));
    for (const { id, i } of named) {
      const acct = lines[i]!.glAccountId ? null : byId.get(id.toLowerCase())?.[column];
      if (typeof acct === 'string' && !live.has(acct)) {
        throw new ItemLineRefusal(`${label(i)}.item_id: the item's ${kind} account is not an active account of your company; name gl_account_id or fix the item`);
      }
    }
  }
  return lines.map((l) => {
    if (l.itemId === undefined || l.itemId === null || l.itemId === '') return l;
    const item = byId.get(l.itemId.toLowerCase())!;
    const fallback = kind === 'purchase' ? item.purchases_account_id : item.sales_account_id;
    return {
      ...l,
      itemId: l.itemId.toLowerCase(),
      glAccountId: l.glAccountId ? l.glAccountId : fallback ? String(fallback) : l.glAccountId,
    };
  });
}

interface AccountKeyedLine {
  itemId?: string | null;
  accountId?: string | null;
}

/** The same defaulting for lines that name their account `accountId` (quote lines). */
export async function applyItemDefaultsToAccountIdLines<T extends AccountKeyedLine>(
  companyId: string,
  lines: readonly T[],
  kind: ItemDefaultKind,
  label: (index: number) => string,
): Promise<T[]> {
  const defaulted = await applyItemLineDefaults(
    companyId, lines.map((l) => ({ itemId: l.itemId, glAccountId: l.accountId })), kind, label,
  );
  return lines.map((l, i) => {
    const d = defaulted[i]!;
    return d.itemId ? { ...l, itemId: d.itemId, accountId: d.glAccountId ?? l.accountId } : l;
  });
}

interface SnakeLine {
  item_id?: string | null;
  gl_account_id?: string | null;
}

/** The same defaulting for lines in the REST bodies' snake_case (`item_id`, `gl_account_id`): the PO PUT. */
export async function applyItemDefaultsToSnakeLines<T extends SnakeLine>(
  companyId: string,
  lines: readonly T[],
  kind: ItemDefaultKind,
  label: (index: number) => string,
): Promise<T[]> {
  const defaulted = await applyItemLineDefaults(
    companyId, lines.map((l) => ({ itemId: l.item_id, glAccountId: l.gl_account_id })), kind, label,
  );
  return lines.map((l, i) => {
    const d = defaulted[i]!;
    return d.itemId ? { ...l, item_id: d.itemId, gl_account_id: d.glAccountId ?? l.gl_account_id } : l;
  });
}
