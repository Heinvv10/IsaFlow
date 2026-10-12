/**
 * The anomaly scan (runAnomalyScan — the same population and analysis as
 * POST /api/accounting/anomaly-scan) recorded as four checks over the run's
 * window. Statistical leads, not verdicts. Benford's test needs more than 20
 * amounts; below that it is `unknown`, not a pass.
 */
import { runAnomalyScan } from '@/modules/accounting/services/core/anomalyScanService';
import { money, result, type CheckResult, type CheckWindow } from './checkTypes';

export const ANOMALY_CHECK_VERSION = 1;
const BENFORD_MIN_SAMPLE = 20;

export async function runAnomalyChecks(w: CheckWindow): Promise<CheckResult[]> {
  const scan = await runAnomalyScan(w.companyId, w.from, w.to);
  const b = scan.benfords;
  const benford = b.sampleSize <= BENFORD_MIN_SAMPLE
    ? result('anomaly.benford', ANOMALY_CHECK_VERSION, 'anomaly', b.sampleSize, [], 'unknown')
    : result('anomaly.benford', ANOMALY_CHECK_VERSION, 'anomaly', b.sampleSize, b.conforming ? [] : [{
      key: 'anomaly.benford', refs: [],
      detail: { chi_square: b.chiSquare.toFixed(4), sample_size: b.sampleSize },
    }]);
  return [
    benford,
    result('anomaly.statistical_outliers', ANOMALY_CHECK_VERSION, 'anomaly', scan.scannedTransactions,
      scan.outliers.outliers.map((t) => ({
        key: `bank_transaction:${t.id}`, refs: [t.id],
        detail: { amount: money(t.amount), z_score: t.zScore.toFixed(2), date: String(t.date).slice(0, 10), description: t.description },
      }))),
    result('anomaly.duplicate_payments', ANOMALY_CHECK_VERSION, 'anomaly', scan.scannedPayments,
      scan.duplicates.map((d) => ({
        key: `supplier_payment:${[d.payment1Id, d.payment2Id].sort().join('+')}`, refs: [d.payment1Id, d.payment2Id],
        detail: { amount: money(d.amount), supplier_id: d.supplierId, confidence: d.confidence.toFixed(2), reason: d.reason },
      }))),
    result('anomaly.unusual_posting_patterns', ANOMALY_CHECK_VERSION, 'anomaly', scan.scannedJournalLines,
      scan.patterns.map((p) => ({
        key: `pattern:${p.type}`, refs: [...new Set(p.entryIds)].sort(),
        detail: { type: p.type, description: p.description, entries: new Set(p.entryIds).size },
      }))),
  ];
}
