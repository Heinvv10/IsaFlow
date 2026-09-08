# Named fix review — OPEN

Reviewed candidate `11cb46aa` against `ccf22ee4`. Independent review found one material workflow regression:

The impersonation-start endpoint still installs a magic-link AAL1 target token. For an MFA-enrolled target, a normal protected GET now rejects and clears access/refresh cookies. The end-impersonation signature-only recovery path cannot recover after that intervening GET because it requires an access cookie. The initial exit regression only tested return before the GET. Do not claim K-001 complete or publish this candidate as ready.

Required next reproduction: authorized admin start → protected target GET → return to admin, applying emitted cookies between each request, plus wrong-stash/target/session/actor and expired proof negatives. Preserve the completed-session MFA gate. Preserve legitimate admin impersonation instead of silently disabling MFA-target impersonation as an easier alternative.

Proposed design under independent review: a separate server-signed short-lived HttpOnly delegation cookie issued by the authorized admin start flow, cryptographically bound to actor user, target user and the GoTrue target session_id. Use a purpose-derived signing key, explicit issuer/audience, no `sub` in the envelope, and expiry bounded by the original admin session and stash lifetime. Completed-session callers may accept this proof only for the exact target session; never relabel the target as AAL2. Missing/forged/mismatched/expired proof preserves normal MFA denial. Clear on return. Verify refresh retains session binding. No schema changes proposed. This design is not implemented or accepted yet.

Verification already obtained: failing original login/middleware reproduction (200 instead of 401), initial green reproduction, 336 auth regressions, actual disposable GoTrue no-factor → enrollment → denied password token → completed TOTP session. Full broad CI passed in an interim working tree, but code changed during the run; it is not a final named-commit gate. The foundation push hook is running CI on the now-stable candidate source; capture its completion separately. Full schema/RLS acceptance remains open at migration 220.
