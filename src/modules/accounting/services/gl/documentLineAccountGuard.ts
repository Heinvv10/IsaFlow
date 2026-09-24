/**
 * Which GL accounts an expense-claim line or a purchase-order line may name.
 *
 * Bill lines already had this (`ap/billLineAccountGuard.ts`): a bill line is
 * coded while a concurrent GL account merge holds `FOR UPDATE` on the source
 * and target `gl_accounts` rows for its whole transaction and deactivates the
 * source, and `billLineAccountRefusal`'s `FOR SHARE` read waits on that lock,
 * then refuses the now-inactive account. Expense-claim lines and PO lines had
 * no such check, so a line coded while a merge ran — or simply coded to an
 * already-deactivated account — landed on an inactive account with nothing to
 * catch it (`gl/.claude.md`, "Known limit", 2026-09-24).
 *
 * Scope is deliberately narrow: inactive, or another company's account. NOT
 * control/VAT/header rules — those bill-line-only refusals do not apply here
 * (an expense claim or a PO line is not the debit side of a control posting
 * the same way a bill line is), and widening scope was not asked for.
 *
 * One query for any number of ids, taking FOR SHARE on the accounts — in id
 * order, matching `billLineAccountRefusal` and `lockGlAccountsForUpdate`
 * (merge) — so a reclassification or deactivation cannot land between this
 * check and the caller's write in the same request transaction.
 */
import { sql } from '@/lib/neon';

/** Raised by the throwing form; the message reaches every mapped caller. */
export class DocumentLineAccountRefusal extends Error {
  readonly code = 'DOCUMENT_LINE_ACCOUNT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'DocumentLineAccountRefusal';
  }
}

export const FOREIGN_DOCUMENT_LINE_ACCOUNT = 'One or more lines name GL accounts that are not in your company.';

interface DocumentLineAccountRow {
  account_code: string;
  account_name: string;
  is_active: boolean;
}

/** Why a document line may not name this account, or null when it may. */
function documentLineAccountProblem(a: DocumentLineAccountRow): string | null {
  if (!a.is_active) return 'is inactive';
  return null;
}

/** The refusal message for the first (by account code) account that fails, or null. */
function firstRefusal(rows: readonly DocumentLineAccountRow[]): string | null {
  for (const row of [...rows].sort((x, y) => x.account_code.localeCompare(y.account_code))) {
    const problem = documentLineAccountProblem(row);
    if (problem) return `A line cannot be coded to ${row.account_code} ${row.account_name}: it ${problem}.`;
  }
  return null;
}

export async function documentLineAccountRefusal(
  companyId: string,
  accountIds: readonly (string | null | undefined)[],
): Promise<string | null> {
  // Lower-cased: Postgres reads 'ABC…' and 'abc…' as one uuid and returns one row.
  const unique = [...new Set(accountIds
    .filter((id): id is string => typeof id === 'string' && id !== '')
    .map((id) => id.toLowerCase()))];
  if (unique.length === 0) return null;
  const rows = (await sql`
    SELECT a.account_code, a.account_name, a.is_active
    FROM gl_accounts a
    WHERE a.company_id = ${companyId}::UUID AND a.id = ANY(${unique}::UUID[])
    ORDER BY a.id
    FOR SHARE OF a
  `) as DocumentLineAccountRow[];
  // A missing row means the id is not an account of THIS company: foreign, or
  // deleted, or never existed. One message for all three, as billLineAccountGuard.
  return rows.length !== unique.length ? FOREIGN_DOCUMENT_LINE_ACCOUNT : firstRefusal(rows);
}

/** The throwing form, for writers whose callers turn a thrown message into a 4xx. */
export async function assertDocumentLineAccounts(
  companyId: string,
  accountIds: readonly (string | null | undefined)[],
): Promise<void> {
  const refusal = await documentLineAccountRefusal(companyId, accountIds);
  if (refusal) throw new DocumentLineAccountRefusal(refusal);
}
