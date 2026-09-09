# K-060 — quote numbering reads outside the active company

**Claim.** `quoteService.ts:85` next-number query has no company predicate, so
quote numbers are global and collide.

**Corrected trigger.** The SQL is indeed unscoped:
`SELECT quote_number FROM customer_quotes ORDER BY created_at DESC LIMIT 1`
(origin/master, lines 86-88). It is not global at runtime: `withAuth` runs every
request query as `app_user` (`src/lib/auth/withAuth.ts:101`) and
`customer_quotes` has RLS forced with policy `tenant_isolation`, qual
`company_id IN (SELECT auth.user_companies())`. But `auth.user_companies()` is
`SELECT company_id FROM company_users WHERE user_id = auth.uid()` — *every*
company the user belongs to, not the request's company. So the leak is real and
bounded by the user's memberships: a bureau or group user numbering a quote in
company A gets company B's next number. There is also no unique index on
`(company_id, quote_number)`, so the collision is silent, not a 23505.

**Disposition: confirmed** (narrowed from "global" to "across the user's own companies").

**Evidence.**
- File unchanged between `5661d6f0` and `origin/master`.
- Policy and function read from the fixture schema (`pg_policy`, `pg_proc`).
- Reachable: `pages/api/accounting/customer-quotes.ts:38` and
  `src/lib/mcp/tools/writeInvoices.ts:143` both call `createQuote`.
- RED test: `tests/integration/k060-quote-number-crosses-tenants.int.test.ts`.
  One user, member of companies A and B; B holds `QUO-00042`, A holds nothing.
  `createQuote` is run inside `als.run` on a client with `SET LOCAL ROLE app_user`
  and `request.jwt.claims`, i.e. RLS enforced exactly as in production.
  Expected `QUO-00001`, got `QUO-00043`. 1 test, 1 failed. Output: `red.log`.

**Proposed minimal fix.** Give `nextQuoteNumber(companyId)` a
`WHERE company_id = ${companyId}::UUID` and pass it from `createQuote`
(line 180). Order by the numeric suffix, not `created_at`. Add a migration with
`CREATE UNIQUE INDEX IF NOT EXISTS` on `(company_id, quote_number)` so a
concurrent duplicate raises rather than persisting.

**Historical-data impact.** Quote numbers only; no GL effect. Existing quotes in
multi-company tenants may have gaps or duplicates. Read-only check:

```sql
SELECT company_id, quote_number, COUNT(*) FROM customer_quotes
GROUP BY 1,2 HAVING COUNT(*) > 1;
```
Not run — production is out of scope. The unique index must not be added until
this returns zero rows.

**Risks.** Adding the unique index before de-duplicating existing rows fails the
migration.
