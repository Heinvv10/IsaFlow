# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-24 (S-07d, migration 937): `createShareLink` and `revokeShareLink` run on the migration_admin pool (same per-company advisory lock, 5 s lock_timeout); app roles keep only the view counter (`view_count`, `last_viewed_at`).
- 2026-09-06: the share route serves its own CSP, the site policy minus Cloudflare Web Analytics. Partial — the zone setting is the complete fix and is not a code change.
- 2026-09-06: `commitShareView` re-checks revocation and expiry in its own UPDATE, so a revoke landing while the pack was being built stops the response instead of being recorded as a plain `ok`.
- 2026-09-06: migration 613. An unmatched token is audited too, with a null link and company, so the three dead outcomes cost the same; and the resolve moved inside the page's `try` so a throw is the neutral 404 rather than a 500.
- 2026-09-06: `cash_flow` joined `OMITTED_SECTIONS`. `buildSectionData` synthesizes it (operating cash flow = net profit, investing and financing = 0), which is a placeholder on the owner's screen and a false statement of cash movement on a document sent to a bank. It returns when the section is built from the ledger.
- 2026-09-06: the public page reads the client IP through `getClientIp` (`@/lib/rateLimit`) — LAST forwarded hop, pentest H8 — instead of its own first-hop parser. `user_agent` is bounded once, in `recordShareView`.
- 2026-09-06: `/share/` is excluded from the service worker in both `public/sw.js` and `_app.tsx`; a cached pack served offline after revocation defeats the only control the sender has.
