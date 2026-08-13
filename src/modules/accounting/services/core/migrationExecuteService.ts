/**
 * Migration Execute Service — import parsed Xero/QuickBooks/Pastel data into ISAFlow
 * Uses existing migrationCoaService and migrationContactService patterns.
 */

import { sql, transaction, fmtDate } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  createJournalEntry,
  postJournalEntry,
} from '@/modules/accounting/services/gl/journalEntryService';
import { roundToCents } from '@/modules/accounting/utils/doubleEntry';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import type { ParsedAccount, ParsedEntity, MigrationSource } from './migrationParserService';
import type { DbRow } from '@/types/db';


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

  // 2. Set opening balances via a single journal entry.
  //
  // Every account is resolved before anything is written, and the entry is
  // posted only if the whole set balances. The previous shape did
  // `if (glRows.length === 0) continue;` — an account that failed to import in
  // step 1 silently vanished from the journal while the others kept their
  // balances, and the entry went in via a hand-rolled INSERT already at
  // status='posted' (trg_gl_je_balanced fires only on UPDATE), so nothing
  // caught the resulting lopsided opening trial balance.
  //
  // Nothing is plugged to a suspense or equity account: a source file whose
  // trial balance does not sum to zero is a data problem the operator has to
  // see, and fabricating the difference as equity would bury it.
  const balanceAccounts = accounts.filter(a => a.openingBalance !== 0 && a.sourceCode && a.mappedType);
  if (balanceAccounts.length > 0) {
    try {
      const lines: JournalLineInput[] = [];
      const unresolved: string[] = [];

      for (const acct of balanceAccounts) {
        const glRows = (await sql`
          SELECT id FROM gl_accounts
          WHERE company_id = ${companyId}::UUID AND account_code = ${acct.sourceCode}
          LIMIT 1
        `) as DbRow[];
        if (glRows.length === 0) {
          unresolved.push(`${acct.sourceCode} ${acct.sourceName}`);
          continue;
        }
        const glId = String(glRows[0]!.id);
        const isDebitNormal = acct.mappedNormalBalance === 'debit';
        const debit  = isDebitNormal && acct.openingBalance > 0 ? acct.openingBalance : 0;
        const credit = !isDebitNormal && acct.openingBalance > 0 ? acct.openingBalance : 0;
        lines.push({
          glAccountId: glId,
          debit,
          credit,
          description: `Opening balance — ${source}`,
        });
      }

      if (unresolved.length > 0) {
        // Dropping these and posting the remainder is what produced an
        // unbalanced opening trial balance. Refuse the whole journal.
        throw new Error(
          `no GL account was created for ${unresolved.join('; ')} — opening balances not imported (fix the account import, then re-run)`,
        );
      }

      if (lines.length > 0) {
        const totalDebit = roundToCents(lines.reduce((s, l) => s + l.debit, 0));
        const totalCredit = roundToCents(lines.reduce((s, l) => s + l.credit, 0));
        const difference = roundToCents(totalDebit - totalCredit);
        if (difference !== 0) {
          throw new Error(
            `source trial balance does not sum to zero — debits R${totalDebit.toFixed(2)} vs credits R${totalCredit.toFixed(2)} (difference R${Math.abs(difference).toFixed(2)}); opening balances not imported`,
          );
        }

        // createJournalEntry batches header + lines into one transaction and
        // runs validateJournalEntry; postJournalEntry re-validates and checks
        // the fiscal period is open. Deliberately NOT wrapped in
        // withTransaction — that acquires a separate pool client and would
        // deadlock against rows locked by the request-scoped transaction.
        const entry = await createJournalEntry(companyId, {
          entryDate: fmtDate(new Date()),
          description: `Opening balances imported from ${source}`,
          source: 'auto_migration',
          reference: `OB-${source.toUpperCase()}`,
          lines,
        }, userId, { postingAgent: `system:migration:${source}` });

        await postJournalEntry(companyId, entry.id, userId);
        openingBalancesSet = lines.length;
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
): Promise<{ deleted: number }> {
  let deleted = 0;

  try {
    // Remove GL accounts imported from this source
    const acctRows = (await sql`
      DELETE FROM gl_accounts
      WHERE company_id = ${companyId}::UUID AND imported_from = ${source}
      RETURNING id
    `) as DbRow[];
    deleted += acctRows.length;

    log.info('Rollback complete', { companyId, source, deleted }, 'migration');
  } catch (err) {
    log.error('Rollback failed', { companyId, source, error: err }, 'migration');
    throw err;
  }

  return { deleted };
}
