/**
 * Who sees per-head budget detail (budgets decision 15, POPIA; Hein 2026-10-30). Pure: no I/O.
 *
 * A per_head driver's rate is a person's budgeted pay wherever its cost centre holds one head, and
 * the headcount beside a per_head row's totals gives the rate back by division. So both are for
 * budget WRITERS only (owner / admin / manager: `canWrite`, the role list `withWriteAccess`
 * enforces). A reader (viewer) gets the totals: the grid's cells, every other driver kind whole,
 * and a per_head line with its `amount` key REMOVED (not nulled) and `perHeadRestricted: true`;
 * the headcount route answers no counts at all. Every service that returns driver lines or
 * headcount to a request takes a `PerHeadAccess` (required, so a new caller must choose).
 */
import { canWrite } from '@/lib/auth/writeRoles';
import type { StoredDriverLine } from './driverLine';

/** 'full': per-head rates and headcount (a budget writer). 'totals': line totals only (a reader). */
export type PerHeadAccess = 'full' | 'totals';

export const perHeadAccessOf = (role: string | null | undefined): PerHeadAccess => (canWrite(role) ? 'full' : 'totals');

/** The note a reader sees where per-head detail would be. */
export const PER_HEAD_RESTRICTED_NOTE = 'Per-person detail is limited to budget editors.';

/** A per_head line as a reader receives it: no rate. */
export type RestrictedPerHeadLine = Omit<StoredDriverLine, 'amount' | 'kind'> & { kind: 'per_head'; perHeadRestricted: true };

/** A driver line on the wire: whole, or a per_head line without its rate. */
export type VisibleDriverLine = StoredDriverLine | RestrictedPerHeadLine;

export function isRestrictedPerHead(line: object): line is RestrictedPerHeadLine {
  return 'perHeadRestricted' in line && (line as { perHeadRestricted?: unknown }).perHeadRestricted === true;
}

/** The lines `access` may see: all of them whole, or every per_head line without its `amount`. */
export function visibleDriverLines(lines: readonly StoredDriverLine[], access: PerHeadAccess): VisibleDriverLine[] {
  if (access === 'full') return [...lines];
  return lines.map((line): VisibleDriverLine => {
    if (line.kind !== 'per_head') return line;
    const { amount: _rate, kind: _kind, ...rest } = line;
    return { ...rest, kind: 'per_head', perHeadRestricted: true };
  });
}

/** The headcount route's answer to a reader: the scope asked for, no counts, no payroll read time. */
export interface RestrictedHeadcount {
  costCentreId: string | null;
  perHeadRestricted: true;
}
