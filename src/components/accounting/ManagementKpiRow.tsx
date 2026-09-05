/**
 * The management-accounts KPI row. Extracted from the page so
 * management-accounts.tsx stays under the 300-line cap.
 */
import { KpiTile } from '@/components/accounting/kpi/KpiTile';

export interface ManagementKpis {
  revenue: number;
  grossProfit: number;
  grossProfitPct: number;
  netProfit: number;
  netProfitPct: number;
  cashPosition: number;
}

export function ManagementKpiRow({ k }: { k: ManagementKpis | undefined }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiTile label="Revenue" value={k?.revenue ?? 0} kind="money" />
      <KpiTile label="Gross profit" value={k?.grossProfit ?? 0} kind="money" note={`${(k?.grossProfitPct ?? 0).toFixed(1)}% margin`} />
      <KpiTile label="Net profit" value={k?.netProfit ?? 0} kind="money" note={`${(k?.netProfitPct ?? 0).toFixed(1)}% margin`} />
      <KpiTile label="Cash" value={k?.cashPosition ?? 0} kind="money" />
    </div>
  );
}
