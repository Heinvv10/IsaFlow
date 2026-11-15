/**
 * Timing of an admin invoice Send (migration 993's claim), shared by the server and the admin page. Pure: no
 * database, no mail, so the page can import it.
 */

/**
 * connection / greeting / socket INACTIVITY timeouts, ms. Not a ceiling on a send: socketTimeout restarts on every
 * reply, and a send is about ten round trips, so a slow server can stretch one far past their sum.
 */
export const SMTP_TIMEOUTS_MS = { connection: 15_000, greeting: 15_000, socket: 20_000 } as const;

/**
 * The hard ceiling on one Send's SMTP conversation, ms. Past it sendEmail closes the transport and reports the
 * outcome as unknown (the server may already have accepted the message), so the claim stays.
 */
export const SEND_DEADLINE_MS = 45_000;

/**
 * How old a claim must be before an admin may settle it (mark sent / release). It must exceed, with wide margin,
 * everything a Send can still be doing while it holds the claim: the hard deadline (SEND_DEADLINE_MS, 45 s) plus
 * the claim and finalise transactions (lock_timeout 5 s each). Settling a claim younger than that could mark sent
 * an email the customer never got, or release it into a duplicate send. 10 minutes.
 */
export const SEND_SETTLE_AFTER_MS = 10 * 60_000;

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
