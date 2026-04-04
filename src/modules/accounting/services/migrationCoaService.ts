/**
 * Migration COA Service — Chart of Accounts import
 * PRD: Customer Migration Wizard — Phase 1
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { clearSystemAccountCache } from './systemAccountResolver';
import { updateSession } from './migrationService';
import type { ImportResult, MigrationError } from './migrationService';
import type { GLAccountType } from '../types/gl.types';
type Row = Record<string, unknown>;


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
        `) as Row[];
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

  // Enforce system account subtype + flag for explicitly mapped accounts
  for (const [subtype, accountCode] of Object.entries(systemAccountMap)) {
    await sql`
      UPDATE gl_accounts
      SET account_subtype = ${subtype}, is_system_account = true
      WHERE company_id = ${companyId}::UUID AND account_code = ${accountCode}
    `;
  }

  clearSystemAccountCache();

  await updateSession(sessionId, companyId, {
    coaRecordsImported: imported,
    stepsCompleted: { coa: true },
    errors,
  });

  log.info('COA import complete', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}
