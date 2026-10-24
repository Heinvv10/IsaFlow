/**
 * Whether an IMAP mirror ingest failed for want of the database rather than
 * because of the message: a privilege refusal (42501, e.g. old code against a
 * newer schema, S-07d), a lock wait past lock_timeout (55P03), a connection or
 * resource failure (classes 08, 53, 57), or a pool checkout timeout. The scan
 * stops at such a message and leaves its cursor before it, so the next scan
 * retries it; a message that fails for its own reasons is logged and passed,
 * as before, so it cannot block the mailbox.
 */
export function isTransientIngestError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && (code === '42501' || code === '55P03' || /^(08|53|57)/.test(code))) return true;
  return err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message);
}
