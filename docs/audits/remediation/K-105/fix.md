# K-105 — false positive, no code change for the claim as written

**Claim.** The public invitation lookup returns the full email and ignores expiry/prior acceptance.

**Disposition: false positive on both halves** (see `validation.md` for the disconfirming evidence).
Expiry and prior acceptance are enforced by the `invites_by_token` RLS policy
(`scripts/migrations/sql/348_rls_and_auth_helpers.sql:154-159`), not by the handler, and `app_user` has
neither `rolsuper` nor `rolbypassrls`. No email could leak because the route never returned 200 at all.

**What was actually wrong.** The join onto `companies` dropped every row under forced RLS, so every valid
invitation answered 410 and the whole `/accept-invite` flow was dead. That is a separate, larger defect and
is fixed as **R-030** — see `docs/audits/remediation/R-030/fix.md`.

**Defence in depth done anyway.** `pages/api/invitations/[token]/index.ts` now masks the address the same
way `pages/api/invite/[token].ts:29-33` already does. Anyone holding the link can read this response, and
the invitee already knows their own address. Covered by the R-030 test; mutation M3 in `green.log` removes
the masking and the test fails.

**Migration / rollback.** None for this item.
**Historical impact.** None. No stored data was wrong on account of this claim.
