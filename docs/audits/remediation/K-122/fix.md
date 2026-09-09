# K-122 — dunning emails now link a token the portal accepts

**Trigger.** `renderTemplate` built `{{portal_link}}` as `${portalBaseUrl}/portal/invoice/${ctx.invoice_id}`
— the invoice UUID. Both `pages/portal/invoice/[token].tsx` and `pages/api/portal/invoice/[token].ts`
accept only `/^[a-f0-9]{64}$/` (the `portal_token`), so every default SA template's link 404'd.

**Before.** Link last segment = invoice UUID → notFound before any query.
**After.** `renderTemplate` calls `getOrMintInvoicePortalToken(ctx.invoice_id, companyId)` (idempotent)
and builds the URL from the returned token. No base URL still yields `(portal link unavailable)`;
an invoice the portal would refuse (cancelled / soft-deleted) logs a warning and falls back to the
same string rather than throwing, so preview and cron keep working.

**Files.** `src/modules/accounting/services/ar/dunningService.ts` (+1 import, portal-link block).

**Tests.** `tests/integration/k122-dunning-portal-link-404.int.test.ts` — 5 passed (real DB):
token shape, mint-once idempotence (compared against the stored `portal_token`), no-base-URL
fallback, cancelled-invoice fallback, cross-tenant render returns null.
Mutation check: restoring `${ctx.invoice_id}` → 2 failed.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** No stored row is wrong; already-sent emails carry dead links and
`dunning_sends` bodies are immutable by design, so history stays wrong and only future sends are
fixed. Read-only count of affected sends (NOT run against production):
```sql
SELECT company_id, count(*) FROM dunning_sends WHERE body ILIKE '%/portal/invoice/%' GROUP BY 1;
```

**Limits.** Rendering now writes: a preview mints and persists `portal_token` on first render. That
is the customer's permanent link, so the write is idempotent and safe, but the preview endpoint is
no longer read-only.

**Existing suite.** `tests/unit/services/ar/dunningService.test.ts` mocks `sql`; renderTemplate now
issues one more query, so that suite queues a `portal_token` row and asserts the link carries it.
Full unit suite green: 9563 passed / 243 skipped. `dunningService.ts` was already 355 lines (over the
300-line cap) before this change and is now 368; splitting it is out of scope here.
