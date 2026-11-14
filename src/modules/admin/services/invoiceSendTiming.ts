/**
 * Timing of an admin invoice Send (migration 991's claim), shared by the server and the admin page. Pure: no
 * database, no mail, so the page can import it.
 */

/** connection / greeting / socket inactivity, ms: an admin is waiting on the answer. Ceiling 15 + 15 + 20 = 50 s. */
export const SMTP_TIMEOUTS_MS = { connection: 15_000, greeting: 15_000, socket: 20_000 } as const;

/**
 * How old a claim must be before an admin may settle it (mark sent / release). It must stay ABOVE the SMTP
 * ceiling (SMTP_TIMEOUTS_MS: 15 + 15 + 20 = 50 s) plus the claim and finalise transactions (lock_timeout 5 s
 * each): a claim younger than this may belong to a Send still talking to the mail server, and settling it then
 * would mark sent an email the customer never got, or release it into a duplicate send. 2 minutes.
 */
export const SEND_SETTLE_AFTER_MS = 2 * 60_000;

/** True once the claim is old enough to settle (see SEND_SETTLE_AFTER_MS). */
export function isClaimSettleable(claimedAt: string | Date, nowMs: number = Date.now()): boolean {
  const at = claimedAt instanceof Date ? claimedAt.getTime() : Date.parse(claimedAt);
  return Number.isFinite(at) && nowMs - at >= SEND_SETTLE_AFTER_MS;
}

/** "under a minute", "1 minute", "12 minutes", "3 hours", "2 days": how long ago the claim was taken. */
export function claimAgeText(claimedAt: string | Date, nowMs: number = Date.now()): string {
  const at = claimedAt instanceof Date ? claimedAt.getTime() : Date.parse(claimedAt);
  const minutes = Math.floor(Math.max(0, nowMs - at) / 60_000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (!Number.isFinite(minutes) || minutes < 1) return 'under a minute';
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}
