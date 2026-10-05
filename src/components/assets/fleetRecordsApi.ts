/**
 * Client calls for an asset's fleet records and bank links (mig 853) — shared by the asset page's Fuel / Service
 * tabs and the bank transaction link picker. Every call throws on a non-2xx with the server's message
 * (`apiJson`); callers show it through `apiErrorMessage`.
 */
import { apiJson } from '@/lib/apiFetch';
import type { FuelRecord, ServiceRecord } from '@/modules/accounting/services/items/fleetRecordsService';
import type { AssetBankLine } from '@/modules/accounting/services/items/assetBankLinksService';

export type { FuelRecord, ServiceRecord, AssetBankLine };
export type FleetKind = 'fuel' | 'service';
export type FleetRecord = FuelRecord | ServiceRecord;

const KIND_WORD: Record<FleetKind, string> = { fuel: 'fuel', service: 'service' };

export async function loadFuelRecords(assetId: string): Promise<FuelRecord[]> {
  const data = await apiJson(`/api/accounting/assets/${encodeURIComponent(assetId)}/fuel`, undefined,
    'Could not load the fuel records - try again');
  if (!Array.isArray(data)) throw new Error('Unexpected fuel record list');
  return data;
}

export async function loadServiceRecords(assetId: string): Promise<ServiceRecord[]> {
  const data = await apiJson(`/api/accounting/assets/${encodeURIComponent(assetId)}/service`, undefined,
    'Could not load the service records - try again');
  if (!Array.isArray(data)) throw new Error('Unexpected service record list');
  return data;
}

export async function addFleetRecord(assetId: string, kind: FleetKind, body: Record<string, unknown>): Promise<void> {
  await apiJson(`/api/accounting/assets/${encodeURIComponent(assetId)}/${kind}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, `Could not add the ${KIND_WORD[kind]} record - try again`);
}

export async function deleteFleetRecord(assetId: string, kind: FleetKind, id: string): Promise<void> {
  await apiJson(`/api/accounting/assets/${encodeURIComponent(assetId)}/${kind}?id=${encodeURIComponent(id)}`,
    { method: 'DELETE' }, `Could not delete the ${KIND_WORD[kind]} record - try again`);
}

export async function loadAssetBankLinks(assetId: string): Promise<AssetBankLine[]> {
  return apiJson(`/api/accounting/assets/${encodeURIComponent(assetId)}/bank-links`, undefined,
    'Could not load the linked bank transactions - try again');
}
