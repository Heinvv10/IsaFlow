/**
 * A bill that settles a bank-first provisional (R-127) inherits the provisional's dimensions on lines that name none
 * (budgets P5-2b, breaker PROBE 3; Hein's ruling, 2026-11-04).
 *
 * The provisional already expensed the slip on its own account and slice (say opex · FT); approving the bill posts
 * the bill's expense and reclasses the provisional's lines away. A bill line with no CC1 / CC2 / BU posted the expense
 * on the unassigned slice while the reclass credited FT, so the spend moved off FT and, under a block budget policy,
 * the bill was refused as off-slice. Rule, per bill line that names no CC1, CC2 or BU (and carries no legacy
 * cost-centre pick, item or bill): the provisional's line on the SAME account (the line's own, else the default
 * expense account it posts to) gives its dimensions; of several, the one whose amount matches the line's posted net
 * (to the cent); none matching, or several matching, nothing is guessed and the line stays as it is. A provisional
 * line carrying a dimension since deactivated gives nothing either: approval refuses an inactive dimension on a
 * line it posts (`assertPostsStoredDimensions`), while the provisional's own reclass still copies it (R-127).
 *
 * Live (approve and Post to GL, after the claim and before the lines are built and checked): the inherited
 * dimensions are WRITTEN to `supplier_invoice_items`, so the bill shows what it posted. The preview and the MCP dry
 * run apply the same rule to the unlocked provisional (`peekProvisionalReclassLines`) without writing.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { SupplierInvoice, SupplierInvoiceItem } from '../../types/ap.types';
import type { ProvisionalClaim } from './provisionalSettlementClaim';
import type { DocumentLine } from '../budgets/budgetCheckCore';

/** A provisional journal line: its account, dimensions and net (debit − credit). */
export interface ProvisionalDimLine {
  glAccountId: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  net: number;
}

const cents = (n: number): number => Math.round(n * 100);
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Each item's posted net, as `buildExpenseLines` allocates it (gross storage scaled to the subtotal). */
function postedNets(invoice: SupplierInvoice): number[] {
  const items = invoice.items ?? [];
  const sum = items.reduce((s, i) => s + i.lineTotal, 0);
  const gross = invoice.taxRate > 0 && Math.abs(sum - invoice.totalAmount) < 0.02 && sum > 0;
  return items.map((i) => (gross ? i.lineTotal * (invoice.subtotal / sum) : i.lineTotal));
}

const namesNoDimension = (item: SupplierInvoiceItem, invoice: SupplierInvoice): boolean =>
  !item.cc1Id && !item.cc2Id && !item.buId && !item.costCenterId && !invoice.costCenterId;

/** Pure: the invoice with the inherited dimensions on its items, and the items that took them. */
export function inheritProvisionalDimensions(
  invoice: SupplierInvoice, provisional: readonly ProvisionalDimLine[], defaultExpenseId: string, active: ReadonlySet<string>,
): { invoice: SupplierInvoice; inherited: SupplierInvoiceItem[] } {
  const items = invoice.items ?? [];
  if (provisional.length === 0 || items.length === 0) return { invoice, inherited: [] };
  const nets = postedNets(invoice);
  const inherited: SupplierInvoiceItem[] = [];
  const next = items.map((item, i) => {
    if (!namesNoDimension(item, invoice)) return item;
    const account = item.glAccountId || defaultExpenseId;
    const onAccount = provisional.filter((p) => same(p.glAccountId, account) && p.net > 0);
    const pick = onAccount.length === 1 ? onAccount
      : onAccount.filter((p) => Math.abs(cents(p.net) - cents(nets[i] ?? 0)) <= 1);
    const from = pick.length === 1 ? pick[0]! : null;
    const dims = from ? [from.cc1Id, from.cc2Id, from.buId].filter((d): d is string => d !== null) : [];
    if (dims.length === 0 || !dims.every((d) => active.has(d.toLowerCase()))) return item;
    const src = from!;
    const withDims: SupplierInvoiceItem = {
      ...item,
      ...(src.cc1Id ? { cc1Id: src.cc1Id } : {}), ...(src.cc2Id ? { cc2Id: src.cc2Id } : {}), ...(src.buId ? { buId: src.buId } : {}),
    };
    inherited.push(withDims);
    return withDims;
  });
  return { invoice: inherited.length > 0 ? { ...invoice, items: next } : invoice, inherited };
}

/** The provisional lines' dimensions that are this company's ACTIVE masters (lower-cased ids). */
export async function activeDimensionIds(companyId: string, lines: readonly ProvisionalDimLine[]): Promise<Set<string>> {
  const centres = [...new Set(lines.flatMap((l) => [l.cc1Id, l.cc2Id]).filter((v): v is string => v !== null))];
  const units = [...new Set(lines.map((l) => l.buId).filter((v): v is string => v !== null))];
  const out = new Set<string>();
  if (centres.length > 0) {
    for (const r of (await sql`SELECT id::TEXT AS id FROM cost_centres WHERE company_id = ${companyId}::UUID AND is_active
                                 AND id = ANY(${centres}::UUID[])`) as DbRow[]) out.add(String(r.id).toLowerCase());
  }
  if (units.length > 0) {
    for (const r of (await sql`SELECT id::TEXT AS id FROM business_units WHERE company_id = ${companyId}::UUID AND is_active
                                 AND id = ANY(${units}::UUID[])`) as DbRow[]) out.add(String(r.id).toLowerCase());
  }
  return out;
}

/** The claim's settle lines as `ProvisionalDimLine`s. */
export const claimDimLines = (claim: ProvisionalClaim | null | undefined): ProvisionalDimLine[] =>
  (claim?.settleLines ?? []).map((l) => ({
    glAccountId: l.glAccountId, cc1Id: l.cc1Id ?? null, cc2Id: l.cc2Id ?? null, buId: l.buId ?? null, net: (l.debit || 0) - (l.credit || 0),
  }));

/** The preview's reclass lines (credits of the provisional's lines) back as the provisional's own lines. */
export const reclassDimLines = (reclass: readonly DocumentLine[]): ProvisionalDimLine[] =>
  reclass.map((l) => ({ glAccountId: l.glAccountId, cc1Id: l.cc1Id, cc2Id: l.cc2Id, buId: l.buId, net: -l.amount }));

/**
 * Live: inherits from the CLAIMED provisional and writes the inherited dimensions to the bill's lines (only to a line
 * that still names none). Call after `claimEvidencedProvisional`, under the bill's row lock, before the lines are built.
 */
export async function applyProvisionalDimensions(
  companyId: string, invoice: SupplierInvoice, claim: ProvisionalClaim | null | undefined, defaultExpenseId: string,
): Promise<SupplierInvoice> {
  const lines = claimDimLines(claim);
  if (lines.length === 0) return invoice;
  const { invoice: out, inherited } = inheritProvisionalDimensions(invoice, lines, defaultExpenseId, await activeDimensionIds(companyId, lines));
  for (const item of inherited) {
    await sql`
      UPDATE supplier_invoice_items sii
         SET cc1_id = ${item.cc1Id ?? null}::UUID, cc2_id = ${item.cc2Id ?? null}::UUID, bu_id = ${item.buId ?? null}::UUID
        FROM supplier_invoices si
       WHERE sii.id = ${item.id}::UUID AND sii.supplier_invoice_id = si.id
         AND si.id = ${invoice.id}::UUID AND si.company_id = ${companyId}::UUID
         AND sii.cc1_id IS NULL AND sii.cc2_id IS NULL AND sii.bu_id IS NULL
    `;
  }
  return out;
}
