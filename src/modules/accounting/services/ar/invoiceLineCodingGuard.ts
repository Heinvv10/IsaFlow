/**
 * Which revenue account, project and cost centre a customer invoice line may
 * name. Checked when a line is coded (create, draft edit, the MCP create
 * tools, a recurring template) AND again before the invoice posts (approve,
 * bulk finalize, Post to GL): an account can be deactivated, gain children or
 * be reclassified, and a cost centre deactivated, after the line names it.
 *
 * A line credits revenue, so its account must be:
 *  - this company's (`gl_account_id` is a single-column FK: another tenant's
 *    account satisfies it, and RI bypasses RLS);
 *  - account_type 'revenue' — which already excludes AR/AP control, bank, VAT,
 *    equity and every system-only subtype the bill guard lists one by one;
 *  - a leaf (a header is hidden from every picker) and active.
 * A project must be this company's and not cancelled; a cost centre this
 * company's and active. One message for a foreign, deleted or invented id, so
 * no reply says whether another company's id exists.
 *
 * The accounts are read FOR SHARE in id order — the order the GL account merge
 * locks them (`lockGlAccountsForUpdate`) — so a merge or deactivation cannot
 * land between this check and the caller's write in the same transaction.
 * Projects and cost centres are plain reads: the journal writer re-checks
 * their ownership (`journalLineOwnership`) in the same transaction anyway.
 */
import { sql } from '@/lib/neon';
import { isCoded, type InvoiceLineCoding } from './invoiceLineCoding';
import { revenueLinesInconsistency, type StoredRevenueLine } from './invoiceRevenueLines';

export const FOREIGN_LINE_CODING = 'One or more invoice lines name an account, project or cost centre that is not in your company.';

const POSTING_HINT = ' Recode the line on the draft, or cancel the invoice and re-enter it.';

export interface RevenueLineAccountRow {
  account_code: string;
  account_name: string;
  account_type: string;
  is_active: boolean;
  has_children: boolean;
}

/** Why an invoice line may not credit this account, or null when it may. */
export function revenueLineAccountProblem(a: RevenueLineAccountRow): string | null {
  if (a.account_type !== 'revenue') return `is not a revenue account (it is ${a.account_type})`;
  if (a.has_children) return 'is a header account with sub-accounts; choose one of those';
  if (!a.is_active) return 'is inactive';
  return null;
}

/** Unique, non-null, lower-cased: Postgres reads 'ABC…' and 'abc…' as one uuid and returns one row. */
const present = (ids: readonly (string | null)[]): string[] =>
  [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== '').map((id) => id.toLowerCase()))];

async function accountRows(companyId: string, ids: string[], lock: boolean): Promise<RevenueLineAccountRow[]> {
  return (lock
    ? await sql`
        SELECT a.account_code, a.account_name, a.account_type, a.is_active,
               EXISTS (SELECT 1 FROM gl_accounts c
                       WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
        FROM gl_accounts a
        WHERE a.company_id = ${companyId}::UUID AND a.id = ANY(${ids}::UUID[])
        ORDER BY a.id
        FOR SHARE OF a`
    : await sql`
        SELECT a.account_code, a.account_name, a.account_type, a.is_active,
               EXISTS (SELECT 1 FROM gl_accounts c
                       WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
        FROM gl_accounts a
        WHERE a.company_id = ${companyId}::UUID AND a.id = ANY(${ids}::UUID[])`
  ) as RevenueLineAccountRow[];
}

/**
 * Why these line codings cannot be accepted, or null. `lock: false` is for a
 * read-only pass that only decides what to skip (bulk finalize and its dry
 * run); the posting path re-checks under lock.
 */
export async function invoiceLineCodingRefusal(
  companyId: string,
  codings: readonly InvoiceLineCoding[],
  opts: { lock?: boolean } = {},
): Promise<string | null> {
  const accounts = present(codings.map((c) => c.glAccountId));
  if (accounts.length > 0) {
    const rows = await accountRows(companyId, accounts, opts.lock ?? true);
    if (rows.length !== accounts.length) return FOREIGN_LINE_CODING;
    for (const row of [...rows].sort((x, y) => x.account_code.localeCompare(y.account_code))) {
      const problem = revenueLineAccountProblem(row);
      if (problem) return `An invoice line cannot be coded to ${row.account_code} ${row.account_name}: it ${problem}.`;
    }
  }

  const projects = present(codings.map((c) => c.projectId));
  if (projects.length > 0) {
    const rows = (await sql`
      SELECT project_number, name, status FROM projects
      WHERE company_id = ${companyId}::UUID AND id = ANY(${projects}::UUID[])
    `) as { project_number: string; name: string; status: string }[];
    if (rows.length !== projects.length) return FOREIGN_LINE_CODING;
    const cancelled = rows.find((p) => p.status === 'cancelled');
    if (cancelled) return `An invoice line cannot be tagged to project ${cancelled.project_number} ${cancelled.name}: it is cancelled.`;
  }

  const centres = present(codings.map((c) => c.costCenterId));
  if (centres.length > 0) {
    const rows = (await sql`
      SELECT code, name, is_active FROM cost_centres
      WHERE company_id = ${companyId}::UUID AND id = ANY(${centres}::UUID[])
    `) as { code: string; name: string; is_active: boolean }[];
    if (rows.length !== centres.length) return FOREIGN_LINE_CODING;
    const inactive = rows.find((c) => !c.is_active);
    if (inactive) return `An invoice line cannot be tagged to cost centre ${inactive.code} ${inactive.name}: it is inactive.`;
  }
  return null;
}

/** An invoice's stored lines, oldest first; `null` when the invoice is not this company's. */
export async function storedInvoiceLines(
  companyId: string,
  invoiceId: string,
): Promise<{ invoiceNumber: string; subtotal: number; lines: StoredRevenueLine[] } | null> {
  const rows = (await sql`
    SELECT ci.invoice_number, ci.subtotal, cii.id AS line_id, cii.amount,
           cii.gl_account_id, cii.project_id, cii.cost_center_id
    FROM customer_invoices ci
    LEFT JOIN customer_invoice_items cii ON cii.invoice_id = ci.id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    ORDER BY cii.created_at, cii.id
  `) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const id = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    invoiceNumber: String(rows[0]!.invoice_number),
    subtotal: Number(rows[0]!.subtotal),
    lines: rows.filter((r) => r.line_id != null).map((r) => ({
      amount: Number(r.amount),
      glAccountId: id(r.gl_account_id),
      projectId: id(r.project_id),
      costCenterId: id(r.cost_center_id),
    })),
  };
}

/**
 * Why this invoice's STORED lines cannot post, or null: the coding rules
 * against the chart as it is now, and lines that do not add up to the
 * subtotal. An invoice none of whose lines is coded posts as it always did and
 * is never refused here.
 */
export async function storedInvoiceLinesRefusal(
  companyId: string,
  invoiceId: string,
  opts: { lock?: boolean } = {},
): Promise<string | null> {
  return storedLinesRefusal(companyId, await storedInvoiceLines(companyId, invoiceId), opts);
}

/** The same over lines already read. */
export async function storedLinesRefusal(
  companyId: string,
  stored: { invoiceNumber: string; subtotal: number; lines: StoredRevenueLine[] } | null,
  opts: { lock?: boolean } = {},
): Promise<string | null> {
  if (!stored || !stored.lines.some(isCoded)) return null;
  const coding = await invoiceLineCodingRefusal(companyId, stored.lines, opts);
  if (coding) return `Invoice ${stored.invoiceNumber}: ${coding}${POSTING_HINT}`;
  const inconsistency = revenueLinesInconsistency(stored.lines, stored.subtotal);
  return inconsistency
    ? `Invoice ${stored.invoiceNumber}: ${inconsistency}. Re-save the draft so its totals are recalculated.`
    : null;
}

/** The same, read-only, per invoice — for a batch that skips what approve would refuse. */
export async function storedInvoiceLinesRefusals(
  companyId: string,
  invoiceIds: readonly string[],
): Promise<Map<string, string>> {
  const refusals = new Map<string, string>();
  for (const id of invoiceIds) {
    const refusal = await storedInvoiceLinesRefusal(companyId, id, { lock: false });
    if (refusal) refusals.set(id, refusal);
  }
  return refusals;
}
