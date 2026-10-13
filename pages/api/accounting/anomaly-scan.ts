/**
 * Anomaly Detection Scan API
 * POST: run anomaly detection on recent transactions
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import type { CompanyAuthedRequest } from '@/lib/auth/withAuth';
import { buildAlertMessage } from '@/modules/accounting/services/core/anomalyDetectionService';
import { runAnomalyScan } from '@/modules/accounting/services/core/anomalyScanService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);

  const companyId = (req as CompanyAuthedRequest).companyId;
  const { period } = req.body;
  const fromDate = period || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const { benfords, outliers, duplicates, patterns, scannedTransactions } = await runAnomalyScan(companyId, fromDate);

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

  log.info('Anomaly scan completed', { alerts: alerts.length, transactions: scannedTransactions }, 'ai');

  return apiResponse.success(res, {
    benfords, outliers: { count: outliers.outliers.length, items: outliers.outliers.slice(0, 10) },
    duplicates, patterns, alerts, scannedTransactions,
  });
}
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
