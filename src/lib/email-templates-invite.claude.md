# email-templates-invite.ts

## Purpose
User-invitation email HTML template, split out of `email-templates.ts` to keep files under 300 lines.

## Key exports
- `interface InviteEmailData` — `{ inviterName, companyName, role, inviteUrl, recipientEmail }`
- `inviteEmailHtml(data): string` — branded card with org/role summary, "Accept Invitation" CTA, plain-link fallback, and 7-day expiry notice

## Dependencies
- `./email-templates-shared` — `BRAND`, `emailLayout`, `ctaButton`

## Critical notes
- `escapeHtml` is applied locally to every user-controlled string (`inviterName`, `companyName`, `role`) before interpolation — XSS-safe.
- `inviteUrl` is NOT escaped because it is system-generated (absolute URL with signed token). Do not pass user-controlled URLs.
- `recipientEmail` is captured for logging but not rendered in the template.
- 7-day expiry copy must stay aligned with the invite-token TTL enforced in the invite-acceptance handler.
- Uses table-based layout with inline styles for email-client compat (Outlook, Gmail, Apple Mail).

## Recent changes
- 2026-04-12: Split from email-templates.ts during the ≤300-line refactor.
