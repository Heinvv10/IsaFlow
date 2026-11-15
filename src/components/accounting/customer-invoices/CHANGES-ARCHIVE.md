# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-07: the customer's default revenue account (master plan wave 4, PR RA, migration 966). `useCustomerLookup` reads `default_revenue_account_id`; `useContactDefaults` fills `glAccountId` on lines carrying `accountFromDefault` (BLANK_LINE and `addLine`, via `lineAccount`), moves only those on a change of customer (back to '' for a customer with none), and `editedLine` drops the flag on any account pick ("Default sales" included), so a user's pick is never overwritten. The account cell says "from customer" while the flag holds. The flag never reaches the API (`createBody`) nor the draft comparison (`useLocalInvoiceDraft`). **New-invoice page only**: scanned lines carry no flag (as with the discount), and the MCP `create_draft_invoice` / `bulk_create_customer_invoices` never read the default. A stored default that can no longer be used (the GET's `default_revenue_account.usable` false: deactivated, re-typed, given sub-accounts) is not applied; the table shows `accountHint` saying so. The edit page is unchanged. Test: `tests/unit/components/invoiceDefaultRevenueAccount.test.tsx`.
- 2026-11-06: the new page's PDF preview before the first save (master plan wave 4, PR PV): `createBody` (`newInvoiceBody.ts`) is the one body Create sends and the preview renders; `InvoicePdfPreview unsaved={{ body } | { problem }}` POSTs it to invoice-pdf-preview (never create: not metered, no number), starts closed, re-renders 3 s after the last change while open, sends nothing while there is a problem, and keeps the last good PDF through a refusal with the reason. The scanned-customer lookup moved to `useScannedClientMatch`.
- 2026-11-03: PR S review rounds 11-13: shown digest on GET/create/PUT and both checks, WIP line removal by name, Navigation API Stay, keyed preview iframe, STALE_VIEW reload on autosave.
- 2026-11-02: autosave with "Saved", the unsaved-change guard, Approve & email, the edit page's PDF preview (master plan wave 3, PR S).
- 2026-11-01: a plain row click opens `InvoiceDrawerBody`, including a click on the number; Ctrl, Cmd, Shift and the middle button still open the page (master plan wave 3, PR U).
- 2026-11-01: PR D review: mode changes convert the shown prices, per-line discount flag, VAT conflict warning, Save waits for the customer, a stored rate 0 draft loads as No VAT, the discount column cannot hide a charged discount.
- 2026-11-01: customer defaults, tax mode, Due date "+30" anchored on the invoice date, edit page on PageHeader (master plan wave 3, PR D).
- 2026-10-27: new/edit forms moved onto the kit (master plan wave 2, PR I).
- 2026-09-23: created (invoice search & filters, PR 2 of 2).
