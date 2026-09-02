/**
 * Migration COA Service — Chart of Accounts import
 * PRD: Customer Migration Wizard — Phase 1
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { clearSystemAccountCache } from '../gl/systemAccountResolver';
import { updateSession } from './migrationService';
import type { ImportResult, MigrationError } from './migrationService';
import type { GLAccountType } from '../../types/gl.types';
import type { DbRow } from '@/types/db';
import { GL_ACCOUNT_SUBTYPES_BY_TYPE } from '../../types/glAccountSubtypes';
import { subtypeErrorFor } from '../gl/accountSubtypeRules';


export interface AccountImportRow {
  accountCode: string;
  accountName: string;
  accountType: GLAccountType;
  accountSubtype?: string;
  parentCode?: string;
  normalBalance: 'debit' | 'credit';
  description?: string;
}

export interface SystemAccountMap {
  bank: string;
  receivable: string;
  payable: string;
  vat_input: string;
  vat_output: string;
  retained_earnings: string;
  default_revenue: string;
  default_expense: string;
  admin_expense: string;
}

const SYSTEM_MAP_KEYS: readonly (keyof SystemAccountMap)[] = [
  'bank', 'receivable', 'payable', 'vat_input', 'vat_output', 'retained_earnings',
  'default_revenue', 'default_expense', 'admin_expense',
];

/**
 * The map arrives as raw request JSON. Its keys become `account_subtype` and
 * its values are flagged `is_system_account = true` verbatim, and the
 * resolver hands those rows to every auto-posting path — so an unknown key,
 * or a mapped account whose type cannot carry the role (an expense account as
 * vat_input), must refuse the whole import BEFORE any row is written.
 * Returns the refusals; empty means proceed.
 */
export function validateSystemAccountMap(
  map: Record<string, unknown>,
  accounts: readonly AccountImportRow[],
): MigrationError[] {
  const errors: MigrationError[] = [];
  const byCode = new Map(accounts.map((a) => [a.accountCode, a]));
  for (const [key, code] of Object.entries(map)) {
    if (!(SYSTEM_MAP_KEYS as readonly string[]).includes(key)) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`, message: `Unknown system account role "${key}"` });
      continue;
    }
    if (typeof code !== 'string' || !code.trim()) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`, message: 'Account code is required' });
      continue;
    }
    const acct = byCode.get(code);
    if (!acct) {
      errors.push({ step: 'coa', row: -1, field: `systemAccountMap.${key}`, message: `Account ${code} is not in this import` });
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

// ── Public API ───────────────────────────────────────────────────────────────

export async function importChartOfAccounts(
  companyId: string,
  sessionId: string,
  accounts: AccountImportRow[],
  systemAccountMap: SystemAccountMap,
): Promise<ImportResult> {
  const errors: MigrationError[] = [];
  let imported = 0;
  let skipped = 0;

  // Refuse before the first write: a bad map is a fault in the request, and
  // half an import with a mis-flagged system account is worse than none.
  const mapErrors = validateSystemAccountMap(systemAccountMap as unknown as Record<string, unknown>, accounts);
  if (mapErrors.length > 0) {
    log.warn('COA import refused: invalid system account map', { companyId, errors: mapErrors }, 'migration');
    return { imported: 0, skipped: accounts.length, errors: mapErrors };
  }

  // Sort: accounts without parents first, then those with parents (preserves hierarchy)
  const sorted = [...accounts.filter(a => !a.parentCode), ...accounts.filter(a => a.parentCode)];

  for (let i = 0; i < sorted.length; i++) {
    const acct = sorted[i]!;
    try {
      let parentAccountId: string | null = null;
      if (acct.parentCode) {
        const parentRows = (await sql`
          SELECT id FROM gl_accounts
          WHERE account_code = ${acct.parentCode} AND company_id = ${companyId}::UUID
        `) as DbRow[];
        if (parentRows.length === 0) {
          errors.push({ step: 'coa', row: i, field: 'parentCode', message: `Parent code ${acct.parentCode} not found` });
          skipped++;
          continue;
        }
        parentAccountId = String(parentRows[0]!.id);
      }

      const subtypeEntry = Object.entries(systemAccountMap).find(([, code]) => code === acct.accountCode);
      const accountSubtype = subtypeEntry ? subtypeEntry[0] : (acct.accountSubtype ?? null);
      const isSystem = subtypeEntry != null;
      // A row's own subtype goes through the same gate as every other write
      // path (createAccount, reclassifyAccount, the MCP tools): unknown values
      // behave like NULL downstream, and a reserved one would sit beside the
      // real system account. The mapped system rows are set by the map, not here.
      if (!isSystem) {
        const subtypeError = subtypeErrorFor({ accountType: acct.accountType }, accountSubtype);
        if (subtypeError) {
          errors.push({ step: 'coa', row: i, field: 'accountSubtype', message: subtypeError });
          skipped++;
          continue;
        }
      }

      await sql`
        INSERT INTO gl_accounts (
          company_id, account_code, account_name, account_type, account_subtype,
          normal_balance, parent_account_id, description, is_system_account,
          level, display_order
        ) VALUES (
          ${companyId}::UUID,
          ${acct.accountCode},
          ${acct.accountName},
          ${acct.accountType},
          ${accountSubtype},
          ${acct.normalBalance},
          ${parentAccountId}::UUID,
          ${acct.description ?? null},
          ${isSystem},
          ${parentAccountId ? 2 : 1},
          0
        )
        ON CONFLICT (company_id, account_code) DO UPDATE SET
          account_name      = EXCLUDED.account_name,
          account_type      = EXCLUDED.account_type,
          account_subtype   = COALESCE(EXCLUDED.account_subtype, gl_accounts.account_subtype),
          normal_balance    = EXCLUDED.normal_balance,
          description       = COALESCE(EXCLUDED.description, gl_accounts.description),
          is_system_account = EXCLUDED.is_system_account OR gl_accounts.is_system_account
      `;
      imported++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ step: 'coa', row: i, field: 'accountCode', message: msg });
      skipped++;
    }
  }

  // The map is the company's statement of which account holds each role, so
  // it is EXCLUSIVE: any other row still flagged for that role is demoted
  // first. Without this a re-import that maps a role to a new code left the
  // old system row in place — two rows for one role, the resolver choosing
  // between them, which is exactly how the Sage SYS-* controls came to sit
  // beside the seeded chart in production (migration 525).
  for (const [subtype, accountCode] of Object.entries(systemAccountMap)) {
    await sql`
      UPDATE gl_accounts
      SET is_system_account = false, account_subtype = NULL
      WHERE company_id = ${companyId}::UUID
        AND account_subtype = ${subtype}
        AND is_system_account = true
        AND account_code <> ${accountCode}
    `;
    await sql`
      UPDATE gl_accounts
      SET account_subtype = ${subtype}, is_system_account = true
      WHERE company_id = ${companyId}::UUID AND account_code = ${accountCode}
    `;
  }

  clearSystemAccountCache(companyId);

  await updateSession(sessionId, companyId, {
    coaRecordsImported: imported,
    stepsCompleted: { coa: true },
    errors,
  });

  log.info('COA import complete', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}
