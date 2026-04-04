/**
 * Migration Execute Service — import parsed Xero/QuickBooks/Pastel data into ISAFlow
 * Uses existing migrationCoaService and migrationContactService patterns.
 */

import { sql, transaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ParsedAccount, ParsedEntity, MigrationSource } from './migrationParserService';
type Row = any;


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
  });

  if (validAccounts.length > 0) {
    try {
      await transaction((txSql) =>
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
            account_name  = EXCLUDED.account_name,
            account_type  = EXCLUDED.account_type,
            imported_from = EXCLUDED.imported_from
        `)
      );
      accountsImported = validAccounts.length;
    } catch (err) {
      errors.push(`Accounts batch: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Set opening balances via journal entry
  const balanceAccounts = accounts.filter(a => a.openingBalance !== 0 && a.sourceCode && a.mappedType);
  if (balanceAccounts.length > 0) {
    try {
      const jeRows = (await sql`
        INSERT INTO gl_journal_entries (
          company_id, entry_date, reference, description, status, created_by
        ) VALUES (
          ${companyId}::UUID,
          CURRENT_DATE,
          ${'OB-' + source.toUpperCase()},
          ${'Opening balances imported from ' + source},
          'posted',
          ${userId}::UUID
        ) RETURNING id
      `) as Row[];

      const jeId = String(jeRows[0].id);

      for (const acct of balanceAccounts) {
        const glRows = (await sql`
          SELECT id FROM gl_accounts
          WHERE company_id = ${companyId}::UUID AND account_code = ${acct.sourceCode}
          LIMIT 1
        `) as Row[];

        if (glRows.length === 0) continue;
        const glId = String(glRows[0].id);
        const isDebitNormal = acct.mappedNormalBalance === 'debit';
        const debit  = isDebitNormal && acct.openingBalance > 0 ? acct.openingBalance : 0;
        const credit = !isDebitNormal && acct.openingBalance > 0 ? acct.openingBalance : 0;

        await sql`
          INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, description)
          VALUES (${jeId}::UUID, ${glId}::UUID, ${debit}, ${credit}, ${'Opening balance — ' + source})
        `;
        openingBalancesSet++;
      }
    } catch (err) {
      errors.push(`Opening balances: ${err instanceof Error ? err.message : String(err)}`);
    }
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
        LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
        LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
        WHERE ga.company_id = ${companyId}::UUID AND ga.account_code = ${acct.sourceCode}
        GROUP BY ga.id, ga.account_name, ga.normal_balance
        LIMIT 1
      `) as Row[];

      const isaflowBalance = glRows.length > 0
        ? (String(glRows[0].normal_balance) === 'debit'
          ? Number(glRows[0].net_debit)
          : -Number(glRows[0].net_debit))
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
): Promise<{ deleted: number }> {
  let deleted = 0;

  try {
    // Remove GL accounts imported from this source
    const acctRows = (await sql`
      DELETE FROM gl_accounts
      WHERE company_id = ${companyId}::UUID AND imported_from = ${source}
      RETURNING id
    `) as Row[];
    deleted += acctRows.length;

    log.info('Rollback complete', { companyId, source, deleted }, 'migration');
  } catch (err) {
    log.error('Rollback failed', { companyId, source, error: err }, 'migration');
    throw err;
  }

  return { deleted };
}
