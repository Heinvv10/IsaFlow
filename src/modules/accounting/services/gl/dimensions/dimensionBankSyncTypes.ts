/**
 * Shapes, the one pure helper and the typed refusal of the bank-row dimension
 * sync (dimensionBankSync.ts), split out for the 300-line cap.
 */

/** Hard cap on bank rows one sync run may change; over it the caller narrows the date window. */
export const MAX_BANK_SYNC_ROWS = 2000;

export interface BankSyncScope {
  /** The tag batch whose journals to sync (write-through). */
  tagBatchId?: string;
  /** Inclusive YYYY-MM-DD window on bank transaction_date (back-fill). */
  dateFrom?: string;
  dateTo?: string;
}

export interface BankDimensionValues { cc1Id: string | null; cc2Id: string | null; buId: string | null }

export type DimensionSlotName = 'cc1' | 'cc2' | 'bu';

export interface BankSyncCandidate {
  bankTransactionId: string;
  transactionDate: string;
  amount: number;
  description: string;
  old: BankDimensionValues;
  next: BankDimensionValues;
  /** Slots that hold a value now and would become NULL: the journal does not carry them (mirror semantics). */
  blanks: DimensionSlotName[];
}

/** The slots `old` fills and `next` empties. */
export function blankedSlots(old: BankDimensionValues, next: BankDimensionValues): DimensionSlotName[] {
  const out: DimensionSlotName[] = [];
  if (old.cc1Id !== null && next.cc1Id === null) out.push('cc1');
  if (old.cc2Id !== null && next.cc2Id === null) out.push('cc2');
  if (old.buId !== null && next.buId === null) out.push('bu');
  return out;
}

/**
 * The sync refused, or found a bank row changed under it. Message text is the
 * caller's remedy and names no id but the caller's own; MCP surfaces it verbatim
 * (REFUSAL_CODES). Thrown past the first write when a row changed, so the
 * registry's savepoint rolls the whole batch back.
 */
export class BankDimensionSyncRefusal extends Error {
  readonly code = 'BANK_DIMENSION_SYNC_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'BankDimensionSyncRefusal';
  }
}
