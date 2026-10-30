/**
 * The driver editor's form state (P4 spec §1.1, §7): text fields as typed, turned into the
 * `DriverLine` the PUT route takes, with a message per field the user must fix first. Pure.
 *
 * Amounts are rand (the SA amount parser, as the grid's cells); percentages carry at most 4
 * decimals within ±99 999.9999 (NUMERIC(9,4)), growth at least −100%; the range lies inside
 * the version's months; a growth base month comes before the range. The server checks all of it
 * again (and what the client cannot: accounts, grain, cycles).
 */
import { parseCell } from '@/modules/accounting/services/budgets/grid/pasteParse';
import { fromCents, type RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { parseKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { MAX_PCT } from '@/modules/accounting/services/budgets/drivers/driverEngine';
import type { DriverKind, RowKey } from '@/modules/accounting/services/budgets/drivers/driverTypes';
import { rowKeyOfGrain, type DriverGrain, type DriverLine, type SectionScope } from '@/modules/accounting/services/budgets/drivers/driverLine';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';

export interface DriverDraft {
  kind: DriverKind;
  fromMonth: string;
  toMonth: string;
  rounding: RoundingUnit;
  /** Rand as typed: fixed per month, per_head per head. */
  amount: string;
  /** Percent as typed: of the reference, or per month (growth). */
  pct: string;
  /** pct_of_line: the row read ('' = none picked). */
  refRowKey: RowKey | '';
  section: Band;
  scope: SectionScope;
  baseMonth: string;
  /** per_head: '' = the company's headcount, else a cost centre id. */
  headcountScope: string;
}

export type DraftField = 'amount' | 'pct' | 'refRowKey' | 'range' | 'baseMonth';
export type DraftCheck = { ok: true; line: DriverLine } | { ok: false; errors: Partial<Record<DraftField, string>> };

export const KIND_LABEL: Readonly<Record<DriverKind, string>> = {
  fixed: 'Fixed amount a month',
  pct_of_line: 'Percent of another line',
  pct_of_section: 'Percent of a section',
  growth: 'Growth from a base month',
  per_head: 'Amount per head',
};

const amountText = (rand: number | null): string => (rand === null ? '' : String(rand));
const pctOf = (n: number | null): string => (n === null ? '' : String(n));

/** The form for `existing`, or a new driver over the whole version (fixed, R1) when there is none. */
export function draftFrom(existing: DriverLine | null, months: readonly string[]): DriverDraft {
  const first = months[0] ?? '';
  const last = months[months.length - 1] ?? '';
  if (!existing) {
    return {
      kind: 'fixed', fromMonth: first, toMonth: last, rounding: 1, amount: '', pct: '', refRowKey: '',
      section: 'turnover', scope: 'same_grain', baseMonth: first, headcountScope: '',
    };
  }
  return {
    kind: existing.kind, fromMonth: existing.fromMonth, toMonth: existing.toMonth, rounding: existing.rounding,
    amount: amountText(existing.amount), pct: pctOf(existing.pct),
    refRowKey: existing.ref ? rowKeyOfGrain(existing.ref) : '',
    section: existing.section ?? 'turnover', scope: existing.scope ?? 'same_grain',
    baseMonth: existing.baseMonth ?? first, headcountScope: existing.headcountCostCentreId ?? '',
  };
}

function parseRand(text: string): { ok: true; rand: number } | { ok: false; reason: string } {
  const cell = parseCell(text);
  if (cell.kind === 'blank') return { ok: false, reason: 'Type an amount' };
  if (cell.kind === 'error') return { ok: false, reason: cell.reason };
  return { ok: true, rand: fromCents(cell.cents) };
}

function parsePct(text: string, kind: DriverKind): { ok: true; pct: number } | { ok: false; reason: string } {
  const t = text.trim().replace(/%$/, '').replace(',', '.').trim();
  if (t === '') return { ok: false, reason: 'Type a percentage' };
  if (!/^[-+]?\d+(\.\d{1,4})?$/.test(t)) return { ok: false, reason: 'A percentage is a number with at most 4 decimals' };
  const pct = Number(t);
  if (Math.abs(pct) > MAX_PCT) return { ok: false, reason: `At most ${MAX_PCT.toLocaleString('en-ZA')}%` };
  if (kind === 'growth' && pct < -100) return { ok: false, reason: 'Growth cannot be below −100% a month' };
  return { ok: true, pct };
}

function grainOfKey(key: RowKey): DriverGrain {
  const { glAccountId, cc1Id, cc2Id, buId } = parseKey(`${key}|2000-01`);
  return { glAccountId, cc1Id, cc2Id, buId };
}

/** The line the draft describes for the row `grain`, or what to fix first. */
export function checkDraft(draft: DriverDraft, grain: DriverGrain, months: readonly string[]): DraftCheck {
  const errors: Partial<Record<DraftField, string>> = {};
  const from = months.indexOf(draft.fromMonth);
  const to = months.indexOf(draft.toMonth);
  if (from < 0 || to < 0) errors.range = 'Pick months inside the version';
  else if (from > to) errors.range = 'The first month comes after the last';
  const line: DriverLine = {
    ...grain, kind: draft.kind, fromMonth: draft.fromMonth, toMonth: draft.toMonth, rounding: draft.rounding,
    amount: null, pct: null, ref: null, section: null, scope: null, baseMonth: null, headcountCostCentreId: null,
  };
  if (draft.kind === 'fixed' || draft.kind === 'per_head') {
    const r = parseRand(draft.amount);
    if (r.ok) line.amount = r.rand; else errors.amount = r.reason;
    if (draft.kind === 'per_head') line.headcountCostCentreId = draft.headcountScope === '' ? null : draft.headcountScope;
  } else {
    const p = parsePct(draft.pct, draft.kind);
    if (p.ok) line.pct = p.pct; else errors.pct = p.reason;
  }
  if (draft.kind === 'pct_of_line') {
    if (draft.refRowKey === '') errors.refRowKey = 'Pick the line to take a percentage of';
    else if (draft.refRowKey === rowKeyOfGrain(grain)) errors.refRowKey = 'A line cannot be a percentage of itself';
    else line.ref = grainOfKey(draft.refRowKey);
  }
  if (draft.kind === 'pct_of_section') { line.section = draft.section; line.scope = draft.scope; }
  if (draft.kind === 'growth') {
    const base = months.indexOf(draft.baseMonth);
    if (base < 0 || (from >= 0 && base >= from)) errors.baseMonth = 'The base month comes before the first driven month';
    else line.baseMonth = draft.baseMonth;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, line };
}
