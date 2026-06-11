/**
 * CSV rendering of a parallel-run comparison report — pure, no DB.
 * One row per employee per compared component, plus a grand-total block.
 * Amounts are rendered in rand with 2 decimals (from integer cents).
 */

import type {
  ComponentComparison,
  ParallelRunComparisonReport,
} from './payrollParallelRunTypes';
import { COMPONENT_LABELS } from './payrollParallelRunTypes';

function rand(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

function escapeCsvField(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function componentRows(
  prefixCells: string[],
  status: string,
  components: ComponentComparison[],
): string[] {
  return components.map((c) => [
    ...prefixCells,
    status,
    COMPONENT_LABELS[c.component],
    rand(c.isaflowCents),
    rand(c.externalCents),
    rand(c.diffCents),
  ].map(escapeCsvField).join(','));
}

export function buildParallelRunComparisonCsv(
  report: ParallelRunComparisonReport,
): string {
  const lines: string[] = [
    'employee_number,employee_name,status,component,isaflow,external,diff',
  ];
  for (const emp of report.employees) {
    lines.push(...componentRows(
      [emp.employeeNumber, emp.employeeName],
      emp.status,
      emp.components,
    ));
  }
  lines.push(...componentRows(['TOTAL', ''], '', report.summary.componentTotals));
  return lines.join('\n');
}
