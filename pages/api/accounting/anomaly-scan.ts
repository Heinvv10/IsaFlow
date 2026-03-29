/**
 * Anomaly Detection Scan API
 * POST: run anomaly detection on recent transactions
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  benfordsLawAnalysis, detectStatisticalOutliers, detectDuplicatePayments,
  detectUnusualPostingPatterns, buildAlertMessage, type Transaction,
} from '@/modules/accounting/services/anomalyDetectionService';

type Row = Record<string, unknown>;

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const companyId = (req as any).companyId as string;
  const { period } = req.body;
  const fromDate = period || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  // Get recent transactions
  const txRows = await sql`
    SELECT id, description, amount, transaction_date as date FROM bank_transactions
    WHERE transaction_date >= ${fromDate} ORDER BY transaction_date DESC LIMIT 1000
  ` as Row[];
  const transactions: Transaction[] = txRows.map((r: any) => ({ id: String(r.id), amount: Number(r.amount), description: String(r.description), date: String(r.date) }));

  // Get recent payments for duplicate detection
  const payRows = await sql`
    SELECT sp.id, sp.supplier_id, sp.total_amount as amount, sp.payment_date as date, sp.reference
    FROM supplier_payments sp WHERE sp.payment_date >= ${fromDate}
    ORDER BY sp.payment_date DESC LIMIT 500
  ` as Row[];
  const payments = payRows.map((r: any) => ({ id: String(r.id), supplierId: String(r.supplier_id), amount: Number(r.amount), date: String(r.date), reference: String(r.reference || '') }));

  // Get journal entries for posting pattern analysis
  const jeRows = await sql`
    SELECT je.id, je.entry_date as date, jl.debit + jl.credit as amount, je.created_by as user_id, je.description
    FROM gl_journal_entries je JOIN gl_journal_lines jl ON je.id = jl.journal_entry_id
    WHERE je.entry_date >= ${fromDate} AND je.source = 'manual'
    LIMIT 500
  ` as Row[];
  const entries = jeRows.map((r: any) => ({ id: String(r.id), date: String(r.date), amount: Number(r.amount), userId: String(r.user_id), description: String(r.description || '') }));

  // Run all detections
  const benfords = benfordsLawAnalysis(transactions.map(t => Math.abs(t.amount)));
  const outliers = detectStatisticalOutliers(transactions);
  const duplicates = detectDuplicatePayments(payments);
  const patterns = detectUnusualPostingPatterns(entries);

  // Build alerts
  const alerts = [];
  if (!benfords.conforming && benfords.sampleSize > 20) {
    alerts.push(buildAlertMessage('benfords_violation', 'warning', { chiSquare: benfords.chiSquare }));
  }
  for (const o of outliers.outliers.slice(0, 5)) {
    alerts.push(buildAlertMessage('unusual_amount', 'warning', { amount: o.amount, description: o.description }));
  }
  for (const d of duplicates) {
    alerts.push(buildAlertMessage('duplicate_payment', d.confidence >= 0.9 ? 'critical' : 'warning', { amount: d.amount, supplier: d.supplierId }));
  }
  for (const p of patterns) {
    alerts.push(buildAlertMessage(p.type, 'info', { count: p.entryIds.length }));
  }

  log.info('Anomaly scan completed', { alerts: alerts.length, transactions: transactions.length }, 'ai');

  return apiResponse.success(res, {
    benfords, outliers: { count: outliers.outliers.length, items: outliers.outliers.slice(0, 10) },
    duplicates, patterns, alerts, scannedTransactions: transactions.length,
  });
}
export default withCompany(withErrorHandler(handler as any));
