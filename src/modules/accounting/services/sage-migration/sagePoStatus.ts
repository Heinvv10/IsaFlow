/**
 * Sage PO status -> the status word bulk_create_purchase_orders takes (design note, Phase B): Pending and Overdue are open
 * (approved), Invoiced is closed (the imported POs have no linked IsaFlow bill), Cancelled is cancelled. Case-insensitive.
 * Any other status is refused (`unknown_status`): it is not guessed.
 */
export type ImportStatusWord = 'open' | 'billed' | 'cancelled';

const TABLE: Readonly<Record<string, ImportStatusWord>> = {
  pending: 'open',
  overdue: 'open',
  invoiced: 'billed',
  cancelled: 'cancelled',
};

export function importStatusFor(sageStatus: string): ImportStatusWord | null {
  const key = sageStatus.trim().toLowerCase();
  return Object.hasOwn(TABLE, key) ? TABLE[key]! : null;
}
