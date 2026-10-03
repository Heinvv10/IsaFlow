# R-186 browser proof: the archive preview's skipped line

Re-captured on 2026-10-03 for the round-3 copy. Earlier captures, at `0ef5c9cd3` and `df8d76509`
with older copy, rendered the same counts.

- **Code:** `8f9cc4fbef354988e3c6398f8924661c527b2bce` (committed), worktree `.worktrees/r186`.
- **Server:** `next dev` on port 3286, pointed at `isaflow-fixture-r186` (never dev or prod).
- **Fixture data:** company "R186 Browser Proof" (`09915bfe-e761-4b34-b423-bbbebb5b4e37`) with one admin member. It holds two paid
  customer invoices dated 2001-01-01; a completed Paystack request (purpose
  `customer_invoice`) references one of them.
- **Login:** a staff access token minted with `JWT_SECRET`, as the integration suites mint it.
  It is HS256 with `aal2`; an `aal1` token makes the server ask GoTrue, and `/api/auth/me` then
  answers 503 without `SUPABASE_ANON_KEY`. Its cookies (`sb-access-token`, `active_company_id`,
  `ff_onboarding_done`, `isaflow_remember_me=1`) went into a Playwright storageState in the
  scratchpad, which was deleted afterwards; neither the token nor the cookies are committed.
- **Steps:** load `/accounting/data-archiving` (waitUntil `domcontentloaded`, then wait for the
  cutoff input), set cutoff 2005-01-01, click Preview, wait for the line.
- **Afterwards:** the dev server was stopped by PID (the next-server listener found with
  `ss -ltnp` on 3286, plus its node and bunx parents). The port is free and the seeded rows are
  deleted.

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
    "timestamp": "2026-10-03T09:49:16.931Z"
  }
}
```

- Line shown under the preview: "1 paid or cancelled customer invoice(s) before the cutoff cannot be archived: a Paystack or Stitch payment request refers to them. If one of them is still linked to a journal before the cutoff, the whole archive is refused; Validate checks this."
- Console errors: none.

Screenshot: `browser-proof-preview.png`. When the full-page shot was taken, the Storage Dashboard
card and the company switcher were still loading. Neither is part of this change.
