/**
 * EMP201 drift in the ETI carry (wave 5 ET). A version finalised from ET on records `etiCarry`, and each of its four
 * figures is compared. A version finalised BEFORE ET has none, and its PAYE payable was PAYE - ETI floored at nil; the
 * same runs now give a different payable when ETI was brought forward or used against directive PAYE. That difference is
 * a change in how IsaFlow calculates, not in the pay runs, so it is reported as a note, not as a drifted field to amend.
 */
const cents = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export interface EtiCarryFigures { broughtForward: number; used: number; carriedForward: number; refundClaimable: number }
export interface EmpEtiDrift {
  fields: Array<{ name: string; recorded: number; current: number }>;
  /** True when a payable difference is explained by the calculation change alone: drop payePayable from the fields. */
  payableExplained: boolean;
  notes: string[];
}

export const ETI_CARRY_CALC_NOTE =
  'This EMP201 was finalised before ETI carry-forward was calculated (calculation version 8, wave 5 ET). The PAYE payable now '
  + 'uses ETI brought forward from earlier months or used against directive PAYE (ETI Act s9(1)); the pay runs did not change. '
  + 'Amend only if you want the return to claim that ETI.';

export function empEtiDrift(
  recorded: Record<string, unknown>,
  current: { totalPAYE: number; totalETI: number; payePayable: number; etiCarry: EtiCarryFigures },
): EmpEtiDrift {
  const was = recorded.etiCarry as Partial<EtiCarryFigures> | undefined;
  if (was && typeof was === 'object') {
    const fields = (['broughtForward', 'used', 'carriedForward', 'refundClaimable'] as const)
      .map((k) => ({ name: `etiCarry.${k}`, recorded: cents(num(was[k])), current: cents(current.etiCarry[k]) }))
      .filter((f) => f.recorded !== f.current);
    return { fields, payableExplained: false, notes: [] };
  }
  // Before ET: only the calculation moved when PAYE and ETI are the same and the old payable is the old rule's.
  const sameRuns = cents(num(recorded.totalPAYE)) === cents(current.totalPAYE) && cents(num(recorded.totalETI)) === cents(current.totalETI);
  const oldRule = cents(Math.max(0, num(recorded.totalPAYE) - num(recorded.totalETI))) === cents(num(recorded.payePayable));
  const moved = cents(num(recorded.payePayable)) !== cents(current.payePayable);
  const explained = sameRuns && oldRule && moved;
  return { fields: [], payableExplained: explained, notes: explained ? [ETI_CARRY_CALC_NOTE] : [] };
}
