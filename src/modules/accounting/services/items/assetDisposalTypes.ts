/**
 * How an asset left the register — the values `assets.disposal_type` accepts.
 *
 * Mirrors the CHECK on that column (migrations 361 and 965). The dispose route refuses
 * anything else before its first write, and the asset page offers exactly
 * these, so a choice on the page can never reach the database as a 500.
 * `asset_disposals.disposal_method` records the same value, or `unspecified`
 * when a caller sent no type.
 */
export const DISPOSAL_TYPES = ['sale', 'scrap', 'write_off', 'donation', 'theft', 'loss', 'insurance_claim'] as const;

export type DisposalType = (typeof DISPOSAL_TYPES)[number];

/** Logged in asset_disposals.disposal_method when the request carried no type. */
export const UNSPECIFIED_DISPOSAL_METHOD = 'unspecified';

export const DISPOSAL_TYPE_LABELS: Record<DisposalType, string> = {
  sale: 'Sale',
  scrap: 'Scrap',
  write_off: 'Write-off',
  donation: 'Donation',
  theft: 'Theft',
  loss: 'Loss',
  insurance_claim: 'Insurance claim',
};

export function isDisposalType(value: unknown): value is DisposalType {
  return typeof value === 'string' && (DISPOSAL_TYPES as readonly string[]).includes(value);
}

/**
 * The assets.status values (CHECK: available/assigned/in_maintenance/disposed/written_off) of an asset still in
 * service: the asset page offers Dispose only for these. It used to test for 'active', which no asset ever has.
 */
export const IN_SERVICE_ASSET_STATUSES = ['available', 'assigned', 'in_maintenance'] as const;

export function isInService(status: string | null | undefined): boolean {
  return (IN_SERVICE_ASSET_STATUSES as readonly string[]).includes(status?.toLowerCase() ?? '');
}
