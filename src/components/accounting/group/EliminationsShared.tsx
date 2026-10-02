/**
 * Eliminations Shared — types, helpers, and style constants.
 */

export const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export const selectClass =
  'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';
export const inputClass = selectClass;

export type EliminationType =
  | 'interco_revenue'
  | 'interco_balance'
  | 'unrealised_profit'
  | 'nci'
  | 'currency_translation'
  | 'goodwill';

export type EliminationStatus = 'draft' | 'posted' | 'reversed';

export interface EliminationLine {
  id?: string;
  groupAccountCode: string;
  groupAccountName?: string;
  debit: number;
  credit: number;
}

export interface EliminationAdjustment {
  id: string;
  number: string;
  type: EliminationType;
  description: string;
  period: string;
  status: EliminationStatus;
  amount: number;
  lines?: EliminationLine[];
}

export const ELIMINATION_TYPE_LABELS: Record<EliminationType, string> = {
  interco_revenue: 'Intercompany Revenue',
  interco_balance: 'Intercompany Balance',
  unrealised_profit: 'Unrealised Profit',
  nci: 'Non-Controlling Interest',
  currency_translation: 'Currency Translation',
  goodwill: 'Goodwill',
};

export const STATUS_STYLES: Record<EliminationStatus, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  posted: 'bg-teal-500/10 text-teal-400',
  reversed: 'bg-amber-500/10 text-amber-400',
};

/**
 * One row of the eliminations table, read from what `consolidated-reports?action=eliminations`
 * returns (consolidatedReportingService `ConsolidationAdjustment`): adjustmentNumber,
 * adjustmentType, periodStart / periodEnd ('YYYY-MM-DD') and lines of { debit, credit }.
 * The table used to read number / type / period / amount, which the API never sends, so those
 * columns rendered blank. Amount is the adjustment's total debit (a balanced entry's size).
 */
export function toEliminationRow(raw: unknown): EliminationAdjustment {
  const r = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const start = text(r.periodStart);
  const end = text(r.periodEnd);
  const lines = Array.isArray(r.lines) ? (r.lines as Array<Record<string, unknown>>) : [];
  const amount = lines.reduce((sum, l) => sum + (Number(l?.debit) || 0), 0);
  return {
    id: text(r.id),
    number: text(r.adjustmentNumber),
    type: text(r.adjustmentType) as EliminationType,
    description: text(r.description),
    period: start && end && start !== end ? `${start} – ${end}` : start || end,
    status: text(r.status) as EliminationStatus,
    amount: Math.round(amount * 100) / 100,
  };
}
