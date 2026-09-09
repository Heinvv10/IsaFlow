# R-030 — the GoTrue accept-invite flow is dead: the lookup joins a table RLS hides

**Raised by.** Validation of K-105, which was a false positive; this is the larger defect found in its
place. See `docs/audits/remediation/K-105/validation.md` for the full disconfirming evidence.

**Disposition: confirmed.**

**Trigger.** `pages/api/invitations/[token]/index.ts:14-16` joins `companies c ON c.id = ci.company_id`.
`companies` has FORCE ROW LEVEL SECURITY and one read policy, `companies_member_read`
(`id IN auth.user_companies()`). `withInviteToken` opens an anonymous `app_user` session with no JWT, so
that set is empty, the join drops every row, and the handler answers 410 "Invitation not found, expired, or
already accepted" for a perfectly valid invitation. `pages/accept-invite.tsx:19` calls this before it can
accept, so no invitation mailed by `POST /api/invitations` could ever be accepted.

**Evidence.** Direct probe on the fixture, production schema:
```
SET LOCAL ROLE app_user; SELECT set_config('app.invite_token', <token>, true);
company_invitations alone -> 1 row
JOIN companies            -> 0 rows
```
`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='app_user'` -> `f, f`.

**RED test.** `tests/integration/k104-k105-invitation-token-encoding.int.test.ts`, the three R-030 tests.
Observed `{freshStatus: 410, ...}` against expected `freshStatus: 200`. Log: `red.log`.

**Reachability.** Every invitation created through `POST /api/invitations`, for every tenant.

**Severity.** High. Higher than the K-105 claim it replaces: a whole user-onboarding path is unusable.
