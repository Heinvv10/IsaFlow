/**
 * The budget check at purchase-order approval (budgets P5-3; spec §3b call site 3, decisions 8a-8c; census items 2
 * and 7). The document-agnostic check is `budgets/budgetCheck.ts`; this keys it on a PO (`purchase_orders` /
 * `po_items`, mig 246b + 954's line dimensions).
 *
 * - Lines: every `po_items` row, its account and CC1 / CC2 / BU, at its ex-VAT `line_total` (qty × unit price on
 *   both writers): the figure P5-1's committed counts for the same line once the PO is approved.
 * - A line with NO account (every line the create route writes: census 7) cannot meet a budget: it is "No budget",
 *   never over, never refused. It is not checked and no account is invented for it; the preview lists it as
 *   "No account".
 * - Month: the PO's `order_date` (decision 8b), read as text ('YYYY-MM'), never via a JS Date.
 * - `excludePoItemIds` = the PO's own lines: it is judged against everything but itself (a draft commits nothing
 *   anyway; an approved PO previewed must not count its own commitment twice).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { toCents } from '../budgets/grid/cents';
import {
  checkDocumentBudget, evaluateDocumentLines, labelBudgetLines, readCheckPolicy,
} from '../budgets/budgetCheck';
import type { DocumentLine, UnlabelledLine } from '../budgets/budgetCheckCore';
import type {
  BudgetCheckContext, BudgetCheckLine, BudgetCheckResult, BudgetGate, BudgetPolicy,
} from '../budgets/budgetCheckTypes';

/** The statuses the Approve action accepts (the PUT's editable statuses; 246b's CHECK). */
export const APPROVABLE_PO_STATUSES: readonly string[] = ['draft', 'submitted'];

/** The PO header fields the check needs. */
export interface PoHeader {
  id: string;
  poNumber: string;
  status: string;
  /** 'YYYY-MM' of order_date. */
  month: string;
}

export const poHeaderOf = (r: DbRow): PoHeader => ({
  id: String(r.id), poNumber: String(r.po_number), status: String(r.status), month: String(r.month),
});

/** The header, company-scoped, no lock (the preview); null when it is not this company's. */
export async function readPoHeader(companyId: string, poId: string): Promise<PoHeader | null> {
  const rows = (await sql`
    SELECT id, po_number, status, to_char(order_date, 'YYYY-MM') AS month
      FROM purchase_orders WHERE id = ${poId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows[0] ? poHeaderOf(rows[0]) : null;
}

interface PoBudgetLines {
  /** Lines with an account: the ones checked. */
  lines: DocumentLine[];
  /** Lines with no account: "No budget". */
  noAccount: DocumentLine[];
  itemIds: string[];
}

const id = (v: unknown): string | null => (v == null ? null : String(v).toLowerCase());

/** The PO's lines, through the parent's company (po_items has no company_id). */
async function readPoBudgetLines(companyId: string, poId: string): Promise<PoBudgetLines> {
  const rows = (await sql`
    SELECT pi.id, pi.gl_account_id, pi.cc1_id, pi.cc2_id, pi.bu_id, pi.line_total::TEXT AS line_total
      FROM po_items pi
      JOIN purchase_orders po ON po.id = pi.purchase_order_id AND po.company_id = ${companyId}::UUID
     WHERE pi.purchase_order_id = ${poId}::UUID
     ORDER BY pi.sort_order, pi.id
  `) as DbRow[];
  const out: PoBudgetLines = { lines: [], noAccount: [], itemIds: [] };
  for (const r of rows) {
    out.itemIds.push(String(r.id));
    const line = { glAccountId: id(r.gl_account_id) ?? '', cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id), amount: Number(r.line_total) };
    (line.glAccountId === '' ? out.noAccount : out.lines).push(line);
  }
  return out;
}

/** The lines with no account, one per slice (summed in cents), as "No budget" lines. */
function noAccountLines(lines: readonly DocumentLine[], month: string): UnlabelledLine[] {
  const bySlice = new Map<string, UnlabelledLine & { cents: number }>();
  for (const l of lines) {
    const k = `${l.cc1Id ?? ''}|${l.cc2Id ?? ''}|${l.buId ?? ''}`;
    const at = bySlice.get(k) ?? {
      glAccountId: '', month, grain: null, cc1Id: l.cc1Id, cc2Id: l.cc2Id, buId: l.buId, unassigned: false,
      budget: null, actual: 0, committed: 0, remaining: null, amount: 0, over: false, cents: 0,
    };
    at.cents += toCents(l.amount);
    bySlice.set(k, at);
  }
  return [...bySlice.values()].filter((l) => l.cents !== 0).map(({ cents, ...l }) => ({ ...l, amount: cents / 100 }));
}

/**
 * The check (§3b), under the PO row lock, before the PO's first write. Lines with no account are not checked.
 * Throws as `checkDocumentBudget` does (the refusal's event is for the catcher to record).
 */
export async function checkPurchaseOrderBudget(
  companyId: string, po: PoHeader, gate: BudgetGate, ctx: BudgetCheckContext, actorId: string,
): Promise<BudgetCheckResult> {
  const { lines, itemIds } = await readPoBudgetLines(companyId, po.id);
  return checkDocumentBudget(companyId, {
    type: 'purchase_order', id: po.id, ref: po.poNumber, month: po.month, lines, excludePoItemIds: itemIds,
  }, ctx, gate, actorId);
}

export interface PoBudgetPreview {
  policy: BudgetPolicy;
  /** False when the policy is off: approving checks nothing. */
  checks: boolean;
  status: string;
  /** Whether the Approve action accepts this PO's status. */
  approvable: boolean;
  lines: BudgetCheckLine[];
  overCount: number;
}

/**
 * What the PO approve dialog shows: the same lines and remaining approval would check, plus the lines with no
 * account ("No account", no budget), read without any lock (a preview; the approval decides again under its
 * locks). Null when the PO is not this company's.
 */
export async function previewPurchaseOrderBudget(companyId: string, poId: string): Promise<PoBudgetPreview | null> {
  const po = await readPoHeader(companyId, poId);
  if (!po) return null;
  const policy = await readCheckPolicy(companyId);
  const approvable = APPROVABLE_PO_STATUSES.includes(po.status);
  if (policy === 'off') return { policy, checks: false, status: po.status, approvable, lines: [], overCount: 0 };
  const { lines, noAccount, itemIds } = await readPoBudgetLines(companyId, po.id);
  const checked = await evaluateDocumentLines(companyId, lines, po.month, { excludePoItemIds: itemIds, labelAlways: true });
  const none = await labelBudgetLines(companyId, noAccountLines(noAccount, po.month));
  return { policy, checks: true, status: po.status, approvable, lines: [...checked, ...none], overCount: checked.filter((l) => l.over).length };
}
