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
SELECT cn.company_id, cn.id, cn.status, cn.subtotal, cn.tax_amount, cn.total_amount
  FROM credit_notes cn
  JOIN customer_invoice_disputes d ON d.credit_note_id = cn.id
 WHERE cn.tax_rate = 0 AND cn.company_id = $1;
```
`cn.status` decides the exposure: a `draft` note posted nothing, so only the document is wrong;
an `approved` or applied note reached the GL and the VAT201 (revenue over-reduced and output VAT
never reversed by the same amount — an over-payment to SARS, not an under-declaration).
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
| L3 | Second round trip for the count | **Kept — the reasoning first given for it was wrong.** `COUNT(*) OVER ()` IS evaluated before LIMIT/OFFSET, so it does not "count only the returned rows". What actually breaks is that a page past the end returns NO row, so there is nowhere to read the window value from and the caller sees total 0 — `k123` asserts that case. The round trip also stands on its own: the same aggregate produces `openTotal` and `openDisputedAmount`, which deliberately ignore the status filter and no window function over the filtered page query can produce. |

---

## Blind-review dispositions, round 3 (12 findings, `scratchpad/review-k122-r3.md`)

| # | Finding | Disposition |
|---|---|---|
| M-1 | `debtorsManagerService` still joined bare `ci.client_id`, so the aging↔debtors parity M4 claimed did not hold for legacy invoices | **Fixed.** All six sites (summary select/join/group-by, detail filter, overdue select/join, stats DISTINCT) use `COALESCE(ci.client_id, ci.customer_id)`, and the customers join is now company-scoped. `k125b` grew a `client_id IS NULL` row and a fourth assertion covering summary/detail/overdue/stats together. Mutation (join back to bare `client_id`) → RED. |
| M-2 | `resolve_with_credit` leaves an unapproved DRAFT credit note, so the amount re-ages and dunning resumes chasing it | **Fixed.** The cron's dispute gate (now `has_blocking_dispute`) also skips an invoice whose dispute was resolved with a credit note still in `draft`; it resumes once that note is approved. The EXISTS is also company-scoped, which it was not. `k122d` asserts both directions. Mutation (draft clause removed) → RED. |
| M-3 | `resolveDispute` is check-then-act: two concurrent resolves each create a credit note | **Fixed.** The read-then-write is replaced by ONE status-predicated claim (`UPDATE … WHERE status = 'open' RETURNING`) issued BEFORE `createCreditNote`, so the loser throws with nothing written and no orphan document; `credit_note_id` is linked in a second UPDATE. `k124b` runs two real concurrent resolves and asserts one credit-notes row. Mutation (status predicate dropped) → RED. |
| M-4 | The narrowed sanitiser let a lower-case `select … from <table>` through on the public portal | **Fixed.** Two rules added: a comma-separated bare-identifier column list before FROM, and a snake_case FROM target. The reviewer's measured case (`select name, email from customers`) now returns the fallback. Mutation (round-3 patterns restored) → RED. |
| M-5 | `sendDunning` dispatched the email inside the savepoint's rollback window, so a later failure un-recorded a delivered send | **Fixed.** The `email_status` UPDATE moved to immediately after `sendEmail`, and the evidence row runs in its own savepoint with its failure logged (`log.warn`) rather than thrown. Nothing after the dispatch can now roll the send record back. `k122d` poisons the evidence INSERT inside a real ALS transaction and asserts the row survives as `sent` with a NULL `source_document_id`, and that the transaction is still usable. Two mutations (ordering restored; evidence savepoint removed) → both RED. |
| L-1 | The savepoint is inert on the only production path | **Fixed (documentation).** `k122c`'s header now says no production caller enters an ALS transaction today, so the test guards the invariant for a future in-request caller. |
| L-2 | `k122c`'s "the invoice AFTER it" claim depended on heap order | **Fixed.** The candidate query has `ORDER BY m.invoice_number` and the fixture invoices are numbered `-1-POISON` / `-2-OK`, so the poisoned one is genuinely processed first. Not mutation-provable: removing the ORDER BY leaves the test green by luck, which is the point of the finding. |
| L-3 | The VAT split can over-credit by one cent | **Fixed.** `CreditNoteCreateInput` takes an optional exact `taxAmount`; `resolveDispute` passes `gross − subtotal`, so `subtotal + tax` is the disputed amount by construction (no split of 10.00 at 15% is exact, so the cent goes to VAT). Mutation (override removed) → RED. |
| L-4 | Missing `PUBLIC_APP_URL` still emails `(portal link unavailable)` recorded as `sent` | **Fixed.** `sendDunning` refuses a rendered subject/body still carrying `PORTAL_LINK_UNAVAILABLE`, before any write. `renderTemplate` keeps the placeholder (a read-shaped caller such as preview must still be able to render). Mutation (refusal removed) → RED. |
| L-5 | `K-122`/`K-123` fix.md state the wrong mechanism for `COUNT(*) OVER ()` | **Fixed.** Both rewritten: the window count IS pre-LIMIT; the failure is that an empty page carries no row to read it from. |
| L-6 | Dead `ci.client_id` select in `resolveDispute`; remediation SQL cannot tell drafts from posted notes | **Fixed.** The dead select and its `LEFT JOIN customer_invoices` are gone (the real read is the invoice query below it); the identification SQL above now selects `cn.status`, `cn.subtotal` and `cn.tax_amount`. |
| L-7 | Residual sanitiser false positives (shouty prose, the English word "where") | **Fixed.** The caps-only statement rules fire only on a sentence that also contains a lower-case letter, and the WHERE rule requires a qualified or snake_case column. Both reviewer-measured strings now pass through untouched; an all-caps leaked query is still caught by the case-insensitive rules. Mutation → RED. |

**Round-3 tests.** New: `k122d-dunning-send-durability` (4, real DB), `k124b-dispute-resolve-concurrency` (4, real DB);
grown: `k125b` (5), `k127` sanitiser (28 unit), `disputeService` (20 unit), `dunningService` (14 unit).
Whole item set: **9 integration files / 41 tests**, three consecutive clean runs. Full unit suite with
`DATABASE_URL` unset: **9591 passed / 243 skipped (841 files)**. `tsc --noEmit` and `eslint` clean.
8 mutations, each RED — see `green.log`.

**Test-only surface added.** `runDunningCron({ companyId })` restricts the walk to one company. The
cron itself walks every opted-in company; without it two test files sharing the fixture database each
counted the other's invoices, which is how the k122c/k122d counter assertions first went red.
