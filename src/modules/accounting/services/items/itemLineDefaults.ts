/**
 * A document line may name the catalogue item it is for (`item_id`, migration 1005) on a purchase order, a bill, a
 * customer invoice or a quote. With an item and no `gl_account_id` the line takes the item's default account: the
 * PURCHASES account on a PO or bill, the SALES account on an invoice or quote. An account the line names itself always
 * wins. Dimensions (CC1 / CC2 / BU) are not touched.
 *
 * An item that is not this company's, that has been deleted, or that is inactive refuses the line. The refusal is
 * raised BEFORE the document's first write, by every writer that calls this, and the message for another company's
 * item is the one for an item that does not exist.
 *
 * A rate DERIVED from the item on a purchase line is an input-VAT claim nobody chose, so it goes through the unattended
 * VAT guard (`guardDerivedPurchaseRates`); a rate the caller names is theirs and stands.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { SA_STANDARD_VAT_RATE_PCT } from '@/lib/vat/standardRate';
import { VAT_CODE_STANDARD, fetchVatDenialFlags } from '../gl/inputVatDenial';
import { fetchAccountNames } from '../gl/nonSupplyVatGuard';
import { fetchBankContraFlags } from '../gl/bankContraVat';
import { resolveRuleVatCode } from '../gl/ruleVatResolution';

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
  /** Percent. With `deriveTax`, a line that names an item and has none takes the item's VAT type for the side. */
  taxRate?: number | null;
  vatClassification?: string;
}

export interface ItemDefaultOptions {
  /**
   * Derive a missing line `taxRate` from the item's VAT type on that side (`vat_on_purchases` for a PO / bill,
   * `vat_on_sales` for a sales document): standard = the statutory rate (lib/vat/standardRate, as the items screen), zero = 0 with
   * vat_classification zero_rated, exempt = 0 with exempt. Set it only where the document has a per-line rate and the
   * caller named no rate for the document either. Never on a customer invoice or (migration 1024) a quote: their lines
   * take a VAT type, the item's vat_on_sales one step of its default chain (ar/invoiceLineVatTypes).
   */
  deriveTax?: boolean;
}

/** The rate and VAT classification an item's VAT type gives a line (the items screen's three values). */
export function itemVatTreatment(vatType: unknown): { taxRate: number; vatClassification?: 'zero_rated' | 'exempt' } | null {
  if (vatType === 'standard') return { taxRate: SA_STANDARD_VAT_RATE_PCT };
  if (vatType === 'zero') return { taxRate: 0, vatClassification: 'zero_rated' };
  if (vatType === 'exempt') return { taxRate: 0, vatClassification: 'exempt' };
  return null;
}

/**
 * The VAT treatment of items a line ALREADY carries (a draft edit's resent / inherited lines): read without the active check
 * (an item deactivated since still gives its VAT), company-scoped. Returns per input id the treatment, or nothing for an item
 * that is missing, deleted or has an unknown VAT type.
 */
export async function itemVatTreatments(
  companyId: string, kind: ItemDefaultKind, itemIds: readonly string[],
): Promise<Map<string, NonNullable<ReturnType<typeof itemVatTreatment>>>> {
  const out = new Map<string, NonNullable<ReturnType<typeof itemVatTreatment>>>();
  const ids = [...new Set(itemIds.map((i) => i.toLowerCase()))];
  if (ids.length === 0) return out;
  const rows = (await sql`
    SELECT id, vat_on_sales, vat_on_purchases FROM items
    WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[]) AND deleted_at IS NULL
  `) as DbRow[];
  for (const r of rows) {
    const t = itemVatTreatment(kind === 'purchase' ? r.vat_on_purchases : r.vat_on_sales);
    if (t) out.set(String(r.id).toLowerCase(), t);
  }
  return out;
}

/**
 * The lines at `derived` took the standard rate from their item, not from the caller. On a purchase line that is an input-VAT
 * claim made unattended, so each goes through the unattended guard (gl/ruleVatResolution: an account whose input tax is
 * denied under s17(2)(a), an account no supply arises on, a bank account) and takes 0 where the guard drops the claim. The
 * guard logs each drop. A sales line is output VAT and is returned as given; so is a line with no account to judge.
 */
export async function guardDerivedPurchaseRates<T extends { glAccountId?: string | null; taxRate?: number | null }>(
  companyId: string, kind: ItemDefaultKind, lines: readonly T[], derived: ReadonlySet<number>,
): Promise<T[]> {
  const accountOf = (i: number): string | null => (derived.has(i) && lines[i]!.glAccountId ? lines[i]!.glAccountId!.toLowerCase() : null);
  const ids = [...new Set(lines.flatMap((_, i) => accountOf(i) ?? []))];
  if (kind !== 'purchase' || ids.length === 0) return [...lines];
  const [denied, names, banks] = await Promise.all([
    fetchVatDenialFlags(companyId, ids), fetchAccountNames(companyId, ids), fetchBankContraFlags(companyId, ids),
  ]);
  const dropped = new Set<string>();
  for (const id of ids) {
    const decision = await resolveRuleVatCode({
      allocType: 'account', companyId, requestedVatCode: VAT_CODE_STANDARD, glAccountId: id,
      ruleGlAccountVatDenied: denied.get(id) ?? false, ruleGlAccountName: names.get(id) ?? null, ruleGlAccountIsBank: banks.get(id) ?? false,
      denialContext: { source: 'item_line_default' }, guardContext: { glAccountId: id },
    });
    if (decision.vatCode !== VAT_CODE_STANDARD) dropped.add(id);
  }
  return lines.map((l, i) => (dropped.has(accountOf(i) ?? '') ? { ...l, taxRate: 0 } : l));
}

/**
 * Returns the lines with `glAccountId` filled from the item where the line named an item and no account (and, with
 * `deriveTax`, `taxRate` where it had none). A batch with no item is returned as given and reads nothing.
 */
export async function applyItemLineDefaults<T extends LineWithItem>(
  companyId: string,
  lines: readonly T[],
  kind: ItemDefaultKind,
  label: (index: number) => string,
  opts: ItemDefaultOptions = {},
): Promise<T[]> {
  const named = lines.flatMap((l, i) => (l.itemId === undefined || l.itemId === null || l.itemId === '' ? [] : [{ id: l.itemId, i }]));
  if (named.length === 0) return lines.map((l) => (l.itemId === '' ? { ...l, itemId: null } : l));
  for (const { id, i } of named) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new ItemLineRefusal(`${label(i)}.item_id must be a UUID`);
  }
  const ids = [...new Set(named.map((n) => n.id.toLowerCase()))];
  const rows = (await sql`
    SELECT id, is_active, sales_account_id, purchases_account_id, vat_on_sales, vat_on_purchases FROM items
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
  const derived = new Set<number>(); // the lines whose STANDARD rate came from the item
  const out = lines.map((l, i) => {
    if (l.itemId === '') return { ...l, itemId: null }; // an empty string is "no item": never reaches a ::UUID cast
    if (l.itemId === undefined || l.itemId === null) return l;
    const item = byId.get(l.itemId.toLowerCase())!;
    const fallback = kind === 'purchase' ? item.purchases_account_id : item.sales_account_id;
    const vat = opts.deriveTax && (l.taxRate === undefined || l.taxRate === null)
      ? itemVatTreatment(kind === 'purchase' ? item.vat_on_purchases : item.vat_on_sales) : null;
    if (vat && vat.taxRate > 0) derived.add(i);
    return {
      ...l,
      itemId: l.itemId.toLowerCase(),
      glAccountId: l.glAccountId ? l.glAccountId : fallback ? String(fallback) : l.glAccountId,
      ...(vat ? { taxRate: vat.taxRate, ...(vat.vatClassification && !l.vatClassification ? { vatClassification: vat.vatClassification } : {}) } : {}),
    };
  });
  return guardDerivedPurchaseRates(companyId, kind, out, derived);
}

interface AccountKeyedLine {
  itemId?: string | null;
  accountId?: string | null;
  taxRate?: number | null;
}

/** The same defaulting for lines that name their account `accountId` (quote lines). */
export async function applyItemDefaultsToAccountIdLines<T extends AccountKeyedLine>(
  companyId: string,
  lines: readonly T[],
  kind: ItemDefaultKind,
  label: (index: number) => string,
  opts: ItemDefaultOptions = {},
): Promise<T[]> {
  const defaulted = await applyItemLineDefaults(
    companyId, lines.map((l) => ({ itemId: l.itemId, glAccountId: l.accountId, taxRate: l.taxRate })), kind, label, opts,
  );
  return lines.map((l, i) => {
    const d = defaulted[i]!;
    return d.itemId ? { ...l, itemId: d.itemId, accountId: d.glAccountId ?? l.accountId, taxRate: d.taxRate ?? l.taxRate } : l;
  });
}
