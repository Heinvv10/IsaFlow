# K-001 delegation regression correction

The start → protected GET → return reproduction failed with HTTP 401 after the initial MFA correction. `delegation-workflow-red.log` preserves that result. The correction retains authorized administrator impersonation using a distinct signed delegation envelope; target claims retain their original AAL1. The envelope has no `sub`, uses a purpose-derived key and fixed issuer/audience/version, and binds actor, target and GoTrue session ID. Expiry cannot exceed actor JWT expiry, persisted stash expiry or one hour.

Issuance occurs after platform-admin authorization, target validation, stash creation and successful audit write. Actor/target/stash identities are cross-checked before cookie emission; failed proof setup cleans the stash and emits no replacement session. Normal session replacement and logout clear proof; refresh retains it, subject to the signed session/expiry binding. All existing completed-session verification callers pass the proof cookie. Pending MFA challenge and owned impersonation recovery remain narrow signature-only callers.

## Verification obtained

- `delegation-helper-green.log`: 16 proof tests including mismatched target/session, malformed issuance, bounded expiry, wrong key, tampering, signed wrong issuer/audience/version and expired proof.
- `delegation-workflow-expanded.log`: seven real-handler workflow tests with mocked database/provider boundaries: start → GET → refresh → GET → return; pending password token without proof; proof replay across session/user; missing session ID; stash/audit failure.
- `delegation-full-unit.log`: 9303 unit tests passed, 234 skipped; 781 files passed, 36 skipped.
- `delegation-provider.log`: real disposable GoTrue verifies enrollment, AAL1 refusal, signed delegation preserving AAL1, session-ID preservation during refresh, proof-free refusal after refresh, and TOTP-issued AAL2.

Named application commit 23608ad7 passed independent review (delegation-review.md); full CI passed (delegation-ci.log). The additional real PostgreSQL/GoTrue workflow passed twice, including a parent-agent rerun (delegation-postgres-rerun.log): start → tenant-scoped GET → refresh → GET → administrator return; pending-token denial, wrong-company rejection, real app_user RLS/GUC isolation, encrypted stash, and persisted start/end audit rows. The fixture copies schema only and contains synthetic test data; see evidence/schema-fixture.md. This is current-schema verification, not production execution. Pristine historical migration replay remains open at migration 253. Test commit d626b33f passed independent review and full push CI, then reached draft PR345. See final-push-ci.log. K-001 is code-verified. No deployment or historical changes occurred.

## Deliberate authorization limits

Actor authority is captured at issuance, matching prior impersonation behavior; later actor suspension or role removal does not immediately revoke an already-issued delegation. Delegation expires no later than the original actor token. This authorizes application impersonation and does not raise GoTrue or database assurance levels. Non-MFA sessions now consult GoTrue before protected access; provider failures deny access through the existing invalid-token response.
