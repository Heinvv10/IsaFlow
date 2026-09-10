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

## Verification and reviewed dependency

Initial unit missing-route RED reproduced after correcting the unit import's
relative path. Implemented transport: five focused units pass, including
explicit mapping of current shared permission denials to 403.

Reviewed additive paging dependency only: original commits `45c641e0c`,
`21d2a8e31`, `4b41c238d` cherry-picked as `f8c76536b`, `6361c2455`,
`1d61e3ae2`. These are root-owned and must be skipped during REST integration.

Actual five HTTP/PG tests at `11622` terminal 0: 7.98 s tests/9.00 s total.
Real cookie authentication/issued context, metadata-only idempotent enqueue,
original cookie delegation, real worker, two complete records across two
pages and empty remaining sections; independent full digest derived only from
HTTP items and authenticated HTTP footer metadata. Current payroll revoke
returns 403 for both repeated POST and GET, then recovery succeeds. Accounts
write permission is explicitly false throughout the positive flow. Foreign
requests reach actual retained index/result tenant readers, which refuse as
unavailable; they currently use generic shared-error HTTP responses (no
claimed typed not-found status). CSRF/extra authority/repeated-array query
refusals leave job population unchanged. No fake HTTP financial ledger claims:
the two synthetic source journals are drafts used to prove retained comparison.
All fixture, auth and neon pools and listener closed after test completion.

Static `57448`: full source TypeScript passed; dedicated tests found only
captured listener-address narrowing. Store the validated scalar port before
request closure, preserving runtime behavior. Retry `14772` terminal 0:
dedicated test TypeScript and typed scoped ESLint both pass with no diagnostics.
Five focused units pass. No source changes after the actual HTTP pass; fixture
correction only makes already-validated port capture explicit. No active
process, listener or pool remains. Full integrated CI/deployment not claimed.
