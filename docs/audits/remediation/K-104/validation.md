# K-104 — Two invitation systems write incompatible token encodings

**Claim.** One path stores the raw token and the other sha256(token) into the same column, so half the invitations never validate.

**Disposition: confirmed (corrected trigger).**

**Corrected trigger.** Each system is internally consistent end to end, so neither is broken in isolation. The defect is that both write `company_invitations.token` and `UNIQUE (company_id, email)` forces them to share one row.
- System 1: `pages/api/invitations/index.ts:43,48` stores the raw token, mails `/accept-invite?token=<raw>`, and `pages/api/invitations/[token]/accept.ts:45` compares raw.
- System 2: `src/modules/accounting/services/core/userInvitationService.ts:80,85` stores `sha256(raw)` with `ON CONFLICT (company_id,email) DO UPDATE SET token = EXCLUDED.token`, mails `/invite/<raw>` (`inviteEmailService.ts:21`), and `pages/api/invite/[token].ts:44,55` hashes before lookup.
Re-inviting the same address through the other UI overwrites the outstanding token with the other encoding and silently kills the live link. `pages/login.tsx:262` also sends any `?invite=` token to the hashing route, so a system-1 token never resolves there.

**Evidence.** `git show origin/master:<path>` for each file above; `UNIQUE (company_id, email)` and `UNIQUE (token)` verified in the fixture schema (`\d company_invitations`).

**RED test.** `tests/integration/k104-k105-invitation-token-encoding.int.test.ts` — 1 failed of 2 for this claim. Observed `{storedIsHashOfIssued: true, originalLinkRows: 0, newLinkRows: 1}` against expected `{false, 1, 1}`. Log: `red.log`.

**Reachability.** Both create routes are live and reachable by any owner/admin: `POST /api/invitations` (Users page) and `POST /api/accounting/company-invitations` (`pages/accounting/user-access.tsx:92`).

**Proposed minimal fix (3-6 lines).**
1. Pick sha256 as the single stored encoding (it is the safer one; a raw token in the table is a credential at rest).
2. Change `pages/api/invitations/index.ts` to insert `sha256(token)` and both `pages/api/invitations/[token]/index.ts:17` and `accept.ts:45` to hash before comparing.
3. Update the `invites_by_token` RLS policy to compare the hash of `app.invite_token`, or set the GUC to the hash in `withInviteToken`.
4. Backfill: existing raw tokens cannot be hashed in place without invalidating outstanding links — expire them and require a resend.

**Historical-data impact.** Rows written by system 1 hold a raw 64-hex secret in `company_invitations.token`; anyone with database or backup read access holds a usable invitation link until expiry. Read-only impact query:
```sql
SELECT count(*) FILTER (WHERE length(token)=64 AND accepted_at IS NULL AND expires_at > now())
FROM company_invitations;
```
This cannot distinguish encoding by length alone (both are 64 hex); `gotrue_user_id IS NOT NULL` marks system-1 rows.

**Risks.** Changing the encoding invalidates every outstanding invitation. Coordinate with K-042 (unique-violation on re-invite) — the two share the row-collision root cause but are separate defects.
