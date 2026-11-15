/**
 * users.email is unique twice over: users_email_key (exact text) and, since migration 999,
 * users_email_lower_key (lower(btrim(email))), so `X@y` and `x@y` cannot be two profiles.
 * A 23505 on either means another profile holds the address. Matched by constraint name, never
 * every 23505: a unique violation on any other key is a different fault and must surface.
 *
 * Writers store lower(btrim(email)); rows written before 999 keep the case they had.
 */
const USERS_EMAIL_UNIQUE: ReadonlySet<string> = new Set(['users_email_key', 'users_email_lower_key']);

/** True when `err` is a unique violation on one of users.email's two keys. */
export function isUsersEmailTaken(err: unknown): boolean {
  const pgErr = err as { code?: string; constraint?: string } | null | undefined;
  return pgErr?.code === '23505' && USERS_EMAIL_UNIQUE.has(pgErr.constraint ?? '');
}
