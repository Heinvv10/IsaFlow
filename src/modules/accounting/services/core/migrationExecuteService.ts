/**
 * Migration Execute Service — import parsed Xero/QuickBooks/Pastel data into ISAFlow
 * Uses existing migrationCoaService and migrationContactService patterns.
 */

import { sql, transaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { postOpeningBalances } from './migrationOpeningBalanceService';
import type { ParsedAccount, ParsedEntity, MigrationSource } from './migrationParserService';
import type { DbRow } from '@/types/db';
import { defaultIncomeStatementSubtype } from '../gl/accountSubtypeRules';
import { VatPeriodLockedError } from '../gl/journalVatLockGuard';
import { boundedRowWait, lockSystemRoleWrites, textUnlessLockError } from '../gl/systemRoleWriteLock';
import { clearSystemAccountCacheAfterCommit } from '../gl/systemAccountResolver';
import { assertAccountChangesKeepVatLocks, type AccountAttributeChange } from '../gl/vatLockLineClassification';

// Rollback lives in its own file for the 300-line cap; re-exported so the API
// route and the wizard keep importing it from here.
export { rollbackMigration, type RollbackResult } from './migrationRollbackService';


export interface ExecuteMigrationResult {
  accountsImported: number;
  customersImported: number;
  suppliersImported: number;
  openingBalancesSet: number;
  errors: string[];
}

export interface VerifyEntry {
  accountCode: string;
  sourceName: string;
  sourceBalance: number;
  isaflowBalance: number;
  difference: number;
  matched: boolean;
}

// ── Execute ──────────────────────────────────────────────────────────────────

/** Bounded: every statement it runs while it holds the role lock waits at most 5s for any lock. */
export function executeMigration(
  companyId: string, userId: string, source: MigrationSource,
  accounts: ParsedAccount[], customers: ParsedEntity[], suppliers: ParsedEntity[],
): Promise<ExecuteMigrationResult> {
  return boundedRowWait(() => executeUnderLock(companyId, userId, source, accounts, customers, suppliers));
}

async function executeUnderLock(
  companyId: string,
  userId: string,
  source: MigrationSource,
  accounts: ParsedAccount[],
  customers: ParsedEntity[],
  suppliers: ParsedEntity[],
): Promise<ExecuteMigrationResult> {
  const errors: string[] = [];
  let accountsImported = 0;
  let customersImported = 0;
  let suppliersImported = 0;
  let openingBalancesSet = 0;

  log.info('Starting migration execution', { companyId, source, accountCount: accounts.length }, 'migration');

  // 1. Import GL accounts
  const validAccounts = accounts.filter(acct => {
    if (!acct.sourceCode && !acct.sourceName) return false;
    if (!acct.mappedType) {
      errors.push(`Account "${acct.sourceCode} ${acct.sourceName}": unmapped type "${acct.sourceType}" — skipped`);
      return false;
    }
    return true;
  }).map(acct => {
    // autoMapAccounts sets a subtype on every revenue/expense mapping, but the
    // mapping table lets the operator re-type a row without one. Default it
    // and say so — skipping would strand the opening trial balance, which is
    // posted against the full account list below.
    if (acct.mappedSubtype) return acct;
    const fallback = defaultIncomeStatementSubtype(acct.mappedType!);
    if (!fallback) return acct;
    errors.push(`Account "${acct.sourceCode} ${acct.sourceName}": no subtype; imported as ${fallback}`);
    return { ...acct, mappedSubtype: fallback };
  });

  // Before ANY write: re-importing the same source re-types its own accounts
  // (`account_type = EXCLUDED.account_type`, and fills a NULL subtype). One that
  // would move a posted line inside a locked (filed) VAT period into a
  // different box refuses the WHOLE migration, naming account and period —
  // later steps post opening balances against these accounts.
  // The role-write lock comes first, for lock ORDER rather than for a holder:
  // the upsert below locks account rows in the order the file lists them, a
  // Default Accounts save locks the same rows in id order, and without one
  // lock taken first by both the two deadlocked (40P01).
  await lockSystemRoleWrites(companyId);
  try {
    await assertAccountChangesKeepVatLocks(companyId, await reimportAttributeChanges(companyId, source, validAccounts));
  } catch (err) {
    if (!(err instanceof VatPeriodLockedError)) throw err;
    log.warn('Migration refused: it would change a filed VAT period', { companyId, source, error: err.message }, 'migration');
    return { accountsImported: 0, customersImported: 0, suppliersImported: 0, openingBalancesSet: 0, errors: [...errors, err.message] };
  }

  if (validAccounts.length > 0) {
    try {
      // A collision with an account this source did not create leaves that
      // account entirely alone — no re-tag, and no rename or re-type either.
      // The company's own `4000 House revenue` must not become the source's
      // `4000 Sales`: nothing records the old values, so nothing could restore
      // them, and a NULL imported_from is what shields it from rollback.
      // Skipped rows return no row and are reported through errors[].
      const upserted = (await transaction((txSql) =>
        validAccounts.map(acct => txSql`
          INSERT INTO gl_accounts (
            company_id, account_code, account_name, account_type, account_subtype,
            normal_balance, description, level, display_order, imported_from
          ) VALUES (
            ${companyId}::UUID,
            ${acct.sourceCode || acct.sourceName.substring(0, 20)},
            ${acct.sourceName},
            ${acct.mappedType},
            ${acct.mappedSubtype ?? null},
            ${acct.mappedNormalBalance ?? 'debit'},
            ${'Imported from ' + source},
            3,
            0,
            ${source}
          )
          ON CONFLICT (company_id, account_code) DO UPDATE SET
            account_name    = EXCLUDED.account_name,
            -- A system account keeps its type and subtype. The subtype is its
            -- ROLE: only Default Accounts and the COA import's role map place
            -- one, never this fill (it would make the account a holder, beside
            -- the role's own). Its type is what the role requires: re-typing
            -- the bank holder as an expense would leave posting on a mistyped account.
            account_type    = CASE WHEN gl_accounts.is_system_account THEN gl_accounts.account_type
                                   ELSE EXCLUDED.account_type END,
            account_subtype = CASE WHEN gl_accounts.is_system_account THEN gl_accounts.account_subtype
                                   ELSE COALESCE(gl_accounts.account_subtype, EXCLUDED.account_subtype) END
          WHERE gl_accounts.imported_from = EXCLUDED.imported_from
          RETURNING account_code
        `)
      )) as DbRow[][];
      upserted.forEach((rows, i) => {
        if (rows.length > 0) { accountsImported += 1; return; }
        const acct = validAccounts[i]!;
        errors.push(
          `Account "${acct.sourceCode} ${acct.sourceName}": code already used by an account the ${source} import does not own — it was created here, or a partial rollback released it — left unchanged (renumber the source row, or delete the existing account, then re-run)`,
        );
      });
    } catch (err) {
      errors.push(`Accounts batch: ${textUnlessLockError(err)}`);   // a lock wait is not a batch to report: thrown, the whole request retries (503)
    }
  }

  // 2. Set opening balances via a single journal entry.
  // Extracted to migrationOpeningBalanceService — it either posts the whole
  // balanced set or throws without writing anything; the throw is reported
  // through the errors[] channel rather than failing the entire migration.
  try {
    openingBalancesSet = await postOpeningBalances(companyId, userId, source, accounts);
  } catch (err) {
    errors.push(`Opening balances: ${textUnlessLockError(err)}`);
  }

  // 3. Import customers
  const validCustomers = customers.filter(c => c.name?.trim());
  if (validCustomers.length > 0) {
    try {
      await transaction((txSql) =>
        validCustomers.map(cust => txSql`
          INSERT INTO customers (company_id, name, email, phone, vat_number, billing_address)
          VALUES (
            ${companyId}::UUID,
            ${cust.name},
            ${cust.email ?? null},
            ${cust.phone ?? null},
            ${cust.vatNumber ?? null},
            ${cust.address ?? null}
          )
          ON CONFLICT DO NOTHING
        `)
      );
      customersImported = validCustomers.length;
    } catch (err) {
      errors.push(`Customers batch: ${textUnlessLockError(err)}`);
    }
  }

  // 4. Import suppliers
  const validSuppliers = suppliers.filter(s => s.name?.trim());
  if (validSuppliers.length > 0) {
    try {
      await transaction((txSql) =>
        validSuppliers.map(sup => txSql`
          INSERT INTO suppliers (company_id, name, email, phone, vat_number, address)
          VALUES (
            ${companyId}::UUID,
            ${sup.name},
            ${sup.email ?? null},
            ${sup.phone ?? null},
            ${sup.vatNumber ?? null},
            ${sup.address ?? null}
          )
          ON CONFLICT DO NOTHING
        `)
      );
      suppliersImported = validSuppliers.length;
    } catch (err) {
      errors.push(`Suppliers batch: ${textUnlessLockError(err)}`);
    }
  }

  log.info('Migration execution complete', {
    companyId, source, accountsImported, customersImported, suppliersImported,
  }, 'migration');

  clearSystemAccountCacheAfterCommit(companyId);   // a re-import renames its own accounts, a role holder among them
  return { accountsImported, customersImported, suppliersImported, openingBalancesSet, errors };
}

// ── Verify balances ───────────────────────────────────────────────────────────

export async function verifyBalances(
  companyId: string,
  sourceAccounts: ParsedAccount[],
): Promise<VerifyEntry[]> {
  const results: VerifyEntry[] = [];

  for (const acct of sourceAccounts) {
    if (!acct.sourceCode) continue;

    try {
      const glRows = (await sql`
        SELECT ga.account_name,
          COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS net_debit,
          ga.normal_balance
        FROM gl_accounts ga
        LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
        LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
        WHERE ga.company_id = ${companyId}::UUID AND ga.account_code = ${acct.sourceCode}
        GROUP BY ga.id, ga.account_name, ga.normal_balance
        LIMIT 1
      `) as DbRow[];

      const isaflowBalance = glRows.length > 0
        ? (String(glRows[0]!.normal_balance) === 'debit'
          ? Number(glRows[0]!.net_debit)
          : -Number(glRows[0]!.net_debit))
        : 0;

      const difference = acct.openingBalance - isaflowBalance;

      results.push({
        accountCode:    acct.sourceCode,
        sourceName:     acct.sourceName,
        sourceBalance:  acct.openingBalance,
        isaflowBalance,
        difference,
        matched:        Math.abs(difference) < 0.01,
      });
    } catch (err) {
      log.warn('Balance verification failed for account', { code: acct.sourceCode, error: err }, 'migration');
    }
  }

  return results;
}

/**
 * The type/subtype changes the upsert above would make to accounts this SAME
 * source already imported (its ON CONFLICT only updates rows whose
 * imported_from matches): type := mapped type, subtype := COALESCE(existing,
 * mapped). Rows another source or the company owns are left alone by the
 * upsert, so they are not changes.
 */
async function reimportAttributeChanges(
  companyId: string, source: MigrationSource, accounts: readonly ParsedAccount[],
): Promise<AccountAttributeChange[]> {
  const codes = accounts.map((a) => a.sourceCode || a.sourceName.substring(0, 20));
  if (codes.length === 0) return [];
  const rows = (await sql`
    SELECT id, account_code, account_type, account_subtype, is_system_account FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND imported_from = ${source}
      AND account_code = ANY(${codes}::TEXT[])`) as DbRow[];
  const byCode = new Map(accounts.map((a, i) => [codes[i]!, a]));
  return rows.flatMap((r) => {
    const acct = byCode.get(String(r.account_code));
    if (!acct) return [];
    const subtype = r.account_subtype == null ? null : String(r.account_subtype);
    return [{
      accountId: String(r.id), accountCode: String(r.account_code),
      from: { accountType: String(r.account_type), accountSubtype: subtype },
      to: r.is_system_account === true
        ? { accountType: String(r.account_type), accountSubtype: subtype }
        : { accountType: String(acct.mappedType), accountSubtype: subtype ?? acct.mappedSubtype ?? null },
    }];
  });
}
