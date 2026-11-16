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

/**
 * The address a POPIA erasure leaves on `userId`'s profile: lower-case, and distinct for every id even
 * once lower-cased, which users_email_lower_key requires (two ids that differ only in case must not
 * collide). An id with no upper-case letter keeps the plain form `anonymized_<id>@deleted.invalid`
 * (every GoTrue id); any other id is the hex of its UTF-8 bytes with an `_h` suffix, which no plain
 * form can end with (a plain id ending `_h` is hex-encoded too).
 */
export function erasedUserEmail(userId: string): string {
  const plain = userId === userId.toLowerCase() && !userId.endsWith('_h');
  return `anonymized_${plain ? userId : `${Buffer.from(userId, 'utf8').toString('hex')}_h`}@deleted.invalid`;
}
