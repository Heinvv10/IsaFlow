# K-104 fix — one stored encoding for company_invitations.token

**Trigger.** `POST /api/invitations` stored the RAW 64-hex token; `userInvitationService.createInvitation`
stored `sha256(token)` into the same column. `UNIQUE (company_id, email)` forces both onto one row, so a
re-invite through either UI replaced the outstanding token with an encoding the other side could not match.
The link kept looking live in the Users list and silently resolved to nothing.

**Before.** Encoding depended on which route wrote last; a system-1 token also sat at rest in the table as a
usable invitation credential, and `pages/login.tsx:262` sent any `?invite=` token to the hashing route, so a
system-1 token never resolved there at all.
**After.** sha256 is the single stored encoding. `src/lib/auth/inviteToken.ts` holds the one hash function;
`POST /api/invitations` hashes before INSERT, `withInviteToken` sets `app.invite_token` to the digest (that
GUC is compared to the stored column by the `invites_by_token` RLS policy), and both token routes compare the
digest. The mailed link still carries the raw token; the table only ever holds its digest.

**Files.** `src/lib/auth/inviteToken.ts` (new), `pages/api/invitations/index.ts`,
`pages/api/invitations/[token]/index.ts`, `pages/api/invitations/[token]/accept.ts`,
`src/lib/auth/withInviteToken.ts`, `scripts/migrations/sql/643_invite_token_encoding_and_companies_read.sql`.

**Tests.** `tests/integration/k104-k105-invitation-token-encoding.int.test.ts` — 4 tests, real PostgreSQL.
The K-104 test invites the SAME address through both systems onto the same row and asserts the digest is
stored, the raw token is not, and the link system 2 issued resolves through system 1's lookup. Adjacent
cases: expired token, accepted token, unknown token, cross-tenant company read. Whole invitation suite
(k-041, k-042, k104-k105, k106) 15 passed. Mutation: storing the raw token again fails the K-104 test;
setting the GUC to the raw token fails 5 tests across 2 files (green.log M1, M2).

**Migration / rollback.** `643_invite_token_encoding_and_companies_read.sql` expires the outstanding
invitations that still hold a raw token (`gotrue_user_id IS NOT NULL AND accepted_at IS NULL AND expires_at >
now()`) — they can never match again, so they are retired with an `email_error` telling the operator to
resend. Deliberately cross-tenant: it retires a platform-wide encoding change, not one company's data.
Rollback: revert the code; the expired rows stay expired and must be resent either way.

**Historical impact.** Every invitation POSTed through system 1 holds a raw invitation secret at rest;
anyone with database or backup read access holds a usable link until expiry. Read-only, for the operator
(NOT run here — production is out of scope):
```sql
SELECT company_id, count(*) FROM company_invitations
WHERE gotrue_user_id IS NOT NULL AND accepted_at IS NULL AND expires_at > now()
GROUP BY company_id;
```

**Limits.** Outstanding system-1 links are invalidated by design; those invitees must be re-invited. Raw
tokens already sitting in database backups cannot be scrubbed by a migration.
