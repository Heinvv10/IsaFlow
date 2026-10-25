/**
 * A scan's release frees only its own claim. A scan-now's release can come late (after the
 * backstop freed the claim and a cron tick claimed the same connection); it must not free
 * the cron's claim, or a third scan could overlap it.
 */
import { describe, expect, it } from 'vitest';
import { claimScan, isScanActive } from '@/modules/accounting/services/capture/mirrorScanActive';

const ID = '0b9d1c1e-3f7a-4c56-9a1e-2f3b4c5d6e7f';

describe('claimScan', () => {
  it('refuses a second claim while the first holds the connection', () => {
    const release = claimScan(ID)!;
    expect(claimScan(ID)).toBeNull();
    release();
    expect(isScanActive(ID)).toBe(false);
  });

  it('a late release of an earlier claim leaves the later claim in place', () => {
    const first = claimScan(ID)!;
    first(); // the backstop frees it
    const second = claimScan(ID)!;
    first(); // the scan-now's own release arrives late
    expect(isScanActive(ID)).toBe(true);
    expect(claimScan(ID)).toBeNull();
    second();
    expect(isScanActive(ID)).toBe(false);
  });
});
