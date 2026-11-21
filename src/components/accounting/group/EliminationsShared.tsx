/**
 * Eliminations Shared — types, helpers, and style constants.
 */

import { formatMoney } from '@/lib/money/formatMoney';

export const fmt = (n: number) => formatMoney(n);

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
  /** Derived from the ledgers at read time (mirrored intercompany documents): nothing to post or reverse. */
  automatic?: boolean;
  /** A draft or posted adjustment whose row now matches a live mirrored sale: the mirrored document it may be eliminating a second time. */
  mirroredDuplicateOf?: string;
  /** Whether that mirror is eliminated automatically (its pair stands at its later document date and today); drafts and posted rows. */
  mirrorStands?: boolean;
  /** How many listed adjustments point at the same mirror (more than one: at most one of them can be its duplicate). */
  mirrorShared?: number;
  /** Why it was made by hand (required on or after a mirroring cutover). */
  manualReason?: string;
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
    automatic: r.automatic === true,
    mirroredDuplicateOf: typeof r.mirroredDuplicateOf === 'string' && r.mirroredDuplicateOf ? r.mirroredDuplicateOf : undefined,
    mirrorStands: r.mirrorStands === true,
    mirrorShared: typeof r.mirrorShared === 'number' ? r.mirrorShared : undefined,
    manualReason: typeof r.manualReason === 'string' && r.manualReason ? r.manualReason : undefined,
  };
}
