/**
 * The asset / fleet LINK a bank line carries (mig 853), as the screens show it. A link is an annotation only: it
 * never changes the line's status, journal link or reconciliation stamp (Hein, 2026-10-05).
 *
 * Read from the `link_*` columns TX_SELECT joins (bankTxQueryFragments). A row read without them (a mutation's
 * RETURNING) still carries the link id; its label then falls back to the kind's name.
 */
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import type { BankTxLink, BankTxLinkKind } from '../../types/bank.types';

export type { BankTxLink, BankTxLinkKind };

const FALLBACK: Record<BankTxLinkKind, string> = { asset: 'Asset', fuel: 'Fuel record', service: 'Service record' };

export function fuelLabel(fillDate: unknown, amount: unknown): string {
  return `Fuel ${fmtDate(fillDate)} R${Number(amount).toFixed(2)}`;
}

export function bankTxLinkOf(row: DbRow): BankTxLink | undefined {
  const kind: BankTxLinkKind | null = row.linked_asset_id ? 'asset'
    : row.linked_fleet_fuel_id ? 'fuel'
      : row.linked_fleet_service_id ? 'service' : null;
  if (!kind) return undefined;
  const id = String(kind === 'asset' ? row.linked_asset_id : kind === 'fuel' ? row.linked_fleet_fuel_id : row.linked_fleet_service_id);
  const assetName = row.link_asset_name ? String(row.link_asset_name) : undefined;
  let label: string | undefined;
  if (kind === 'asset') label = assetName;
  else if (kind === 'fuel' && row.link_fill_date) label = fuelLabel(row.link_fill_date, row.link_fuel_amount);
  else if (kind === 'service' && row.link_service_description) label = String(row.link_service_description);
  return {
    kind, id,
    ...(row.link_asset_id ? { assetId: String(row.link_asset_id) } : {}),
    ...(assetName ? { assetName } : {}),
    label: label ?? FALLBACK[kind],
  };
}
