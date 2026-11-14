/**
 * Maps a case's retirement-funding inputs (kept in `unmodelled` until RF) onto the engine's own steps, so the oracle costs an
 * employer's fund contribution the way a run does: `erRetirementPctOfRfi` (a percentage, 15 = 15%) adds an employer pension
 * contribution earning (3817) assigned as that share of RFI, and the case's 3601 earnings count as RFI (migration 975's
 * default). withEmployerRetirement runs before withFringeBenefits, which marks the 3817 non-cash as a run does
 * (markNonCashEmployerBenefits); costRfi then costs it (rfi.costPercentOfRfi). The case's `rfiBase` must equal the RFI the
 * engine derives (a mismatch throws, so a fixture cannot drift from the rule). UIF and SDL are levied on the benefit (the run sets
 * both flags, employerContributions.ts: UI Contributions Act s1; G21 p. 11); the case's UIF is at the ceiling either way.
 */
import { costPercentOfRfi } from '@/modules/accounting/services/payroll/rfi';
import type { EmployeeComponent } from '@/modules/accounting/services/payroll/payrollTypes';

type Unmodelled = Record<string, unknown> | undefined;
const num = (u: Unmodelled, k: string): number | undefined => (typeof u?.[k] === 'number' ? (u[k] as number) : undefined);

export function withEmployerRetirement(components: EmployeeComponent[], unmodelled: Unmodelled): EmployeeComponent[] {
  const pct = num(unmodelled, 'erRetirementPctOfRfi');
  if (pct === undefined) return components;
  const flagged = components.map((c) => (c.component.componentType === 'earning' && c.component.sarsSourceCode === '3601'
    ? { ...c, component: { ...c.component, countsAsRfi: true } } : c));
  return [...flagged, {
    component: {
      id: 'oracle-er-pension', name: 'Employer pension contribution', sarsSourceCode: '3817', componentType: 'earning',
      isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
    },
    amount: 0, percentOfRfi: pct / 100,
  }];
}

export function costRfi(components: EmployeeComponent[], unmodelled: Unmodelled): EmployeeComponent[] {
  if (num(unmodelled, 'erRetirementPctOfRfi') === undefined) return components;
  const { components: costed, rfi } = costPercentOfRfi(components);
  const base = num(unmodelled, 'rfiBase');
  if (base !== rfi) throw new Error(`The case's rfiBase ${String(base)} is not the engine's RFI ${rfi}`);
  return costed;
}
