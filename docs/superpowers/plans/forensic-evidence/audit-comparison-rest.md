# Audit comparison REST delivery

Base `c1b613d7b`; own only `pages/api/accounting/audit-comparisons.ts`, dedicated
unit/HTTP tests, fixture and this plan. Shared services/crypto/registry/schema
are unchanged. POST strict `{firstSnapshotId,secondSnapshotId,idempotencyKey}`
uses the existing shared parser/enqueue. GET strict scalar
`{comparisonId,section,limit?,cursor?}` converts canonical decimal limit 1..100
and delegates the authenticated bounded page reader. No scans or financial
write permission; source rights derive from authenticated retained headers.
Use withAuth(withErrorHandler(withCsrf(handler))); invalid shape 400,
current-domain denial 403. Browser cookie POST must pass real CSRF.

Tests first: isolated adapter units (explicit mocked delegation, not authority
proof) missing module RED, strict body/query/array rejection, limit conversion,
permission response and method restriction. Actual local apiResolver HTTP:
real signed human cookies, tenant membership, real snapshot queue/workers,
POST comparison metadata-only enqueue, real comparison worker and GET complete
paged changes; duplicate POST same job; stored cookie delegation identity;
foreign tenant and current payroll revocation denied; bad CSRF and extra
caller authority create no jobs. Invalid repeated query values remain arrays
in fixture exactly as Next parses them. No handler/kernel/DB substitutions.

Fixture validates synthetic target, sets auth/crypto env before route import,
uses its own pool and closes the actual auth/neon pool plus local listener on
success/setup failure, attempting every cleanup even if one fails. Tests use
localhost only. Request root lease before PG/heavy static; committed tests
precede production implementation. Actual HTTP proof and source/dedicated TS
plus typed lint required before named independent review/integration.
