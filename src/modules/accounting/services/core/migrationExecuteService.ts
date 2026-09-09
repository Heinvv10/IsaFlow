/**
 * Migration Execute Service — import parsed Xero/QuickBooks/Pastel data into ISAFlow
 * Uses existing migrationCoaService and migrationContactService patterns.
 */

import { sql, transaction, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { postOpeningBalances } from './migrationOpeningBalanceService';
import type { ParsedAccount, ParsedEntity, MigrationSource } from './migrationParserService';
import type { DbRow } from '@/types/db';
import { defaultIncomeStatementSubtype } from '../gl/accountSubtypeRules';


export interface ExecuteMigrationResult {
  accountsImported: number;
  customersImported: number;
  suppliersImported: number;
  openingBalancesSet: number;
  errors: string[];
}

/**
 * Accounts the rollback could not remove because other rows still point at
 * them are RETAINED, not deleted — and the caller is told which, so the UI
 * never reports a partial rollback as a clean one.
 */
export interface RollbackResult {
  deleted: number;
  retained: number;
  retainedCodes: string[];
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

export async function executeMigration(
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
            account_type    = EXCLUDED.account_type,
            account_subtype = COALESCE(gl_accounts.account_subtype, EXCLUDED.account_subtype)
          WHERE gl_accounts.imported_from = EXCLUDED.imported_from
          RETURNING account_code
        `)
      )) as DbRow[][];
      upserted.forEach((rows, i) => {
        if (rows.length > 0) { accountsImported += 1; return; }
        const acct = validAccounts[i]!;
        errors.push(
          `Account "${acct.sourceCode} ${acct.sourceName}": code already used by an account not imported from ${source} — left unchanged`,
        );
      });
    } catch (err) {
      errors.push(`Accounts batch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Set opening balances via a single journal entry.
  // Extracted to migrationOpeningBalanceService — it either posts the whole
  // balanced set or throws without writing anything; the throw is reported
  // through the errors[] channel rather than failing the entire migration.
  try {
    openingBalancesSet = await postOpeningBalances(companyId, userId, source, accounts);
  } catch (err) {
    errors.push(`Opening balances: ${err instanceof Error ? err.message : String(err)}`);
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
      errors.push(`Customers batch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Import suppliers
  const validSuppliers = suppliers.filter(s => s.name?.trim());
  if (validSuppliers.length > 0) {
    try {
      await transaction((txSql) =>
        validSuppliers.map(sup => txSql`
          INSERT INTO suppliers (company_id, name, email, phone, vat_number, billing_address)
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
      errors.push(`Suppliers batch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.info('Migration execution complete', {
    companyId, source, accountsImported, customersImported, suppliersImported,
  }, 'migration');

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

// ── Rollback ─────────────────────────────────────────────────────────────────

export async function rollbackMigration(
  companyId: string,
  source: MigrationSource,
): Promise<RollbackResult> {
  const retained: { id: string; code: string }[] = [];
  let deleted = 0;

  try {
    const candidates = (await sql`
      SELECT id, account_code FROM gl_accounts
      WHERE company_id = ${companyId}::UUID AND imported_from = ${source}
      ORDER BY account_code
    `) as DbRow[];

    // One savepoint per account. `gl_accounts` is the target of dozens of
    // foreign keys and nearly all of them are NO ACTION, so a single DELETE
    // over the whole set lets ONE blocking row — a bank account, an asset, a
    // trigger-maintained balance row that outlives its journal lines — raise
    // 23503 and abort the entire rollback. Enumerating the blockers by hand
    // would go stale the first time a table is added; letting Postgres refuse
    // the row cannot. A refusal retains that one account, nothing more.
    for (const [i, row] of candidates.entries()) {
      const id = String(row.id);
      const code = String(row.account_code);
      try {
        await withSavepoint(`mig_rb_${i}`, async () => {
          await sql`DELETE FROM gl_accounts WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID`;
        });
        deleted += 1;
      } catch (err) {
        if ((err as { code?: string }).code !== '23503') throw err;
        retained.push({ id, code });
      }
    }

    // A retained account keeps nothing of the import. Leaving the tag on would
    // leave the delete armed: once the blocking rows go, a later rollback of
    // the same source would take an account that has been in normal use since.
    if (retained.length > 0) {
      await sql`
        UPDATE gl_accounts SET imported_from = NULL
        WHERE company_id = ${companyId}::UUID AND id = ANY(${retained.map(r => r.id)}::UUID[])
      `;
    }

    log.info('Rollback complete', { companyId, source, deleted, retained: retained.length }, 'migration');
  } catch (err) {
    log.error('Rollback failed', { companyId, source, error: err }, 'migration');
    throw err;
  }

  return { deleted, retained: retained.length, retainedCodes: retained.map(r => r.code) };
}
