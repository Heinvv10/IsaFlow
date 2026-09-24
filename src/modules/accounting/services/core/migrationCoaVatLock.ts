/**
 * Before/after snapshots of a company's account attributes, for the COA
 * import's VAT-lock check (migrationCoaService.importChartOfAccounts).
 *
 * The import runs its writes inside a savepoint, then compares every EXISTING
 * account's type and subtype before vs after and hands the differences — all of
 * them, together — to vatLockLineClassification. Reading the real outcome
 * rather than simulating it means rows the import skips by its own checks
 * (missing parent, rejected subtype), its parents-first order and the role
 * demotion/promotion are counted exactly as they happened. Accounts the import
 * creates have no posted lines and are not changes.
 *
 * A DATABASE error on any row is not skipped: the per-row catch has no
 * savepoint of its own, so the error aborts the transaction, the savepoint
 * rolls the whole import back, and the request fails — the import is
 * all-or-nothing on a DB error.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import type { AccountAttributeChange, AccountVatAttrs } from '../gl/vatLockLineClassification';

export type AccountAttributeSnapshot = Map<string, { code: string; attrs: AccountVatAttrs }>;

export async function accountAttributes(companyId: string): Promise<AccountAttributeSnapshot> {
  const rows = (await sql`
    SELECT id, account_code, account_type, account_subtype
    FROM gl_accounts WHERE company_id = ${companyId}::UUID`) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), {
    code: String(r.account_code),
    attrs: {
      accountType: String(r.account_type),
      accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
    },
  }]));
}

/** Every account present before whose type or subtype differs after. */
export function attributeChanges(
  before: AccountAttributeSnapshot, after: AccountAttributeSnapshot,
): AccountAttributeChange[] {
  const out: AccountAttributeChange[] = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) continue;
    if (a.attrs.accountType === b.attrs.accountType && a.attrs.accountSubtype === b.attrs.accountSubtype) continue;
    out.push({ accountId: id, accountCode: a.code, from: b.attrs, to: a.attrs });
  }
  return out;
}
