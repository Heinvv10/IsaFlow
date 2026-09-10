# K-122 — dunning emails send a portal link that always 404s

Baseline: origin/master `31fc2f1062d228f6ebf43049338ecb41767002d0`.

**Claim.** The generated portal path does not match any implemented route.

**Corrected trigger.** More precisely: the route exists, but the link carries the wrong identifier.
`renderTemplate` builds `${portalBaseUrl}/portal/invoice/${ctx.invoice_id}` — the invoice UUID —
while both the page (`pages/portal/invoice/[token].tsx:517`) and the API
(`pages/api/portal/invoice/[token].ts:59`) accept only `/^[a-f0-9]{64}$/`, the `portal_token`.
Anything else is notFound before any query runs.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ar/dunningService.ts` :208-210.
- All four SA default templates embed `{{portal_link}}` — dunningDefaults.ts:42, :61, :79, :102.
- The working minting path, `getOrMintInvoicePortalToken` (portalTokenService.ts:33), is called only
  by `pages/api/accounting/ar/invoice/[id]/portal-link.ts` — never by dunning.
- RED: `tests/integration/k122-dunning-portal-link-404.int.test.ts` — 1 failed (2 assertions).
  Rendered last segment was the invoice UUID `5712e760-…`, which fails the portal token regex.

**Reachability.** Both send paths pass a real base URL: `pages/api/accounting/ar/dunning/send.ts:50`
and the cron at `pages/api/cron/dunning-send.ts:36`. Every dunning email sent with a default
template carries a dead link.

**Proposed minimal fix (2 files).**
`renderTemplate` takes the invoice id already: call `getOrMintInvoicePortalToken(invoiceId, companyId)`
and build `${portalBaseUrl}/portal/invoice/${token}`. Keep the '(portal link unavailable)' fallback
when `portalBaseUrl` is absent. Minting is idempotent, so re-rendering a preview is safe.

**Historical-data impact.** No data corruption; the harm is already-sent emails. Read-only count of
affected sends:
```sql
SELECT company_id, count(*) FROM dunning_sends WHERE body ILIKE '%/portal/invoice/%' GROUP BY 1;
```
`dunning_sends` rows are immutable by design, so historical bodies stay wrong; only future sends
are fixed.

**Risks.** Minting a token inside the render path writes to `customer_invoices.portal_token` during
what was a read-only preview. Acceptable (the token is the customer's permanent link) but it makes
the preview endpoint a writer.
