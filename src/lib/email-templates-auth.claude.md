# email-templates-auth.ts

## Purpose
Auth-flow email HTML templates — welcome email sent on account creation and password-reset email.

## Key exports
- `interface WelcomeEmailData` — `{ name, companyName, variant, trialDays }`
- `welcomeEmailHtml(data): string` — SME or accountant welcome mail: three plain feature blurbs, a "Sign in" CTA to `/login`, the contact line (`LEGAL_ENTITY.contactEmail`), in its own `welcomeLayout`
- `WELCOME_FOOTER_TEXT` — the welcome footer's text colour (4.5:1 or better on `BRAND.footerBg`)
- `interface PasswordResetData` — `{ name, resetUrl }`
- `passwordResetEmailHtml(data): string` — reset mail with "Reset Password" CTA and 1-hour expiry notice

## Dependencies
- `@/lib/email-templates` — imports `BRAND`, `emailLayout`, `ctaButton` (barrel re-export of `email-templates-shared`)

## Critical notes
- The welcome email escapes name and company name. The password-reset email interpolates `name` raw: callers must sanitise it.
- Reset-link expiry copy says "1 hour" — the generating service (`pages/api/auth/forgot-password`) must keep the token TTL aligned.
- The welcome email uses `welcomeLayout`, not the shared `emailLayout`: its footer has no em dash, no "do not reply" line (the email asks the reader to write to us) and no `/preferences` link. Do not change the shared footer for it.
- Welcome copy: no emoji (feature markers are teal bars in inline CSS), no claims, no prices, no "!" in the heading. Pinned by `tests/unit/lib/welcomeEmailTemplate.test.ts`.
- File imports from `@/lib/email-templates` (the barrel), not `email-templates-shared` directly — diverges from sibling templates.
