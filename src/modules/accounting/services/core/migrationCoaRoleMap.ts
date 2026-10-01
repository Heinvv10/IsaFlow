/**
 * The COA import's role map — which imported code holds each system role —
 * validated before any row is written. Split out of migrationCoaService for
 * the 300-line cap.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { GL_ACCOUNT_SUBTYPES_BY_TYPE } from '../../types/glAccountSubtypes';
import { roleTargetRefusal } from '../gl/roleTargetRules';
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
 * vat_input), one account named for two roles, or a role put on a row this
 * import makes a header, must refuse the whole import BEFORE any row is
 * written. Returns the refusals; empty means proceed.
 */
export function validateSystemAccountMap(
  map: Record<string, unknown>,
  accounts: readonly AccountImportRow[],
): MigrationError[] {
  const errors: MigrationError[] = [];
  const byCode = new Map(accounts.map((a) => [a.accountCode, a]));
  const roleOf = new Map<string, string>();
  const parentCodes = new Set(accounts.map((a) => a.parentCode).filter(Boolean));
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
    // The same rule the save applies; here for what the import itself would create.
    const unfit = roleTargetRefusal(key, key, { code, isActive: true, hasChildren: parentCodes.has(code), subtype: null });
    if (unfit) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`, message: unfit });
      continue;
    }
    const allowed = GL_ACCOUNT_SUBTYPES_BY_TYPE[acct.accountType] as readonly string[] | undefined;
    if (!allowed?.includes(key)) {
      errors.push({
        step: 'coa', row: -1, field: `systemAccountMap.${key}`,
        message: `Account ${code} is ${acct.accountType}; the ${key} role needs one of: ${Object.entries(GL_ACCOUNT_SUBTYPES_BY_TYPE).filter(([, v]) => (v as readonly string[]).includes(key)).map(([t]) => t).join(', ')}`,
      });
    }
  }
  return errors;
}

/**
 * The Default Accounts rule (`gl/roleTargetRules`), for a mapped code that
 * already exists in the company: active, not a header, unclassified or already
 * classified for that role. Mapping a role onto the account that holds ANOTHER
 * role, or onto an inactive account, demoted the live holder and left a role
 * with no holder. Read under the role-write lock, before any write.
 */
export async function roleMapConflicts(companyId: string, map: SystemAccountMap): Promise<MigrationError[]> {
  const entries = Object.entries(map);
  const rows = (await sql`
    SELECT a.account_code, a.account_subtype, a.is_active,
           EXISTS (SELECT 1 FROM gl_accounts c
                   WHERE c.parent_account_id = a.id AND c.company_id = a.company_id) AS has_children
    FROM gl_accounts a
    WHERE a.company_id = ${companyId}::UUID AND a.account_code = ANY(${entries.map(([, code]) => code)}::TEXT[])
  `) as DbRow[];
  const existing = new Map(rows.map((r) => [String(r.account_code), r]));
  return entries.flatMap(([role, code]) => {
    const r = existing.get(code);
    const message = r && roleTargetRefusal(role, role, {
      code, isActive: r.is_active === true, hasChildren: r.has_children === true,
      subtype: r.account_subtype == null ? null : String(r.account_subtype),
    });
    return message ? [{ step: 'coa' as const, row: -1, field: `systemAccountMap.${role}`, message }] : [];
  });
}
