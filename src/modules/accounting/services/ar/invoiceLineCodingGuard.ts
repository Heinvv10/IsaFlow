/**
 * Which revenue account and job a customer invoice line may name. Checked when
 * a line is coded (create, draft edit, the MCP create tools, a recurring
 * template) AND again before the invoice posts (approve, bulk finalize, Post
 * to GL): an account can be deactivated, gain children or be reclassified, and
 * a job cancelled, after the line names it. The line's CC1 / CC2 / BU are the
 * dimensions model's (gl/dimensions): checked at save by its own
 * assertDocumentDimensions, and again here before posting — as stored: the
 * customer's FNO is stamped on the lines at save (#675), never filled here.
 *
 * A line credits revenue, so its account must be:
 *  - this company's (`gl_account_id` is a single-column FK: another tenant's
 *    account satisfies it, and RI bypasses RLS);
 *  - account_type 'revenue' — which already excludes AR/AP control, bank, VAT,
 *    equity and every system-only subtype the bill guard lists one by one;
 *  - a leaf (a header is hidden from every picker) and active.
 * A job must be this company's and not cancelled. One message for a foreign,
 * deleted or invented id, so no reply says whether another company's id exists.
 *
 * The accounts are read FOR SHARE in id order — the order the GL account merge
 * locks them (`lockGlAccountsForUpdate`) — so a merge or deactivation cannot
 * land between this check and the caller's write in the same transaction.
 * Jobs are plain reads: the journal writer re-checks their ownership
 * (`journalLineOwnership`) in the same transaction anyway.
 */
import { sql } from '@/lib/neon';
import {
  InvoiceLineAccountLockError, InvoiceLineCodingRefusal, readCodingId, type InvoiceLineCoding,
} from './invoiceLineCoding';
import { isRevenueCoded, revenueLinesProblem, revenueSplitDependsOnLines, type StoredRevenueLine } from './invoiceRevenueLines';
import { assertPostsStoredDimensions } from '../gl/dimensions/dimensionStoredPosting';
import { isDimensionRefusal } from '../gl/dimensions/dimensionTypes';

export const FOREIGN_LINE_CODING = 'One or more invoice lines name an account or job that is not in your company.';

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

const isLockRace = (err: unknown): boolean => {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return code === '40P01' || code === '55P03';
};

async function accountRows(companyId: string, ids: string[], lock: boolean): Promise<RevenueLineAccountRow[]> {
  if (lock) {
    try {
      return await lockedAccountRows(companyId, ids);
    } catch (err) {
      if (isLockRace(err)) throw new InvoiceLineAccountLockError({ cause: err });
      throw err;
    }
  }
  return (await sql`
        SELECT a.account_code, a.account_name, a.account_type, a.is_active,
               EXISTS (SELECT 1 FROM gl_accounts c
                       WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
        FROM gl_accounts a
        WHERE a.company_id = ${companyId}::UUID AND a.id = ANY(${ids}::UUID[])`) as RevenueLineAccountRow[];
}

async function lockedAccountRows(companyId: string, ids: string[]): Promise<RevenueLineAccountRow[]> {
  return (await sql`
        SELECT a.account_code, a.account_name, a.account_type, a.is_active,
               EXISTS (SELECT 1 FROM gl_accounts c
                       WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
        FROM gl_accounts a
        WHERE a.company_id = ${companyId}::UUID AND a.id = ANY(${ids}::UUID[])
        ORDER BY a.id
        FOR SHARE OF a`) as RevenueLineAccountRow[];
}

/**
 * Why these line codings cannot be accepted, or null. `lock: false` is for a
 * read-only pass that only decides what to skip (bulk finalize and its dry
 * run); the posting path re-checks under lock. `posting`: an invoice past
 * draft posts its coding as stored (#675), so only what the journal itself
 * would refuse is refused, before it is written — an account or job of
 * another company, or a deactivated account; a header or non-revenue account
 * and a cancelled job post as stored.
 */
export async function invoiceLineCodingRefusal(
  companyId: string,
  codings: readonly InvoiceLineCoding[],
  opts: { lock?: boolean; posting?: boolean } = {},
): Promise<string | null> {
  const accounts = present(codings.map((c) => c.glAccountId));
  if (accounts.length > 0) {
    const rows = await accountRows(companyId, accounts, opts.lock ?? true);
    if (rows.length !== accounts.length) return FOREIGN_LINE_CODING;
    for (const row of [...rows].sort((x, y) => x.account_code.localeCompare(y.account_code))) {
      const problem = opts.posting ? (row.is_active ? null : 'is inactive') : revenueLineAccountProblem(row);
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
    const cancelled = opts.posting ? undefined : rows.find((p) => p.status === 'cancelled');
    if (cancelled) return `An invoice line cannot be tagged to job ${cancelled.project_number} ${cancelled.name}: it is cancelled.`;
  }
  return null;
}

/**
 * The account ids a quote's lines name — a quote line carries an account and
 * nothing else — held to the invoice-line rules, because converting the quote
 * copies them onto the invoice it raises. Throws the one line-coding refusal.
 */
export async function assertLineAccountIds(companyId: string, ids: readonly unknown[]): Promise<void> {
  const codings: InvoiceLineCoding[] = [];
  for (const [i, raw] of ids.entries()) {
    const glAccountId = readCodingId(raw);
    if (glAccountId === undefined) throw new InvoiceLineCodingRefusal(`lines[${i}].accountId must be a UUID`);
    codings.push({ glAccountId, projectId: null });
  }
  const refusal = await invoiceLineCodingRefusal(companyId, codings);
  if (refusal) throw new InvoiceLineCodingRefusal(refusal);
}

export interface StoredInvoiceLines {
  invoiceNumber: string;
  subtotal: number;
  /** customers.default_cc1_id of the invoice's customer. */
  customerFnoId: string | null;
  lines: StoredRevenueLine[];
}

/** An invoice's stored lines, oldest first; `null` when the invoice is not this company's. */
export async function storedInvoiceLines(
  companyId: string,
  invoiceId: string,
): Promise<StoredInvoiceLines | null> {
  const rows = (await sql`
    SELECT ci.invoice_number, ci.subtotal, c.default_cc1_id AS customer_fno_id, cii.id AS line_id, cii.amount,
           cii.gl_account_id, cii.project_id, cii.cc1_id, cii.cc2_id, cii.bu_id
    FROM customer_invoices ci
    LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) AND c.company_id = ci.company_id
    LEFT JOIN customer_invoice_items cii ON cii.invoice_id = ci.id
    WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
    ORDER BY cii.created_at, cii.id
  `) as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const id = (v: unknown): string | null => (v == null ? null : String(v));
  const dim = (v: unknown) => (v == null ? undefined : String(v));
  return {
    invoiceNumber: String(rows[0]!.invoice_number),
    subtotal: Number(rows[0]!.subtotal),
    customerFnoId: id(rows[0]!.customer_fno_id),
    lines: rows.filter((r) => r.line_id != null).map((r) => ({
      amount: Number(r.amount),
      glAccountId: id(r.gl_account_id),
      projectId: id(r.project_id),
      cc1Id: dim(r.cc1_id),
      cc2Id: dim(r.cc2_id),
      buId: dim(r.bu_id),
    })),
  };
}

/**
 * Why this invoice's STORED lines cannot post, or null: the coding rules
 * against the chart as it is now, the lines' CC1 / CC2 / BU against the
 * masters, and lines that do not add up to the
 * subtotal. An invoice none of whose lines is coded posts as it always did and
 * is never refused here.
 */
export async function storedInvoiceLinesRefusal(
  companyId: string,
  invoiceId: string,
  opts: { lock?: boolean } = {},
): Promise<string | null> {
  return storedLinesRefusal(companyId, await storedInvoiceLines(companyId, invoiceId), { ...opts, approving: true });
}

/**
 * The same over lines already read. `approving` (approve and bulk finalize,
 * before the status moves): every refusal posting would raise after it —
 * #675's stored-dimension rules (a line its customer's or project's FNO would
 * add to, a dimension no longer an active master; coded or not), the coding
 * rules, and lines that cannot stand behind the subtotal where the split
 * depends on them. Past draft: only what the journal itself would refuse
 * (invoiceLineCodingRefusal's `posting`); the invoice posts as stored.
 */
export async function storedLinesRefusal(
  companyId: string,
  stored: StoredInvoiceLines | null,
  opts: { lock?: boolean; approving?: boolean } = {},
): Promise<string | null> {
  if (!stored) return null;
  if (opts.approving) {
    try {
      await assertPostsStoredDimensions(companyId, 'draft', stored.lines, (i) => `line ${i + 1}`, stored.customerFnoId);
    } catch (err) {
      if (isDimensionRefusal(err)) return `Invoice ${stored.invoiceNumber}: ${err.message}${POSTING_HINT}`;
      throw err;
    }
  }
  if (!stored.lines.some(isRevenueCoded)) return null;
  const coding = await invoiceLineCodingRefusal(companyId, stored.lines, { lock: opts.lock, posting: !opts.approving });
  if (coding) return `Invoice ${stored.invoiceNumber}: ${coding}${POSTING_HINT}`;
  if (!opts.approving || !revenueSplitDependsOnLines(stored.lines)) return null;
  const problem = revenueLinesProblem(stored.lines, stored.subtotal);
  return problem ? `Invoice ${stored.invoiceNumber}: ${problem}` : null;
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
