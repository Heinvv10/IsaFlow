# K-003 bureau company delegation

Baseline d2ac8b54; original audit5661d6f0. POST /api/bureau/clients checks bureau ownership, then linkCompanyToBureau inserts any supplied company ID. This service has one production caller. Bureau tables have foreign keys/unique keys but no company-approval constraint. withUserAuth and metrics use the privileged pool. GET /api/bureau/client/[companyId] trusts the newly inserted bureau link; its correctly scoped SQL does not establish permission to create that link.

Real PostgreSQL route reproduction before app edits: owner links own company successfully, then links unrelated company (200), reads client metrics (200), and receives synthetic AR1234. Expected403/404/no AR. See red.log. Both real auth/CSRF/error middleware and actual financial query run; valid AAL2 signature is synthetic, no provider-login claim.

## Correction

- Implement a shared service-level atomic INSERT…SELECT gate in bureauCompanyLinkService.ts, re-exported from existing bureauService.ts to retain imports. Require addedBy to own bureau AND have owner/admin company_users membership for the exact target company; company must not be suspended/deleted/marked suspended. A bureau membership or company viewer/accountant role alone cannot grant company-wide bureau delegation.
- Return boolean authorization result, including true for an authorized idempotent repeat. CTE authorization and insertion share one statement snapshot; do not use a separate application check followed by an unguarded insertion.
- POST route returns generic403 on false; retain bureau owner check, CSRF and existing success envelope. Other service callers cannot bypass the company check.
- Test unauthorized company, role downgrade, wrong bureau, missing/suspended company, valid link/list/client metrics/unlink lifecycle and concurrent idempotent repeats. Verify bureau viewer can consume a legitimately granted delegation without direct company membership (existing intended contract).
- Update canonical bureau service docs and generated mirror. Named commit review, fullCI and draft PR before next root cause.

No schema change or production mutation. Existing bureau links may have been created without approval; produce a scoped read-only impact query and review plan, not automatic deletion. Current membership cannot prove historical consent (membership can change). Existing grants remain durable until unlink; this correction guards new grants and does not claim historical cleanup. In-flight membership changes after statement snapshot are not retroactively revoked. Rollback: code revert reopens link bypass.
