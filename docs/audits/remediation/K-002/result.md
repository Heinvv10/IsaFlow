# K-002 verification

Four real PostgreSQL cases failed before implementation: cookie/PAT requests retained HTTP200 after actual suspendCompany/deleteCompany mutations. The common membership query now joins the selected company and excludes suspended/deleted status or any suspension timestamp; a missing company cannot authorize membership. Cookie, PAT, OAuth and print callers use this query in their existing app_user transaction. Legacy nullable company status remains accepted when not marked suspended.

Expanded workflow: 12 company-standing lifecycle cases plus the real K-001 impersonation workflow pass. OAuth uses a synthetic opaque token stored by hash and actual validator; cookie uses a synthetic valid AAL2 signature; print uses the real minter; PAT uses createPat. No claim that this tests OAuth consent or login UI. Real admin company services mutate disposable fixtures. Each lifecycle verifies active access, suspension/deletion refusal, no handler execution on refusal, another active tenant, and reactivation. Existing auth suite:319 passed. Typecheck passed.

Cookie membership denial retains existing clearAuthCookies behavior. The other-company control presents the still-valid credential explicitly; it does not claim the browser keeps its cookie jar or avoids signing in again. Platform-admin and identity-only routes remain outside this tenant gate. Already-running requests are not cancelled when suspension happens after authorization.

No migration, production changes or retrospective repair. Named review approved fix b5e0ab31 and follow-up test f8937536. FullCI passed (9304 unit,384 component;234 unit skipped). Draft PR346 publishes f8937536. K-002 is code-verified, not deployed. Current-schema evidence does not close historical migration replay253.
