# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-12: verify-email sets up the bureau for an Accountant sign-up (stored token `signupType`), after `provisionTenant`, same transaction (`@/modules/bureau/services/signupBureauService`); `provisionTenant` itself still creates no bureau. The ops mail moved to `services/signupNotification.ts` (`notifySignup`, same subject and recipient) and gains a bureau line for Accountant sign-ups.
- 2026-10-22: a new company's fiscal periods follow its financial year start. complete-setup rebuilds the periods create_company_with_owner's seeder (mig 476, Jan–Dec current + next year) wrote; `provisionTenant` builds the placeholder's first year from its own `financial_year_start` (RETURNING) instead of Jan–Dec. Existing companies unchanged. Admin create / waitlist promotion write no periods (ensureFiscalPeriodForDate builds them on the declared start).
- 2026-10-16: entity-aware onboarding (step 0 = business type) and the one transactional `complete-setup` endpoint; migration 895.
- 2026-10-17 (review round 3): entity-change check adds maxPeople, duplicates only for people-proof types, canonical base64 sizes/fingerprints, FOR UPDATE; POST /api/accounting/companies no longer creates a company (405, onboarding only).
- 2026-10-17 (review round 2): entity-type check on every writer (incl. pis-score), judged by stored data size; 1 KB minimum on directors/documents routes; namesakes with different ID numbers allowed; sanitizer moved out; 60/hour attempt cap; complete.ts membership check.
- 2026-10-17 (review round 1): `/api/onboarding/complete` no longer finishes onboarding for a false flag; per-user request keys + 409; upload minimum/total caps, prefix check, logo + text caps; duplicate-people and registration-number rules; entity-type change proof check; entity-aware compliance alerts; PII-free body logs.
