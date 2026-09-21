# K-001 — pending MFA credential acceptance

## Current-code validation (baseline 5661d6f0)

Read each committed file with `git show 5661d6f0:<path>`.

- `pages/api/auth/login.ts`: GoTrue password sign-in returns an access token; when `listFactors` reports a verified TOTP factor, the route puts that unchanged token in `sb-pending-mfa` and returns `requires_2fa`.
- `src/lib/auth/gotrue.ts:52`: `verifyToken` verifies HS256 signature and string `sub` only. It does not establish whether an enrolled factor has been satisfied.
- `src/lib/auth/withAuth.ts:60`: accepts the same token if supplied as `sb-access-token`, then verifies company membership/account standing and invokes the protected handler. These checks do not establish MFA completion.
- `src/lib/auth/withUserAuth.ts:28` and `withPlatformAdmin.ts:45` also accept this token verifier as completed authentication.
- `pages/api/auth/2fa-challenge.ts:53` legitimately uses a pending token; the correction must preserve this pre-authentication stage.
- Direct token callers include `2fa-enroll.ts`, `end-impersonation.ts`, `pages/oauth/authorize.tsx`, and App Router helper. Audit their contracts before final implementation scope.

Reachability is supported by committed data flow, but a deterministic failing test is still required. Cookie name withholding alone cannot defend against an HTTP client which supplies the same valid token under the access-cookie name. AAL1 alone is not grounds for rejection: users with no verified factors must still sign in and enroll MFA.

## Required reproduction and regression matrix

1. Use actual JOSE signatures and actual auth middleware, with a deterministic enrollment fixture; assert a signed AAL1 password token belonging to a verified-factor user cannot invoke the protected handler when transplanted into the access cookie. Record the failing assertion before any behavior changes.
2. AAL1 without verified factors remains accepted; unverified enrollment does not lock out setup.
3. AAL2 token after valid TOTP challenge reaches the protected route.
4. Expired/wrong-signature tokens denied; wrong company and suspended user denial remain intact.
5. Enrollment lookup failure must not grant access. Decide and test truthful 401/503 behavior.
6. Pending challenge remains usable, but pending credentials cannot authorize profile, platform-admin, OAuth authorization or direct enrollment mutation.
7. Existing restricted print-token workflow remains bound to its company/path/method; no MFA fallback bypass.
8. Verify the real password → pending → failed bypass → TOTP challenge → authorized workflow against disposable GoTrue where available. Provider mocks prove only the application contract.

## Correction design pending reproduction

Separate cryptographic token validation (needed for the pending challenge) from completed-session authorization, or add an explicit restricted pre-authentication option. All normal auth entry points must establish required assurance from authoritative verified-factor state; avoid assuming all legitimate sessions are AAL2 or trusting client-declared factor flags. Investigate existing impersonation and token fixtures before choosing the final API. Do not simply reject every AAL1 JWT.

## Schema, historical impact and rollback

No accounting writes or historical ledger repair expected. Existing password-only tokens for MFA users must cease authorizing protected workflows. No destructive session or user cleanup is authorized. Prefer a code-only correction with a revertable focused commit; if new storage is required, revise this plan and add migration tests before implementation.

## Completion gates still open

Failing test, correction, regressions, disposable provider workflow, named-fix review, full CI, commit and draft PR. Full fresh database replay currently fails at migration 220; see ../evidence/baseline-summary.md. This plan does not close K-001.

## Selected implementation after failing reproduction

The two-case regression ran on unchanged application code: enrolled AAL1 transplant returned 200 instead of required 401; no-MFA control passed. See red.log.

Keep `verifyToken` as the secure default for every existing completed-auth caller. Extract signature-only validation into explicitly named `verifyTokenSignature`, used only by the pending challenge route and internally by the completed-session verifier. For a non-AAL2 token, fetch authoritative GoTrue `/user` factor state and deny if any factor is verified; validate the returned identity and factor shape. AAL2 remains accepted after signature verification. GoTrue lookup errors deny access through existing INVALID_TOKEN handling (401), with no cached permissive result. This introduces an online GoTrue dependency for non-MFA sessions; record and verify that availability tradeoff. No schema change. Existing synthetic JWT fixtures representing completed sessions must explicitly carry AAL2; dedicated AAL1 tests cover permitted no-factor and denied verified-factor flows.

Exact behavior files: src/lib/auth/gotrue.ts and pages/api/auth/2fa-challenge.ts. Tests: pending-mfa-access.test.ts, assurance-specific GoTrue tests, relevant existing auth/print/caller suites. Follow-up tests must cover phone factors, malformed/mismatched provider identity, provider failure, AAL2, and pending challenge semantics. Do not move to K-002 before K-001's remaining gates are accounted for.

Caller-review correction: end-impersonation is also a restricted identity-only recovery caller. Its new regression showed the initial gate stranded an admin on an MFA target (401 instead of 200). Preserve raw signature + existing stash ownership validation there; it only restores the stashed admin session, whose subsequent requests remain MFA-gated. The unrelated-user ownership negative case must remain 403. Behavior scope now includes pages/api/auth/end-impersonation.ts.

## Final code verification

The historical open gates above are superseded by delegation-result.md and final-push-ci.log: regression, real provider/current-schema workflow, named commit review, full CI and draft PR345 are complete. Pristine historical migration replay and deployment remain separate open requirements.
