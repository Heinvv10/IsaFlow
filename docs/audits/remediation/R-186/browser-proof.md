# R-186 browser proof: the archive preview's skipped line

- **Code:** `0ef5c9cd3a41266b2ea49f7ed734329543735624` (committed), worktree `.worktrees/r186`.
- **Server:** `next dev` on port 3286, pointed at `isaflow-fixture-r186` (never dev or prod).
- **Fixture data:** company "R186 Browser Proof" (`f14f8c49-158d-4326-864d-530ce4e67eca`) with one admin member. It holds two paid
  customer invoices dated 2001-01-01; a completed Paystack request (purpose
  `customer_invoice`) references one of them.
- **Login:** a staff access token minted with `JWT_SECRET`, as the integration suites mint it.
  It is HS256 with `aal2`, so no GoTrue call is made. Its cookies (`sb-access-token`,
  `active_company_id`, `ff_onboarding_done`, `isaflow_remember_me=1`) went into a Playwright
  storageState in the scratchpad, which was deleted afterwards; neither the token nor the cookies
  are committed.
- **Steps:** load `/accounting/data-archiving` (waitUntil `domcontentloaded`, then wait for the
  cutoff input), set cutoff 2005-01-01, click Preview, wait for the line.
- **Afterwards:** the dev server was stopped by PID (found with `ss -ltnp` on 3286), and the seeded
  rows were deleted.

## Result

- Page URL: `http://localhost:3286/accounting/data-archiving`, with no redirect to login or onboarding.
- Preview request: `GET /api/accounting/data-archiving?action=preview&cutoff=2005-01-01` returned **200**. Body:

```json
{
  "success": true,
  "data": {
    "preview": {
      "journalEntries": 0,
      "journalLines": 0,
      "bankTransactions": 0,
      "customerInvoices": 1,
      "customerInvoicesSkipped": 1,
      "supplierInvoices": 0,
      "totalRecords": 1
    }
  },
  "meta": {
    "timestamp": "2026-10-03T09:16:17.008Z"
  }
}
```

- Line shown under the preview: "1 paid or cancelled customer invoice(s) before the cutoff stay live: a Paystack or Stitch payment request refers to them."
- Console errors: none.

Screenshot: `browser-proof-preview.png`. The Storage Dashboard card was still loading when the
full-page shot was taken; it is not part of this change.
