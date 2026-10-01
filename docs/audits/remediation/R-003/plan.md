# R-003 implementation plan

Baseline ff2ab7ba. Real authenticated POST followed by SDK-signed inbound text creates a capture event for an unproven first claimant; red.log records the failing no-event assertion. No production/provider traffic was used.

## Contract and design

A syntactically valid number creates a pending company-scoped claim, not an active routing reservation. The response contains a random 32-byte token in a verification URL; only its SHA256 is stored. Pending claims expire after 24 hours. Starting again replaces the pending claim under the same company advisory lock used for activation. Existing verified routing remains usable during rotation.

A webhook must have a valid provider signature for the exact configured URL including query, exactly one canonical token, and signed To matching the pending or verified address. Under a transaction and company lock, re-read token, expiry and current creator writer role/user/company standing before activation. A token never authorizes another number or tenant. Unknown, expired, superseded and unproven legacy routes reject before capture, query matching, storage or outbound replies. Ingestion receives verified company/inbox scope and checks it again; no address-only fallback.

Only successful verification reserves the destination through migration617's unique identity. A different company/retired reservation remains a conflict requiring reviewed transfer; no automatic reassignment. A pending first claim cannot block another company from proving the number. Existing active assignments receive no fabricated proof; legacy rollout requires review/reverification and remains a deployment dependency.

## Files and verification

- Migration618 adds nullable verified token hash/time to capture_inboxes and a tenant-scoped pending claim table with RLS/grants. No historical data mutation. Test repeated migration and tenant isolation on disposable PostgreSQL.
- Separate pending/verification services keep files below300 lines; routes preserve auth, CSRF, role and signature controls. Token query uses existing redaction rules.
- Capture settings shows Pending verification, unique callback URL, expiry/restart and Check status. Preserve active number during pending rotation and existing chase controls; no fake Connected state.
- Extend PostgreSQL integration coverage: red regression, successful proof/capture, arbitrary/wrong/duplicate token, query-bound signature, wrong To, expiry/replacement, revoked creator/standing, two-company pending same number, reservation conflict, rotation and deterministic locking. Update K005 workflow to provide proof where activation now requires it.
- Verify affected UI with browser/API/data path, regression tests, named independent review and full CI before draft PR. SDK-signed fixtures prove the local provider contract only; no real external messages are authorized.

## Rollout and rollback

Prepare scoped read-only legacy assignment inventory. Do not deploy, mutate production or silently transfer numbers. Retain identity reservations and proof columns on rollback; reverting to address-only routing would restore the defect. Provider sandbox acceptance remains separately recorded if unavailable.
