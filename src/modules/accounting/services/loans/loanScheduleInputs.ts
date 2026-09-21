/**
 * Pure row -> engine-input mappers and the cached-run key.
 * Split out of loanScheduleService.ts, which was at the 300-line cap.
 * No DB access here: every function is a pure function of its arguments.
 */
import crypto from 'crypto';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import type { LoanInputs, LoanEvent, RatePoint, ScheduleRow } from '@/lib/amortisation/types';

type Row = DbRow;

// Part of the cached-run key: bump on ANY behavioural change to the amortisation engine.
export const ENGINE_VERSION = '1.0.0';

export function mapDbRowToSchedule(r: Row): ScheduleRow {
  return {
    period: Number(r.period),
    date: fmtDate(r.date),
    opening: parseFloat(String(r.opening ?? '0')),
    rate: parseFloat(String(r.rate ?? '0')),
    installment: parseFloat(String(r.installment ?? '0')),
    interest: parseFloat(String(r.interest ?? '0')),
    principal: parseFloat(String(r.principal ?? '0')),
    intPortion: parseFloat(String(r.interest ?? '0')),
    skip: Boolean(r.skip_flag),
    payment: parseFloat(String(r.payment ?? '0')),
    lump: parseFloat(String(r.lump ?? '0')),
    closing: parseFloat(String(r.closing ?? '0')),
    stLiability: parseFloat(String(r.st_liability ?? '0')),
    extrapolated: Boolean(r.extrapolated),
    nca_flagged: Boolean(r.nca_flagged),
  };
}

export function loanRowToInputs(row: Row): LoanInputs {
  return {
    id: String(row.id),
    principal: parseFloat(String(row.principal)),
    startDate: fmtDate(row.start_date),
    termMonths: Number(row.term_months),
    rateMode: String(row.rate_mode) as LoanInputs['rateMode'],
    margin: parseFloat(String(row.margin ?? '0')),
    fixedRate: row.fixed_rate != null ? parseFloat(String(row.fixed_rate)) : undefined,
    residual: parseFloat(String(row.residual ?? '0')),
    recurringSkipMonths: Array.isArray(row.recurring_skip_months)
      ? (row.recurring_skip_months as number[])
      : [],
    dayCount: String(row.day_count) as LoanInputs['dayCount'],
    repriceMode: String(row.reprice_mode) as LoanInputs['repriceMode'],
    skipMode: String(row.skip_mode) as LoanInputs['skipMode'],
    lumpMode: String(row.lump_mode) as LoanInputs['lumpMode'],
  };
}

export function dbEventToEngine(r: Row): LoanEvent {
  return {
    kind: String(r.kind) as LoanEvent['kind'],
    date: fmtDate(r.event_date),
    amount: r.amount != null ? parseFloat(String(r.amount)) : undefined,
    note: r.note != null ? String(r.note) : undefined,
  };
}

export function dbPointToEngine(r: Row): RatePoint {
  return {
    effectiveDate: fmtDate(r.effective_date),
    rate: parseFloat(String(r.rate)),
  };
}

// Cache key over every engine input, sorted as the compute path sorts. Exported for tests.
export function buildInputsHash(loan: Row, events: Row[], points: Row[]): string {
  const payload = JSON.stringify({
    engine: ENGINE_VERSION,
    loan: loanRowToInputs(loan),
    events: events.map(dbEventToEngine).sort((a, b) => a.date.localeCompare(b.date)),
    points: points.map(dbPointToEngine).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

