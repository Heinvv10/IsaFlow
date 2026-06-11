/**
 * Parallel-run comparator — pure, no DB, no clock.
 *
 * Compares an IsaFlow payroll run's lines against an imported external
 * (Sage/VIP) payslip dataset for the same period. Matching is by employee
 * number: trimmed, case-insensitive, and zero-padding-insensitive for purely
 * numeric numbers ("001" matches "1"; "E001" does NOT match "E1").
 *
 * Only components present in the external data are compared; `uifTotal` is
 * compared against IsaFlow's employee + employer UIF sum. All amounts are
 * integer cents (see payrollParallelRunTypes).
 */

import type {
  ComparisonComponentKey,
  ComponentComparison,
  EmployeeComparison,
  ExternalPayslipRow,
  IsaflowRunLineInput,
  ParallelRunComparisonReport,
} from './payrollParallelRunTypes';

export interface CompareOptions {
  /** |diff| <= tolerance still counts as a match. Default 0 (exact cent). */
  toleranceCents?: number;
}

function matchKey(employeeNumber: string): string {
  const trimmed = employeeNumber.trim().toUpperCase();
  return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed;
}

function isaflowValue(line: IsaflowRunLineInput, key: ComparisonComponentKey): number {
  if (key === 'uifTotal') return line.uifEmployee + line.uifEmployer;
  return line[key];
}

const STATUS_ORDER: Record<EmployeeComparison['status'], number> = {
  missing_in_isaflow: 0,
  missing_in_external: 1,
  variance: 2,
  match: 3,
};

export function compareParallelRun(
  isaflowLines: IsaflowRunLineInput[],
  externalRows: ExternalPayslipRow[],
  options: CompareOptions = {},
): ParallelRunComparisonReport {
  const toleranceCents = options.toleranceCents ?? 0;

  const componentsCompared = ([...new Set(
    externalRows.flatMap((r) => Object.keys(r.amounts) as ComparisonComponentKey[]),
  )]);

  const isaMap = new Map<string, IsaflowRunLineInput>();
  for (const line of isaflowLines) isaMap.set(matchKey(line.employeeNumber), line);
  const extMap = new Map<string, ExternalPayslipRow>();
  for (const row of externalRows) extMap.set(matchKey(row.employeeNumber), row);

  const allKeys = [...new Set([...isaMap.keys(), ...extMap.keys()])];
  const employees: EmployeeComparison[] = [];

  for (const key of allKeys) {
    const isa = isaMap.get(key) ?? null;
    const ext = extMap.get(key) ?? null;

    const components: ComponentComparison[] = componentsCompared.map((component) => {
      const isaflowCents = isa ? isaflowValue(isa, component) : null;
      const externalCents = ext ? (ext.amounts[component] ?? null) : null;
      const diffCents = isaflowCents !== null && externalCents !== null
        ? isaflowCents - externalCents
        : null;
      return { component, isaflowCents, externalCents, diffCents };
    });

    const maxAbsDiffCents = components.reduce(
      (max, c) => (c.diffCents !== null ? Math.max(max, Math.abs(c.diffCents)) : max),
      0,
    );

    let status: EmployeeComparison['status'];
    if (!isa) status = 'missing_in_isaflow';
    else if (!ext) status = 'missing_in_external';
    else status = maxAbsDiffCents > toleranceCents ? 'variance' : 'match';

    employees.push({
      employeeNumber: (isa?.employeeNumber ?? ext?.employeeNumber ?? '').trim(),
      employeeName: isa?.employeeName ?? ext?.employeeName ?? '',
      status,
      components,
      maxAbsDiffCents,
    });
  }

  employees.sort((a, b) => {
    if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) {
      return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    }
    if (a.status === 'variance' && a.maxAbsDiffCents !== b.maxAbsDiffCents) {
      return b.maxAbsDiffCents - a.maxAbsDiffCents;
    }
    return a.employeeNumber.localeCompare(b.employeeNumber, undefined, { numeric: true });
  });

  const matchedBothSides = allKeys.filter((k) => isaMap.has(k) && extMap.has(k)).length;
  const matchToTheCent = employees.filter((e) => e.status === 'match').length;
  const withVariance = employees.filter((e) => e.status === 'variance').length;

  const componentTotals: ComponentComparison[] = componentsCompared.map((component) => {
    const isaflowCents = isaflowLines.reduce((sum, l) => sum + isaflowValue(l, component), 0);
    const externalCents = externalRows.reduce(
      (sum, r) => sum + (r.amounts[component] ?? 0),
      0,
    );
    return { component, isaflowCents, externalCents, diffCents: isaflowCents - externalCents };
  });

  return {
    componentsCompared,
    toleranceCents,
    summary: {
      employeesIsaflow: isaMap.size,
      employeesExternal: extMap.size,
      matchedBothSides,
      matchToTheCent,
      withVariance,
      missingInIsaflow: employees.filter((e) => e.status === 'missing_in_isaflow').length,
      missingInExternal: employees.filter((e) => e.status === 'missing_in_external').length,
      matchRate: matchedBothSides > 0 ? matchToTheCent / matchedBothSides : null,
      componentTotals,
    },
    employees,
  };
}
