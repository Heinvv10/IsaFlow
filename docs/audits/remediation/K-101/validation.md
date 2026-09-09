# K-101 — Portal token and payment-link routes use the default company

**Baseline:** origin/master `31fc2f10`; both routes unchanged since the audited `5661d6f0`.

**Claim vs corrected trigger.** The routes do read the default company, but "minting tokens
against the wrong tenant" overstates it. Every downstream query is still scoped by that derived
`companyId`, and `withAuth` sets `app.current_company_id` to the ACTIVE company, so RLS keeps the
lookup inside the active tenant. The result is therefore a miss, not a leak: for a user whose
active company is not their default, the invoice is not found and the route answers 404 for an
invoice the user is looking at. There is no cross-tenant disclosure.

**Disposition: confirmed (narrowed).** Reported high; corrected **medium** — a functional break for
multi-company users, not a tenant boundary break.

**Evidence.** `pages/api/portal/invoice/generate.ts:32` re-derives the company with
`SELECT company_id FROM company_users WHERE user_id = $1 ORDER BY is_default DESC, created_at ASC
LIMIT 1`, ignoring `req.companyId`, which `withAuth` already set to the active company
(`src/lib/auth/withAuth.ts:163`). The same query appears at `pages/api/portal/payment-link.ts:62`
and `pages/api/portal/invoice/[token].ts:176` (the internal `generateToken` action).

**Reachability.** Any user who belongs to more than one company and has switched away from their
default. Executed: user in two companies (default A, active B), invoice in B, `POST
/api/portal/invoice/generate` answered **404** and left `portal_token` NULL.

**RED test.** `tests/integration/k101-portal-generate-uses-default-company.int.test.ts` — 1 failed
(`expected 404 to be 200`). Output in `red.log`.

**Proposed fix.** Delete the `company_users` lookup in all three places and use
`(req as AuthenticatedNextApiRequest).companyId`, which `withAuth` guarantees is a company the user
is a member of. Keep the existing `company_id = ${companyId}` predicate on the invoice queries.
That removes a round trip as well as the bug.

**Historical impact.** No wrong data was written — the write path never ran. The visible residue is
invoices in non-default companies that have `portal_token IS NULL` despite a user having tried to
share them. Read-only sizing of the exposed population: `SELECT COUNT(*) FROM company_users a JOIN
company_users b ON b.user_id = a.user_id AND b.company_id <> a.company_id;` — every user counted
there hits the 404 whenever their active company is not the default one.

**Risk.** Low. `payment-link.ts` POST also passes `clientId` from the body; switching to
`req.companyId` tightens that path rather than loosening it. The `[token].ts` file mixes a public
token route with this authenticated action, so the edit must land in `handleGenerateToken` only.
