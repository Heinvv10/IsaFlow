/**
 * A fixture users.email for a fixture id. users_email_lower_key (migration 999) holds one row per
 * lower(btrim(email)), so suites that seed two ids differing only in letter case (they test
 * case-variant ids, not emails) cannot derive both emails as `${id}@test.local`. An id with no
 * upper-case letter keeps that form; any other id gets the hex of its UTF-8 bytes, which differs
 * from every other id's even after lower-casing.
 */
export function fixtureEmail(id: string, prefix = ''): string {
  return id === id.toLowerCase()
    ? `${prefix}${id}@test.local`
    : `${prefix}${Buffer.from(id, 'utf8').toString('hex')}-cased@test.local`;
}
