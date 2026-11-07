/**
 * isInService: the assets.status values of an asset still on the register (the CHECK allows available, assigned,
 * in_maintenance, disposed, written_off). The asset page, the FAR report badge, the dispose route and the
 * depreciation run all read this one list.
 */
import { describe, expect, it } from 'vitest';
import { IN_SERVICE_ASSET_STATUSES, isInService } from '@/modules/accounting/services/items/assetDisposalTypes';
import { IN_SERVICE_STATUSES } from '@/modules/accounting/services/items/depreciationRunPlan';

describe('isInService', () => {
  it.each(['available', 'assigned', 'in_maintenance', 'AVAILABLE'])('%s is in service', (s) => {
    expect(isInService(s)).toBe(true);
  });
  it.each(['disposed', 'written_off', 'active', '', null, undefined])('%s is not', (s) => {
    expect(isInService(s)).toBe(false);
  });
  it('the depreciation run uses the same list', () => {
    expect(IN_SERVICE_STATUSES).toBe(IN_SERVICE_ASSET_STATUSES);
  });
});
