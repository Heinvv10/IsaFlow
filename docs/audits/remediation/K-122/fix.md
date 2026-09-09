# K-122 — dunning emails now link a token the portal accepts

**Trigger.** `renderTemplate` built `{{portal_link}}` as `${portalBaseUrl}/portal/invoice/${ctx.invoice_id}`
— the invoice UUID. Both `pages/portal/invoice/[token].tsx` and `pages/api/portal/invoice/[token].ts`
accept only `/^[a-f0-9]{64}$/` (the `portal_token`), so every default SA template's link 404'd.

**Before.** Link last segment = invoice UUID → notFound before any query.
**After.** `renderTemplate` resolves the invoice's `portal_token` and builds the URL from it. The
send path mints idempotently; the preview path (`mintPortalToken: false`) only reads. No base URL,
or no token yet, still yields `(portal link unavailable)`. A failed mint on the send path now
THROWS — see H3/M3 below.

**Files.** `dunningService.ts`, `dunningSend.ts` (new — 300-line split), `dunningCronService.ts`,
`portalTokenService.ts`, `portalChatbotService.ts`, `disputeService.ts`, `disputeResolution.ts` +
`disputeTypes.ts` (new — split), `reports-ar-aging.ts`, `disclosureNoteGenerators.ts`,
`customReportFieldDefs.ts`, `bankMatchDbQueries.ts`, `templates/[id]/preview.ts`,
`pages/accounting/disputes/index.tsx`, `components/accounting/disputes/{ResolveModal,types}.tsx`.

**Tests.** Real DB: `k122` (6), `k122b` portal-token race (3), `k122c` cron savepoint isolation (1),
`k123` (6), `k124` (6), `k125b` report parity (4) = **26 passed**. Unit: `k127` sanitiser (20),
`disputeService` (18), `portalTokenService` (14), `dunningService`, `reporting-tax-compliance` =
**150 passed**. Full unit suite with `DATABASE_URL` unset: **9580 passed / 243 skipped (841 files)**.
Mutation-proof: 6 reverts, each RED — see `green.log`.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** No stored row is made wrong by this change. Already-sent emails carry
dead links; `dunning_sends` bodies are immutable by design, so history stays wrong and only future
sends are fixed. Read-only count of affected sends (NOT run against production):
```sql
SELECT company_id, count(*) FROM dunning_sends
 WHERE rendered_body ILIKE '%/portal/invoice/%' GROUP BY 1;
```
Credit notes already created from disputes (M6) booked the gross disputed amount to revenue with
zero VAT. Read-only identification (NOT run against production):
```sql
SELECT cn.company_id, cn.id, cn.total_amount
  FROM credit_notes cn
  JOIN customer_invoice_disputes d ON d.credit_note_id = cn.id
 WHERE cn.tax_rate = 0 AND cn.company_id = $1;
```
Those rows need an accountant's decision (reverse and re-issue, or a VAT reclassification journal);
this commit does not touch them.

**Limits.** `resolveDispute` derives the credit note's tax rate from the invoice's own
`tax_amount / subtotal`, which is right for a single-rate invoice and approximate for a mixed-rate
one. A per-line split needs the disputed lines, which `customer_invoice_disputes` does not require.

---

## Blind-review dispositions (13 findings, `scratchpad/review-k122.md`)

| # | Finding | Disposition |
|---|---|---|
| H1 | Sanitiser strips ordinary "select … from" English | **Fixed.** Sentence-level classifier; lower-case `select…from` must also carry SQL structure. 5 portal-English cases asserted untouched. |
| H2 | Sanitiser fails OPEN (`clean \|\| text`) | **Fixed.** Returns `SANITIZED_FALLBACK`. The test that locked the fail-open in is inverted. |
| H3 | Swallowed PG error poisons the request transaction (25P02) | **Fixed, and proved by outcome.** The swallow is gone (renderTemplate throws) AND the cron wraps each invoice in `withSavepoint`. `k122c` drives the real cron inside a real ALS transaction, raises a real PG error in invoice 1, and asserts invoice 2 still sends, a later statement still runs, and invoice 1's partial writes (its `portal_token`) were rolled back. Mutation (savepoint removed) → invoice 2 fails with 25P02. |
| M1 | Concurrent renders mint two tokens; one link dead | **Fixed.** `UPDATE … SET portal_token = COALESCE(portal_token, $1) … RETURNING`. `k122b` interleaves a rival writer on a second pooled connection between the service's own SELECT and its UPDATE — the real service path, not replayed SQL. Mutation (COALESCE dropped) → RED. |
| M2 | Preview persists a bearer credential | **Fixed.** `RenderTemplateOptions.mintPortalToken`; preview reads only, asserted to leave `portal_token` NULL. |
| M3 | Swallowed failure emails a broken placeholder marked `sent` | **Fixed** with H3 — the send path throws instead. |
| M4 | Same NULL arithmetic left in aging / AFS / custom reports | **Fixed** at all listed sites. `emailNotificationService.ts:63` already coalesced in JS (`?? 0`) and needed no change. `k125b` asserts the aging report and the debtors page agree on the same data. |
| M5 | Disputes page ignores `total` | **Fixed.** Page reads `total`/`openTotal`/`openDisputedAmount` from the API and paginates; tiles no longer derived from one page. |
| M6 | Legacy disputes reach a zero-VAT credit note | **Fixed.** Tax rate derived from the invoice; the disputed amount is split back out of the VAT-inclusive total. |
| M7 | Widened test asserts only `calls[0]` | **Fixed.** Asserts over every `mockSql` call. |
| L1 | 300-line limit | **Fixed.** `dunningSend.ts`, `disputeTypes.ts`, `disputeResolution.ts`, `ResolveModal.tsx` split out; every touched file now ≤ 259 lines. |
| L2 | Residual sanitiser gaps | **Fixed.** Sentence-level dropping (not in-place editing) closes the long-column-list, quoted-identifier and bare-fragment leaks; zero-width characters are normalised first. |
| L3 | Second round trip for the count | **Disputed, deliberately kept.** `COUNT(*) OVER ()` is computed over the rows the page returns, so a page past the end (`offset >= total`) reports total 0 and breaks the caller's pagination — `k123` asserts exactly that case. The four hand-written branches were collapsed into one NULL-guarded predicate set instead, which is what actually stopped the page and the count drifting apart. |
