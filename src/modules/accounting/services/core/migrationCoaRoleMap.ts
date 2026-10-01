/**
 * The COA import's role map — which imported code holds each system role —
 * validated before any row is written. Split out of migrationCoaService for
 * the 300-line cap.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { roleBarringChildren, roleTargetRefusal } from '../gl/roleTargetRules';
import { isSystemAccountKey, type SystemAccountKey } from '../gl/systemAccountKeys';
import type { MigrationError } from './migrationService';
import type { AccountImportRow, SystemAccountMap } from './migrationCoaService';

const SYSTEM_MAP_KEYS: readonly (keyof SystemAccountMap)[] = [
  'bank', 'receivable', 'payable', 'vat_input', 'vat_output', 'retained_earnings',
  'default_revenue', 'default_expense', 'admin_expense',
];

/**
 * The map arrives as raw request JSON. Its keys become `account_subtype` and
 * its values are flagged `is_system_account = true` verbatim, and the
 * resolver hands those rows to every auto-posting path — so an unknown key,
 * or a mapped account whose type cannot carry the role (an expense account as
 * vat_input) or one account named for two roles must refuse the whole import
 * BEFORE any row is written. Returns the refusals; empty means proceed. (A
 * role put on a header is refused by `roleMapConflicts`, which can see whether
 * the account already holds that role.)
 */
export function validateSystemAccountMap(
  map: Record<string, unknown>,
  accounts: readonly AccountImportRow[],
): MigrationError[] {
  const errors: MigrationError[] = [];
  const byCode = new Map(accounts.map((a) => [a.accountCode, a]));
  const roleOf = new Map<string, string>();
  for (const [key, code] of Object.entries(map)) {
    if (!(SYSTEM_MAP_KEYS as readonly string[]).includes(key)) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`, message: `Unknown system account role "${key}"` });
      continue;
    }
    if (typeof code !== 'string' || !code.trim()) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`, message: 'Account code is required' });
      continue;
    }
    const other = roleOf.get(code);
    if (other) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`,
        message: `One account cannot hold two roles: '${other}' and '${key}' both name account ${code}` });
      continue;
    }
    roleOf.set(code, key);
    const acct = byCode.get(code);
    if (!acct) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`, message: `Account ${code} is not in this import` });
      continue;
    }
    // The same rule the save applies; here the type of what the import itself would create.
    const unfit = roleTargetRefusal(key, key, { code, type: acct.accountType, isActive: true, hasChildren: false, subtype: null }, 'import');
    if (unfit) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`, message: unfit });
      continue;
    }
  }
  return errors;
}

/**
 * The Default Accounts rule (`gl/roleTargetRules`), for every mapped code:
 * active, not a header (one the chart already has, or one this import makes by
 * giving it a child), unclassified or already classified for that role.
 * Mapping a role onto the account that holds ANOTHER role, or onto an inactive
 * account, demoted the live holder and left a role with no holder.
 * An account that ALREADY holds the role is not being assigned it: a re-import
 * that names 4100 for revenue again, with 4101 under it, is the holder gaining
 * a sub-account, which only a balance-sheet holder is barred from
 * (`roleBarringChildren`). Read under the role-write lock, before any write.
 */
export async function roleMapConflicts(
  companyId: string, map: SystemAccountMap, accounts: readonly AccountImportRow[],
): Promise<MigrationError[]> {
  const entries = Object.entries(map);
  // A mapped row whose parent is neither in this import nor in the chart will
  // be SKIPPED, and a role cannot go to a row that is not imported.
  const byCode = new Map(accounts.map((a) => [a.accountCode, a]));
  const parentOf = entries.flatMap(([role, code]) => {
    const parent = byCode.get(code)?.parentCode;
    return parent && !byCode.has(parent) ? [{ role, code, parent }] : [];
  });
  const known = parentOf.length === 0 ? [] : (await sql`
    SELECT account_code FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_code = ANY(${parentOf.map((p) => p.parent)}::TEXT[])
  `) as DbRow[];
  const knownCodes = new Set(known.map((r) => String(r.account_code)));
  const orphans = parentOf.filter((p) => !knownCodes.has(p.parent)).map((p) => ({
    step: 'coa' as const, row: -1, field: `systemAccountMap.${p.role}`,
    message: `Account ${p.code} cannot take the ${p.role} role: its parent code ${p.parent} is not in this import or the chart, so the row would be skipped.`,
  }));
  if (orphans.length > 0) return orphans;

  const rows = (await sql`
    SELECT a.account_code, a.account_type, a.account_subtype, a.is_active, a.is_system_account,
           EXISTS (SELECT 1 FROM gl_accounts c
                   WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
    FROM gl_accounts a
    WHERE a.company_id = ${companyId}::UUID AND a.account_code = ANY(${entries.map(([, code]) => code)}::TEXT[])
  `) as DbRow[];
  const existing = new Map(rows.map((r) => [String(r.account_code), r]));
  const parentCodes = new Set(accounts.map((a) => a.parentCode).filter(Boolean));
  return entries.flatMap(([role, code]) => {
    const r = existing.get(code);
    // The type the row will HAVE: the upsert keeps a system account's own type and re-types any other.
    const type = r && r.is_system_account === true ? String(r.account_type) : String(byCode.get(code)?.accountType ?? r?.account_type);
    const holdsIt = r?.is_system_account === true && r.is_active === true && r.account_subtype === role;
    const hasChildren = r?.has_children === true || parentCodes.has(code);
    const message = roleTargetRefusal(role, role, {
      code, type, isActive: r ? r.is_active === true : true,
      hasChildren: hasChildren && (!holdsIt || roleBarringChildren({ ...r, account_type: type }) !== null),
      subtype: r?.account_subtype == null ? null : String(r.account_subtype),
    }, 'import');
    return message ? [{ step: 'coa' as const, row: -1, field: `systemAccountMap.${role}`, message }] : [];
  });
}

/** Role → the id of the account the map names for it, for the post-condition (absent when the code is not in the chart). */
export async function mappedHolders(companyId: string, map: SystemAccountMap): Promise<Map<SystemAccountKey, string>> {
  const rows = (await sql`
    SELECT id::TEXT AS id, account_code FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND account_code = ANY(${Object.values(map)}::TEXT[])
  `) as DbRow[];
  const idOf = new Map(rows.map((r) => [String(r.account_code), String(r.id)]));
  return new Map(Object.entries(map).flatMap(([role, code]) => (
    isSystemAccountKey(role) ? [[role, idOf.get(code) ?? ''] as [SystemAccountKey, string]] : [])));
}
