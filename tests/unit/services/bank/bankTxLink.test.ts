/**
 * bankTxLinkOf — the link a bank line carries, as the screens label it (mig 853).
 */
import { describe, expect, it } from 'vitest';
import { bankTxLinkOf } from '@/modules/accounting/services/bank/bankTxLink';

const A = '00000000-0000-4000-8000-00000000000a';
const F = '00000000-0000-4000-8000-00000000000f';
const S = '00000000-0000-4000-8000-000000000005';

describe('bankTxLinkOf', () => {
  it('no link -> undefined', () => {
    expect(bankTxLinkOf({ linked_asset_id: null, linked_fleet_fuel_id: null, linked_fleet_service_id: null })).toBeUndefined();
  });

  it('asset -> the asset name', () => {
    expect(bankTxLinkOf({ linked_asset_id: A, link_asset_id: A, link_asset_name: 'Hilux' }))
      .toEqual({ kind: 'asset', id: A, assetId: A, assetName: 'Hilux', label: 'Hilux' });
  });

  it('fuel -> "Fuel <date> R<amount to 2 dp>", from a DATE string or a Date', () => {
    expect(bankTxLinkOf({ linked_fleet_fuel_id: F, link_asset_id: A, link_asset_name: 'Hilux',
      link_fill_date: '2026-10-01', link_fuel_amount: '850' }))
      .toEqual({ kind: 'fuel', id: F, assetId: A, assetName: 'Hilux', label: 'Fuel 2026-10-01 R850.00' });
    expect(bankTxLinkOf({ linked_fleet_fuel_id: F, link_fill_date: new Date(2026, 9, 1), link_fuel_amount: 1234.5 })!.label)
      .toBe('Fuel 2026-10-01 R1234.50');
  });

  it('service -> the description', () => {
    expect(bankTxLinkOf({ linked_fleet_service_id: S, link_asset_id: A, link_asset_name: 'Hilux', link_service_description: 'Brakes' }))
      .toEqual({ kind: 'service', id: S, assetId: A, assetName: 'Hilux', label: 'Brakes' });
  });

  it('a row read without the label joins still says what it is linked to', () => {
    expect(bankTxLinkOf({ linked_fleet_service_id: S })).toEqual({ kind: 'service', id: S, label: 'Service record' });
    expect(bankTxLinkOf({ linked_asset_id: A })).toEqual({ kind: 'asset', id: A, label: 'Asset' });
  });
});
