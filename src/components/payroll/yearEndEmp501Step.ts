/**
 * The year-end checklist's EMP501 step text (pages/payroll/year-end). `balanced` is what SARS's EMP501 compares, EMP201
 * against IRP5 PAYE, so a year with PSP PAYE (on no certificate until PSP-H) never reads balanced: when the PSP PAYE is the
 * whole difference the step says so instead of a bare variance (review of #1566 round 3, L1). A viewer for whom the PSP
 * figures are withheld (fewer than 2 PSP payees) sees the server's note instead.
 */
import { formatCurrency } from '@/utils/formatters';

export interface Emp501StepFigures {
  balanced: boolean; totalEmp201: number; totalIrp5: number; totalVariance: number;
  pspPaye?: number; unexplainedVariance?: number; pspNote?: string;
}

export function emp501StepDetail(e: Emp501StepFigures): string {
  if (e.totalEmp201 <= 0) return 'No EMP501 data yet — post runs first';
  const figures = `EMP201 ${formatCurrency(e.totalEmp201)} · IRP5 ${formatCurrency(e.totalIrp5)} · variance ${formatCurrency(Math.abs(e.totalVariance))}`;
  if ((e.pspPaye ?? 0) > 0 && e.unexplainedVariance !== undefined && Math.abs(e.unexplainedVariance) < 0.01) {
    return `Explained by PSP PAYE (${formatCurrency(e.pspPaye!)}); the PSP certificate (PSP-H) is not built yet · ${figures}`;
  }
  if ((e.pspPaye ?? 0) > 0) return `${figures} (of which PSP PAYE ${formatCurrency(e.pspPaye!)}, on no certificate here: see EMP501)`;
  return e.pspNote ? `${figures} · ${e.pspNote}` : figures;
}
