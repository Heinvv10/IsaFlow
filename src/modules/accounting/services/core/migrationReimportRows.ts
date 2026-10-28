/**
 * What a Xero/QuickBooks/Pastel re-run does to accounts that already exist, for
 * migrationExecuteService (split out for the 300-line cap). The upsert there only
 * updates a row this SAME source imported, and never one whose type the file
 * would change (a re-typed parent can leave the balance sheet).
 */
import { sql } from '@/lib/neon';
import type { ParsedAccount, MigrationSource } from './migrationParserService';
import type { DbRow } from '@/types/db';
import type { AccountAttributeChange } from '../gl/vatLockLineClassification';

/** The account code a parsed row is written under. */
export const accountCodeOf = (a: ParsedAccount): string => a.sourceCode || a.sourceName.substring(0, 20);

/**
 * The subtype changes the upsert would make to accounts this source already
 * imported: subtype := COALESCE(existing, mapped). Type never changes, and a row
 * that would change it is refused, so it makes no change at all. Rows another
 * source or the company owns are left alone, so they are not changes either.
 */
export async function reimportAttributeChanges(
  companyId: string, source: MigrationSource, accounts: readonly ParsedAccount[],
): Promise<AccountAttributeChange[]> {
  const codes = accounts.map(accountCodeOf);
  if (codes.length === 0) return [];
  const rows = (await sql`
    SELECT id, account_code, account_type, account_subtype, is_system_account FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND imported_from = ${source}
      AND account_code = ANY(${codes}::TEXT[])`) as DbRow[];
  const byCode = new Map(accounts.map((a, i) => [codes[i]!, a]));
  return rows.flatMap((r) => {
    const acct = byCode.get(String(r.account_code));
    if (!acct || r.is_system_account === true || String(r.account_type) !== String(acct.mappedType)) return [];
    const subtype = r.account_subtype == null ? null : String(r.account_subtype);
    const from = { accountType: String(r.account_type), accountSubtype: subtype };
    return [{ accountId: String(r.id), accountCode: String(r.account_code), from,
      to: { ...from, accountSubtype: subtype ?? acct.mappedSubtype ?? null } }];
  });
}

/**
 * Of the rows the upsert did NOT write, those it refused for a type change:
 * code → the account's current type. Read after the write, so it reports what
 * happened; any other unwritten row is one this source does not own.
 */
export async function retypeRefusals(
  companyId: string, source: MigrationSource, unwritten: readonly ParsedAccount[],
): Promise<Map<string, string>> {
  const codes = unwritten.map(accountCodeOf);
  if (codes.length === 0) return new Map();
  const rows = (await sql`
    SELECT account_code, account_type FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND imported_from = ${source}
      AND NOT is_system_account AND account_code = ANY(${codes}::TEXT[])`) as DbRow[];
  const mapped = new Map(unwritten.map((a, i) => [codes[i]!, String(a.mappedType)]));
  return new Map(rows
    .filter((r) => mapped.get(String(r.account_code)) !== String(r.account_type))
    .map((r) => [String(r.account_code), String(r.account_type)]));
}
