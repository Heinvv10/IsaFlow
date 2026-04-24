# email-templates-invoice.ts

## Purpose
Customer-facing invoice email HTML template — accompanies the PDF attachment when an invoice is sent.

## Key exports
- `interface InvoiceEmailData` — `{ invoiceNumber, clientName, invoiceDate, dueDate, totalAmount, balanceDue, companyName, portalUrl? }`
- `invoiceEmailHtml(data): string` — branded invoice summary card (invoice #, dates, balance due highlighted in teal), optional "View Invoice" CTA when `portalUrl` is supplied, and a payment-reference reminder

## Dependencies
- `./email-templates-shared` — `BRAND`, `emailLayout`, `ctaButton`

## Critical notes
- `escapeHtml` is applied locally to `invoiceNumber`, `clientName`, and `companyName` — XSS-safe.
- `invoiceDate`, `dueDate`, `totalAmount`, `balanceDue` are NOT escaped. Callers must pre-format these as safe strings (already the convention in the invoicing service — they are currency-formatted numbers and ISO dates).
- `portalUrl` is NOT escaped — assumed system-generated. Do not pass untrusted URLs.
- The CTA only renders when `portalUrl` is truthy, so sending with no portal link still produces a valid email.
- Signature block is NOT attached here — the caller (invoicing service) uses `appendSignatureToHtml` from `email-templates-shared` after rendering.

## Recent changes
- 2026-04-12: Split from email-templates.ts during the ≤300-line refactor.
