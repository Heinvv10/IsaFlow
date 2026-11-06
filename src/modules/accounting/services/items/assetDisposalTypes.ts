/**
 * How an asset left the register — the values `assets.disposal_type` accepts.
 *
 * Mirrors the CHECK on that column (migration 361). The dispose route refuses
 * anything else before its first write, and the asset page offers exactly
 * these, so a choice on the page can never reach the database as a 500.
 * `asset_disposals.disposal_method` records the same value, or `unspecified`
 * when a caller sent no type.
 */
export const DISPOSAL_TYPES = ['sale', 'write_off', 'donation', 'theft', 'loss'] as const;

export type DisposalType = (typeof DISPOSAL_TYPES)[number];

/** Logged in asset_disposals.disposal_method when the request carried no type. */
export const UNSPECIFIED_DISPOSAL_METHOD = 'unspecified';

export const DISPOSAL_TYPE_LABELS: Record<DisposalType, string> = {
  sale: 'Sale',
  write_off: 'Write-off',
  donation: 'Donation',
  theft: 'Theft',
  loss: 'Loss',
};

export function isDisposalType(value: unknown): value is DisposalType {
  return typeof value === 'string' && (DISPOSAL_TYPES as readonly string[]).includes(value);
}
