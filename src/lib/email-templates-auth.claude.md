# email-templates-auth.ts

## Purpose
Auth-flow email HTML templates — welcome email sent on account creation and password-reset email.

## Key exports
- `interface WelcomeEmailData` — `{ name, email, companyName }`
- `welcomeEmailHtml(data): string` — welcome mail with three feature highlight cards (Invoicing, Banking, Reports) and a "Get Started" CTA to `BRAND.appUrl`
- `interface PasswordResetData` — `{ name, resetUrl }`
- `passwordResetEmailHtml(data): string` — reset mail with "Reset Password" CTA and 1-hour expiry notice

## Dependencies
- `@/lib/email-templates` — imports `BRAND`, `emailLayout`, `ctaButton` (barrel re-export of `email-templates-shared`)

## Critical notes
- Inputs are interpolated raw — **no HTML escaping**. Callers must sanitise any user-controlled field (e.g. display name) before invoking. The invite/invoice templates run their own `escapeHtml`; this one does not.
- Reset-link expiry copy says "1 hour" — the generating service (`pages/api/auth/forgot-password`) must keep the token TTL aligned.
- Feature icons are HTML entities (`&#128203;` clipboard, `&#127968;` bank, `&#128200;` chart) for broad email-client compat.
- File imports from `@/lib/email-templates` (the barrel), not `email-templates-shared` directly — diverges from sibling templates.

## Recent changes
- 2026-03-30: Added with the initial user management, onboarding, and email system rollout.
