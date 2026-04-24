# email-templates-shared.ts

## Purpose
Brand constants, `<!DOCTYPE>` HTML layout wrapper, CTA button helper, and signature-sanitisation helper shared by every email template.

## Key exports
- `const BRAND` — `{ logoUrl (CID), appUrl, primaryTeal, darkBg, white, cardBg, outerBg, footerBg, borderColor, textBody, textSecondary, textMuted, fontStack }`
- `emailLayout(content: string): string` — wraps `content` in full HTML doc with dark header (teal underline), 600px card, and branded footer with preferences link
- `ctaButton(label, url): string` — teal button with VML/MSO Outlook fallback via conditional comments
- `appendSignatureToHtml(html, signature): string` — appends a sanitised per-document signature block before `</body>`

## Dependencies
- `sanitize-html` — narrow allowlist for the signature field (tenant-controlled HTML)

## Critical notes
- **Pentest H12**: signatures are user-entered HTML from company settings and are broadcast to every customer/supplier recipient. `appendSignatureToHtml` sanitises with a narrow allowlist — only `b, strong, i, em, u, a, br, p, span, div` with `href/title` on `<a>` and `http/https/mailto` schemes. Never bypass this helper or relax the allowlist without a fresh pentest review.
- `logoUrl` is a CID (`cid:isaflow-logo@isaflow.co.za`) — the email-sending service must attach the PNG inline with that Content-ID, otherwise the header image 404s.
- `ctaButton` uses Outlook-only VML via `<!--[if mso]>` — removing the conditional-comment pair will break Outlook rendering (buttons become text links).
- Footer hardcodes a `/preferences` link — keep the route live.
- Empty/whitespace signatures short-circuit: `appendSignatureToHtml` returns html unchanged. Post-sanitisation empty output also short-circuits.

## Recent changes
- 2026-04-24: Hardened signature sanitisation during pentest Critical+High batch.
- 2026-04-13: Switched logo to inline CID with dark-bg-safe variant.
- 2026-04-12: Split from email-templates.ts for the ≤300-line refactor.
