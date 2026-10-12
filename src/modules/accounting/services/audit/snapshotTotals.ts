/**
 * The totals a snapshot carries beside its rows: AR / AP ageing at the cutoff
 * (getAgingReport, the canonical aged report) and the AR / AP / bank
 * sub-ledger control totals against the GL (reconcileSubledger, as the
 * reconcile_subledger tool and the board pack read them). Each is read in its
 * own SAVEPOINT; one that cannot be produced is recorded with its error — a
 * snapshot is never refused because a report could not answer.
 *
 * Amounts become two-place decimal strings so the canonical JSON round-trips.
 */
import { withSavepoint } from '@/lib/neon';
import { getAgingReport } from '@/modules/accounting/services/reports/agingReportService';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { money } from './checks/checkTypes';

type Totals = Record<string, string | number | null | Record<string, string | null>>;

const amount = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : money(n));

async function attempt(name: string, fn: () => Promise<Totals>): Promise<Totals> {
  try {
    return await withSavepoint(`audit_totals_${name}`, fn);
  } catch (err) {
    return { error: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }
}

export async function snapshotTotals(companyId: string, cutoff: string): Promise<Record<string, Totals>> {
  const out: Record<string, Totals> = {};
  for (const side of ['ar', 'ap'] as const) {
    out[`ageing_${side}`] = await attempt(`ageing_${side}`, async () => {
      const r = await getAgingReport(companyId, side, cutoff);
      const t = r.totals as unknown as Record<string, number>;
      return {
        buckets: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, amount(typeof v === 'number' ? v : null)])),
        excluded_total: amount(r.excludedTotal), unapplied: amount(r.unappliedReceipts),
        subledger_total: amount(r.subledgerTotal), excluded_documents: r.excluded.length,
      };
    });
  }
  for (const role of ['ar', 'ap', 'bank'] as const) {
    out[`control_${role}`] = await attempt(`control_${role}`, async () => {
      const r = await reconcileSubledger(companyId, role, cutoff);
      return {
        aged_total: amount(r.agedTotal), subledger_total: amount(r.subledgerTotal),
        control_account_balance: amount(r.controlAccountBalance), difference: amount(r.difference),
        unexplained_difference: amount(r.unexplainedDifference), control_accounts: r.controlAccounts.length,
        subledger_unavailable: r.subledgerUnavailable?.reason ?? null,
      };
    });
  }
  return out;
}
