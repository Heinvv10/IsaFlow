# K-002 company standing

Baseline: 435071fd (application inherited from reviewed K-001). Cookie withAuth and PAT/OAuth bearerPipeline authenticate user standing and membership, but not company standing. suspendCompany sets status=suspended and suspended_at; deleteCompany sets status=deleted. Neither invalidates credentials. Current-schema companies and company_users RLS policies call auth.user_companies/user_admin_companies, whose bodies only check membership, not company status. PAT and OAuth validation check token hash, expiry and revocation only.

Real current-schema regression company-standing.int.test.ts: two companies and a live member; valid signed AAL2 cookie and actual createPat token each reach a real RLS-protected company query before suspension. Actual suspendCompany/deleteCompany service mutations then still yield HTTP200 on both credential paths. Four failures expected403/received200 are preserved in red.log. No application edits preceded that run. Cookie signature is synthetic; this tests company authorization, not provider MFA.

## Implementation plan

1. Extract existing parameterized membership/profile query into src/lib/auth/companyMembership.ts, shared by withAuth and bearerPipeline. Execute on the existing app_user transaction with its tenant GUC and exact user/company parameters.
2. Inner join the selected companies row, exclude suspended/deleted status and any suspended_at marker. Preserve legacy nullable status (schema default active; null was previously allowed). Missing companies fail closed. Existing missing membership response stays403. User suspension/profile checks remain unchanged.
3. Re-run failing real database workflow; cover active company, suspension, deletion, other company, reactivation and bearer/cookie callers. Expand OAuth/negative cases and run existing auth suites. Extracting the common lookup also keeps edited middleware under300 lines.
4. Named commit review, complete CI, explicit-path commit and stacked draft PR before advancing.

No migration or historical financial writes. Existing credentials need not be revoked; every subsequent tenant request rechecks company standing. Identity-only routes remain usable to switch companies; platform-admin recovery remains usable. In-flight requests already authorized before suspension are not retroactively cancelled. Rollback is code revert and reopens this defect. Historical use during suspension is not assessed; no retrospective repair is authorized.

Historical pristine migration replay remains open at253. This root uses the documented schema-only disposable fixture; no production rows copied or altered.
