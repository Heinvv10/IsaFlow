/**
 * The anomaly scan's population and analysis, shared by POST
 * /api/accounting/anomaly-scan and the audit check runs (forensic-controls
 * step 4) — one reading of "the transactions the scan looks at", moved here
 * from the route unchanged apart from the optional upper bound `to` and a total order on each
 * sample (newest first, ties by id), so a sealed run's population is the same rows on a re-run.
 */
import { sql } from '@/lib/neon';
import {
  benfordsLawAnalysis, detectStatisticalOutliers, detectDuplicatePayments, detectUnusualPostingPatterns,
  type BenfordsResult, type DuplicateCandidate, type OutlierResult, type PostingAnomaly, type Transaction,
} from './anomalyDetectionService';

type Row = Record<string, unknown>;

export interface AnomalyScan {
  benfords: BenfordsResult;
  outliers: OutlierResult;
  duplicates: DuplicateCandidate[];
  patterns: PostingAnomaly[];
  scannedTransactions: number;
  scannedPayments: number;
  scannedJournalLines: number;
}

/** Dated on or after `from` and, when given, on or before `to`. */
export async function runAnomalyScan(companyId: string, from: string, to: string | null = null): Promise<AnomalyScan> {
  const txRows = await sql`
    SELECT id, description, amount, transaction_date as date FROM bank_transactions
    WHERE company_id = ${companyId}::UUID AND transaction_date >= ${from}
      AND (${to}::DATE IS NULL OR transaction_date <= ${to}::DATE)
      AND feed_state = 'posted'
    ORDER BY transaction_date DESC, id LIMIT 1000
  ` as Row[];
  const transactions: Transaction[] = txRows.map((r: Row) => ({ id: String(r.id), amount: Number(r.amount), description: String(r.description), date: String(r.date) }));

  const payRows = await sql`
    SELECT sp.id, sp.supplier_id, sp.total_amount as amount, sp.payment_date as date, sp.reference
    FROM supplier_payments sp WHERE sp.company_id = ${companyId}::UUID AND sp.payment_date >= ${from}
      AND (${to}::DATE IS NULL OR sp.payment_date <= ${to}::DATE)
    ORDER BY sp.payment_date DESC, sp.id LIMIT 500
  ` as Row[];
  const payments = payRows.map((r: Row) => ({ id: String(r.id), supplierId: String(r.supplier_id), amount: Number(r.amount), date: String(r.date), reference: String(r.reference || '') }));

  const jeRows = await sql`
    SELECT je.id, je.entry_date as date, jl.debit + jl.credit as amount, je.created_by as user_id, je.description
    FROM gl_journal_entries je JOIN gl_journal_lines jl ON je.id = jl.journal_entry_id
    WHERE je.company_id = ${companyId}::UUID AND jl.company_id = ${companyId}::UUID AND je.entry_date >= ${from}
      AND (${to}::DATE IS NULL OR je.entry_date <= ${to}::DATE) AND je.source = 'manual'
    ORDER BY je.entry_date DESC, je.id, jl.id
    LIMIT 500
  ` as Row[];
  const entries = jeRows.map((r: Row) => ({ id: String(r.id), date: String(r.date), amount: Number(r.amount), userId: String(r.user_id), description: String(r.description || '') }));

  return {
    benfords: benfordsLawAnalysis(transactions.map(t => Math.abs(t.amount))),
    outliers: detectStatisticalOutliers(transactions),
    duplicates: detectDuplicatePayments(payments),
    patterns: detectUnusualPostingPatterns(entries),
    scannedTransactions: transactions.length,
    scannedPayments: payments.length,
    scannedJournalLines: entries.length,
  };
}
