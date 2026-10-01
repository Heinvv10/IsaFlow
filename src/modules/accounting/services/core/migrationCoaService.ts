/**
 * Migration COA Service — Chart of Accounts import
 * PRD: Customer Migration Wizard — Phase 1
 */

import { sql, withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { withAlsTransaction } from '@/lib/alsTransaction';
import { log } from '@/lib/logger';
import { clearSystemAccountCacheAfterCommit } from '../gl/systemAccountResolver';
import { updateSession } from './migrationService';
import type { ImportResult, MigrationError } from './migrationService';
import type { GLAccountType } from '../../types/gl.types';
import type { DbRow } from '@/types/db';
import { subtypeErrorFor } from '../gl/accountSubtypeRules';
import { VatPeriodLockedError } from '../gl/journalVatLockGuard';
import { assertAccountChangesKeepVatLocks } from '../gl/vatLockLineClassification';
import { lockSystemRoleWrites } from '../gl/systemRoleWriteLock';
import { accountAttributes, attributeChanges } from './migrationCoaVatLock';
import { importRowSubtype } from './migrationCoaSubtype';
import { mappedHolders, roleMapConflicts, validateSystemAccountMap } from './migrationCoaRoleMap';
import { assertRolesKept, snapshotRoles, SystemRoleInvariantError } from '../gl/systemRoleInvariant';

export { validateSystemAccountMap };


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

  // Refuse before the first write: a bad map is a fault in the request, and
  // half an import with a mis-flagged system account is worse than none.
  const mapErrors = validateSystemAccountMap(systemAccountMap as unknown as Record<string, unknown>, accounts);
  if (mapErrors.length > 0) {
    log.warn('COA import refused: invalid system account map', { companyId, errors: mapErrors }, 'migration');
    return { imported: 0, skipped: accounts.length, errors: mapErrors };
  }

  // The writes run inside a SAVEPOINT, and the VAT-lock check reads what they
  // ACTUALLY wrote: every existing account's type and subtype before vs after,
  // judged with all changes together (vatLockLineClassification). If a posted
  // line inside a locked (filed) VAT period would move — into another box, or
  // its journal into or out of the return — the savepoint is rolled back and
  // the import refused whole, naming the account and the period. Checking the
  // real outcome, not a simulation of it, is what makes skipped rows, the
  // parents-first order and the role demotions count exactly as they happen.
  // withAlsTransaction joins the request transaction (or opens one for a
  // non-request caller), so the savepoint always has something to roll back.
  const refusal = await withAlsTransaction({ userId: als.getStore()?.userId ?? 'system', companyId }, async () => {
    // The role map below rewrites system-account flags: serialise with the
    // Default Accounts save, which takes the same lock.
    await lockSystemRoleWrites(companyId);
    const conflicts = await roleMapConflicts(companyId, systemAccountMap, accounts);
    if (conflicts.length > 0) return conflicts;
    const roles = await snapshotRoles(companyId);
    try {
      await withSavepoint('coa_import_vat_lock', async () => {
        const before = await accountAttributes(companyId);
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

            const { isSystem, explicitSubtype, accountSubtype, defaulted } = importRowSubtype(acct, systemAccountMap);
            if (defaulted) {
              errors.push({ step: 'coa', row: i, field: 'accountSubtype',
                message: `No subtype given; imported as ${accountSubtype} (an existing classification is kept). Reclassify cost-of-sales accounts before reporting.` });
            }
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

            const written = ((await sql`
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
                -- An existing system account keeps its type and classification:
                -- its subtype is its ROLE, and a row that re-typed or
                -- re-classified it emptied or mistyped the role. Only the role
                -- map below places roles. is_active is never touched here.
                account_type      = CASE WHEN gl_accounts.is_system_account THEN gl_accounts.account_type
                                         ELSE EXCLUDED.account_type END,
                account_subtype   = CASE WHEN gl_accounts.is_system_account THEN gl_accounts.account_subtype
                  ELSE COALESCE(${explicitSubtype}, gl_accounts.account_subtype, EXCLUDED.account_subtype) END,
                normal_balance    = EXCLUDED.normal_balance,
                description       = COALESCE(EXCLUDED.description, gl_accounts.description),
                is_system_account = EXCLUDED.is_system_account OR gl_accounts.is_system_account
              RETURNING account_type, account_subtype
            `) as DbRow[])[0];
            const keptSubtype = written?.account_subtype == null ? null : String(written.account_subtype);
            if (written && !isSystem && (written.account_type !== acct.accountType
              || (explicitSubtype !== null && keptSubtype !== explicitSubtype))) {
              errors.push({ step: 'coa', row: i, field: 'accountType',
                message: `Account ${acct.accountCode} is a system account: its name was updated, its type and classification (${String(written.account_type)} / ${keptSubtype ?? 'none'}) were kept.` });
            }
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
        // A demoted revenue/expense row is NOT cleared to NULL — that would put an
        // income-statement account back into the unbanded state the creation and
        // edit gates refuse — it falls to the type's default and stays classified.
        for (const [subtype, accountCode] of Object.entries(systemAccountMap)) {
          await sql`
            UPDATE gl_accounts
            SET is_system_account = false,
                account_subtype = CASE account_type
                  WHEN 'revenue' THEN 'revenue'
                  WHEN 'expense' THEN 'operating_expense'
                  ELSE NULL END
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

        await assertAccountChangesKeepVatLocks(companyId, attributeChanges(before, await accountAttributes(companyId)));
        // Last, on what was ACTUALLY written (skipped rows and all): every role
        // held before, or mapped, has exactly one usable holder — else the
        // savepoint is rolled back and the import refused whole.
        await assertRolesKept(companyId, roles, await mappedHolders(companyId, systemAccountMap));
      });
      return null;
    } catch (err) {
      if (err instanceof VatPeriodLockedError || err instanceof SystemRoleInvariantError) return err;
      throw err;
    }
  });
  if (Array.isArray(refusal)) {
    log.warn('COA import refused: the role map would take an account from another role', { companyId, errors: refusal }, 'migration');
    return { imported: 0, skipped: accounts.length, errors: refusal };
  }
  if (refusal) {
    log.warn('COA import refused: it would change a filed VAT period or leave a role unheld', { companyId, error: refusal.message }, 'migration');
    return { imported: 0, skipped: accounts.length, errors: [{ step: 'coa', row: -1, field: 'accountCode', message: refusal.message }] };
  }

  clearSystemAccountCacheAfterCommit(companyId);

  await updateSession(sessionId, companyId, {
    coaRecordsImported: imported,
    stepsCompleted: { coa: true },
    errors,
  });

  log.info('COA import complete', { companyId, imported, skipped }, 'migration');
  return { imported, skipped, errors };
}
