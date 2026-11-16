/**
 * Reading the pay-frequency and run-kind columns (migration 999a) off a row. A value outside the known set is
 * refused, never coerced: the CHECKs allow only these, so another value means a schema this code predates.
 * An ABSENT key (undefined) reads as the column default: only a hand-built row lacks it, since every
 * SELECT * of the two tables carries the columns from 999a on.
 */
import { PAY_FREQUENCIES, type OffCycleReason, type PayFrequency, type RunKind } from './payrollTypesRun';

export function payFrequencyOf(raw: unknown): PayFrequency {
  if (raw === undefined) return 'monthly';
  const known = PAY_FREQUENCIES.find((f) => f === raw);
  if (!known) throw new Error(`Unknown pay frequency '${String(raw)}'`);
  return known;
}

export function runKindOf(raw: unknown): RunKind {
  if (raw === undefined || raw === 'regular') return 'regular';
  if (raw === 'off_cycle') return 'off_cycle';
  throw new Error(`Unknown run kind '${String(raw)}'`);
}

export function offCycleReasonOf(raw: unknown): OffCycleReason | null {
  if (raw === undefined || raw === null) return null;
  if (raw === 'bonus' || raw === 'termination') return raw;
  throw new Error(`Unknown off-cycle reason '${String(raw)}'`);
}

/** A DATE column as 'YYYY-MM-DD' (pgTypes parses DATE to that string; a Date from a hand-built row reads by its local day). */
export function dateColumnOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (raw instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${raw.getFullYear()}-${p(raw.getMonth() + 1)}-${p(raw.getDate())}`;
  }
  return String(raw).slice(0, 10);
}
