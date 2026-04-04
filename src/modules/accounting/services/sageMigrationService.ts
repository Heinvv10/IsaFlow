/**
 * PRD-060 Phase 6: Sage Migration Service
 * Status, account mapping, comparison, reset + re-exports importers
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
type Row = Record<string, unknown>;

// Re-export importers so API routes import from one place
export { importLedgerTransactions, importSupplierInvoices } from './sageImportService';
export { importCustomerInvoices } from './sageCustomerImportService';


// ── Types ───────────────────────────────────────────────────────────────────

export interface MigrationStatus {
  accounts: { sageTotal: number; mapped: number; unmapped: number; autoMapped: number };
  ledger: { sageTotal: number; imported: number; pending: number; failed: number; dateRange: { earliest: string | null; latest: string | null } };
  invoices: { sageTotal: number; imported: number; pending: number; failed: number };
  customerInvoices: { sageTotal: number; imported: number; pending: number; failed: number };
  lastRuns: MigrationRun[];
}

export interface MigrationRun {
  id: string; runType: string; status: string; totalRecords: number;
  processed: number; succeeded: number; failed: number; skipped: number;
  startedAt: string; completedAt: string | null;
}

export interface AccountMapping {
  sageAccountId: string; sageName: string; sageType: number | null; sageBalance: number;
  glAccountId: string | null; glAccountCode: string | null; glAccountName: string | null;
  mappingStatus: string; mappingNotes: string | null;
}

export interface ComparisonReport {
  comparisonDate: string;
  sageTotals: { totalDebit: number; totalCredit: number; accountCount: number };
  glTotals: { totalDebit: number; totalCredit: number; accountCount: number };
  differences: Array<{ accountCode: string; accountName: string; sageBalance: number; glBalance: number; difference: number }>;
  isBalanced: boolean;
}

// ── Run Tracking (exported for sageImportService) ───────────────────────────

export async function startRun(runType: string, userId: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_migration_runs (run_type, status, started_by)
    VALUES (${runType}, 'running', ${userId})
    RETURNING id
  `) as Row[];
  return String(rows[0]!.id);
}

export async function completeRun(
  runId: string, total: number, succeeded: number, failed: number, skipped: number
): Promise<MigrationRun> {
  const status = failed === 0 ? 'completed' : 'partial';
  const rows = (await sql`
    UPDATE gl_migration_runs
    SET status = ${status}, total_records = ${total}, processed = ${succeeded + failed + skipped},
        succeeded = ${succeeded}, failed = ${failed}, skipped = ${skipped}, completed_at = NOW()
    WHERE id = ${runId}::UUID RETURNING *
  `) as Row[];
  const r = rows[0]!;
  return {
    id: String(r.id), runType: String(r.run_type), status: String(r.status),
    totalRecords: Number(r.total_records), processed: Number(r.processed),
    succeeded: Number(r.succeeded), failed: Number(r.failed), skipped: Number(r.skipped),
    startedAt: String(r.started_at), completedAt: r.completed_at ? String(r.completed_at) : null,
  };
}

export async function failRun(runId: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : 'Unknown error';
  await sql`
    UPDATE gl_migration_runs SET status = 'failed', error_message = ${msg}, completed_at = NOW()
    WHERE id = ${runId}::UUID
  `;
}

// ── Migration Status ────────────────────────────────────────────────────────

export async function getMigrationStatus(companyId: string): Promise<MigrationStatus> {
  try {
    const accountStats = (await sql`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE gl_account_id IS NOT NULL) AS mapped,
        COUNT(*) FILTER (WHERE gl_account_id IS NULL) AS unmapped,
        COUNT(*) FILTER (WHERE mapping_status = 'auto') AS auto_mapped
      FROM sage_accounts
    `) as Row[];

    const ledgerStats = (await sql`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE migration_status = 'imported') AS imported,
        COUNT(*) FILTER (WHERE migration_status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE migration_status = 'failed') AS failed,
        MIN(transaction_date) AS earliest, MAX(transaction_date) AS latest
      FROM sage_ledger_transactions
    `) as Row[];

    const invoiceStats = (await sql`
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE migration_status = 'imported') AS imported,
        COUNT(*) FILTER (WHERE migration_status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE migration_status = 'failed') AS failed
      FROM sage_supplier_invoices
    `) as Row[];

    let customerInvoiceStats: Row[] = [{ total: 0, imported: 0, pending: 0, failed: 0 }];
    try {
      customerInvoiceStats = (await sql`
        SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE migration_status = 'imported') AS imported,
          COUNT(*) FILTER (WHERE migration_status = 'pending') AS pending,
          COUNT(*) FILTER (WHERE migration_status = 'failed') AS failed
        FROM sage_customer_invoices
      `) as Row[];
    } catch {
      // Table may not exist yet if migration 212 hasn't run
    }

    const runs = (await sql`
      SELECT id, run_type, status, total_records, processed, succeeded, failed, skipped,
        started_at, completed_at
      FROM gl_migration_runs ORDER BY started_at DESC LIMIT 10
    `) as Row[];

    return {
      accounts: {
        sageTotal: Number(accountStats[0]?.total || 0), mapped: Number(accountStats[0]?.mapped || 0),
        unmapped: Number(accountStats[0]?.unmapped || 0), autoMapped: Number(accountStats[0]?.auto_mapped || 0),
      },
      ledger: {
        sageTotal: Number(ledgerStats[0]?.total || 0), imported: Number(ledgerStats[0]?.imported || 0),
        pending: Number(ledgerStats[0]?.pending || 0), failed: Number(ledgerStats[0]?.failed || 0),
        dateRange: { earliest: ledgerStats[0]?.earliest ? String(ledgerStats[0].earliest) : null, latest: ledgerStats[0]?.latest ? String(ledgerStats[0].latest) : null },
      },
      invoices: {
        sageTotal: Number(invoiceStats[0]?.total || 0), imported: Number(invoiceStats[0]?.imported || 0),
        pending: Number(invoiceStats[0]?.pending || 0), failed: Number(invoiceStats[0]?.failed || 0),
      },
      customerInvoices: {
        sageTotal: Number(customerInvoiceStats[0]?.total || 0),
        imported: Number(customerInvoiceStats[0]?.imported || 0),
        pending: Number(customerInvoiceStats[0]?.pending || 0),
        failed: Number(customerInvoiceStats[0]?.failed || 0),
      },
      lastRuns: runs.map((r: Row) => ({
        id: String(r.id), runType: String(r.run_type), status: String(r.status),
        totalRecords: Number(r.total_records), processed: Number(r.processed),
        succeeded: Number(r.succeeded), failed: Number(r.failed), skipped: Number(r.skipped),
        startedAt: String(r.started_at), completedAt: r.completed_at ? String(r.completed_at) : null,
      })),
    };
  } catch (err) {
    log.error('Failed to get migration status', { error: err }, 'accounting');
    throw err;
  }
}

// ── Account Mapping ─────────────────────────────────────────────────────────

export async function getAccountMappings(companyId: string): Promise<AccountMapping[]> {
  const rows = (await sql`
    SELECT sa.sage_account_id, sa.name, sa.account_type, sa.balance,
      sa.gl_account_id, sa.mapping_status, sa.mapping_notes,
      ga.account_code, ga.account_name
    FROM sage_accounts sa LEFT JOIN gl_accounts ga ON ga.id = sa.gl_account_id
    ORDER BY sa.name
  `) as Row[];

  return rows.map((r: Row) => ({
    sageAccountId: String(r.sage_account_id), sageName: String(r.name),
    sageType: r.account_type != null ? Number(r.account_type) : null,
    sageBalance: Number(r.balance || 0),
    glAccountId: r.gl_account_id ? String(r.gl_account_id) : null,
    glAccountCode: r.account_code ? String(r.account_code) : null,
    glAccountName: r.account_name ? String(r.account_name) : null,
    mappingStatus: String(r.mapping_status || 'unmapped'),
    mappingNotes: r.mapping_notes ? String(r.mapping_notes) : null,
  }));
}

function nameSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/[\s\-_&/]+/).filter(Boolean));
  const tokensB = new Set(b.split(/[\s\-_&/]+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
    else { for (const tb of tokensB) { if (tb.includes(t) || t.includes(tb)) { overlap += 0.5; break; } } }
  }
  return overlap / Math.max(tokensA.size, tokensB.size);
}

export async function autoMapAccounts(companyId: string, userId: string): Promise<MigrationRun> {
  const runId = await startRun('account_mapping', userId);
  try {
    const sageAccounts = (await sql`
      SELECT id, sage_account_id, name, account_type, balance FROM sage_accounts WHERE gl_account_id IS NULL ORDER BY name
    `) as Row[];
    const glAccounts = (await sql`
      SELECT id, account_code, account_name, account_type FROM gl_accounts WHERE level >= 3 AND is_active = true ORDER BY account_code
    `) as Row[];

    let succeeded = 0; let skipped = 0;
    const typeMap: Record<number, string> = { 1: 'revenue', 2: 'expense', 5: 'asset', 6: 'liability', 7: 'equity' };

    for (const sage of sageAccounts) {
      const sageName = String(sage.name).toLowerCase().trim();
      const sageType = sage.account_type != null ? typeMap[Number(sage.account_type)] : null;
      let bestMatch: Row | null = null; let bestScore = 0;

      for (const gl of glAccounts) {
        if (sageType && String(gl.account_type) !== sageType) continue;
        const score = nameSimilarity(sageName, String(gl.account_name).toLowerCase().trim());
        if (score > bestScore && score >= 0.6) { bestScore = score; bestMatch = gl; }
      }

      if (bestMatch) {
        await sql`
          UPDATE sage_accounts SET gl_account_id = ${bestMatch.id}::UUID, mapping_status = 'auto',
            mapping_notes = ${`Auto-mapped (${(bestScore * 100).toFixed(0)}% match) to ${bestMatch.account_code}`}
          WHERE id = ${sage.id}
        `;
        succeeded++;
      } else { skipped++; }
    }
    return await completeRun(runId, sageAccounts.length, succeeded, 0, skipped);
  } catch (err) { await failRun(runId, err); throw err; }
}

export async function mapAccount(companyId: string, sageAccountId: string, glAccountId: string | null, notes?: string): Promise<void> {
  if (glAccountId) {
    await sql`UPDATE sage_accounts SET gl_account_id = ${glAccountId}::UUID, mapping_status = 'manual',
      mapping_notes = ${notes || 'Manually mapped'} WHERE sage_account_id = ${sageAccountId}`;
  } else {
    await sql`UPDATE sage_accounts SET gl_account_id = NULL, mapping_status = 'unmapped',
      mapping_notes = ${notes || null} WHERE sage_account_id = ${sageAccountId}`;
  }
}

// ── Comparison ──────────────────────────────────────────────────────────────

export async function generateComparison(companyId: string, userId: string): Promise<ComparisonReport> {
  try {
    const sageBalances = (await sql`
      SELECT sa.sage_account_id, sa.name, sa.balance, ga.account_code, ga.account_name, ga.id AS gl_id
      FROM sage_accounts sa JOIN gl_accounts ga ON ga.id = sa.gl_account_id ORDER BY ga.account_code
    `) as Row[];

    const glBalances = (await sql`
      SELECT ga.id, ga.account_code, ga.account_name, ga.normal_balance,
        COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_accounts ga
      LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
      LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
      WHERE ga.level >= 3 GROUP BY ga.id, ga.account_code, ga.account_name, ga.normal_balance ORDER BY ga.account_code
    `) as Row[];

    const glMap = new Map<string, number>();
    let glTotalDebit = 0; let glTotalCredit = 0;
    for (const gl of glBalances) {
      const d = Number(gl.total_debit), c = Number(gl.total_credit);
      glMap.set(String(gl.id), String(gl.normal_balance) === 'debit' ? d - c : c - d);
      glTotalDebit += d; glTotalCredit += c;
    }

    const differences: ComparisonReport['differences'] = [];
    let sageTotalDebit = 0; let sageTotalCredit = 0;
    for (const sage of sageBalances) {
      const sb = Number(sage.balance || 0), gb = glMap.get(String(sage.gl_id)) || 0;
      if (sb > 0) sageTotalDebit += sb; else sageTotalCredit += Math.abs(sb);
      if (Math.abs(sb - gb) > 0.01) {
        differences.push({ accountCode: String(sage.account_code), accountName: String(sage.account_name), sageBalance: sb, glBalance: gb, difference: sb - gb });
      }
    }

    const report: ComparisonReport = {
      comparisonDate: new Date().toISOString().slice(0, 10),
      sageTotals: { totalDebit: sageTotalDebit, totalCredit: sageTotalCredit, accountCount: sageBalances.length },
      glTotals: { totalDebit: glTotalDebit, totalCredit: glTotalCredit, accountCount: glBalances.length },
      differences, isBalanced: differences.length === 0,
    };

    await sql`
      INSERT INTO gl_migration_comparisons (comparison_date, sage_totals, gl_totals, differences, is_balanced, created_by)
      VALUES (${report.comparisonDate}, ${JSON.stringify(report.sageTotals)}, ${JSON.stringify(report.glTotals)},
        ${JSON.stringify(report.differences)}, ${report.isBalanced}, ${userId})
    `;
    return report;
  } catch (err) { log.error('Failed to generate comparison', { error: err }, 'accounting'); throw err; }
}

// ── Reset ───────────────────────────────────────────────────────────────────

export async function resetMigration(companyId: string, 
  runType: 'accounts' | 'ledger' | 'invoices' | 'customer_invoices'
): Promise<void> {
  if (runType === 'accounts') {
    await sql`UPDATE sage_accounts SET gl_account_id = NULL, mapping_status = 'unmapped', mapping_notes = NULL`;
  } else if (runType === 'ledger') {
    await sql`UPDATE sage_ledger_transactions SET migration_status = 'pending', gl_journal_entry_id = NULL`;
  } else if (runType === 'invoices') {
    await sql`UPDATE sage_supplier_invoices SET migration_status = 'pending', gl_supplier_invoice_id = NULL`;
  } else if (runType === 'customer_invoices') {
    await sql`UPDATE sage_customer_invoices SET migration_status = 'pending', gl_customer_invoice_id = NULL`;
  }
}
