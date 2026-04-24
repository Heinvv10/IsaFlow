# email-templates.ts

## Purpose
Barrel index that re-exports every email-template function and type from the split files — kept so existing `import from '@/lib/email-templates'` paths keep working.

## Key exports
- From `./email-templates-shared`: `appendSignatureToHtml`, `BRAND`, `emailLayout`, `ctaButton`
- From `./email-templates-invite`: type `InviteEmailData`, `inviteEmailHtml`
- From `./email-templates-invoice`: type `InvoiceEmailData`, `invoiceEmailHtml`

## Dependencies
- `./email-templates-shared`, `./email-templates-invite`, `./email-templates-invoice`

## Critical notes
- Pure re-export file — no logic. Updates must happen in the split files.
- Does NOT re-export auth templates (welcome, password-reset), practice-digest, or practice-monthly — those must be imported from their own modules. `email-templates-auth.ts` in fact imports from THIS barrel (not `-shared` directly), so don't remove the `BRAND/emailLayout/ctaButton` re-exports.
- Split was driven by the 300-line cap; the refactor commit also touched gl.types, apiResponse, and auth/middleware.

## Recent changes
- 2026-04-12: Introduced when email-templates.ts was split into shared/invite/invoice files.
