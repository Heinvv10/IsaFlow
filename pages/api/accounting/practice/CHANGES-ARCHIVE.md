# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-11-11 (audit P2.5 item 2): `wip/invoice` accepts optional `dueDate` (`z.iso.date()`) and `notes` (trimmed, max 2000); a due date before the invoice date is a 400 refusal. `GET wip` answers a malformed `practiceClientId` 400 via `isUuidParam` (was a 500 from the `::UUID` cast). Caller: `/accounting/practice/generate-invoice`.
- 2026-10-02 (PR #621 review): bulk refuses a non-UUID `jobId` (400 "jobId must be a UUID"); duplicate refuses a non-UUID `id`; a non-UUID jobId anywhere gets the fixed refusal "The job was not found for this client" before any SQL (it used to echo the caller's text)
- 2026-10-02 (review round 6): bulk refuses dates before 1900 (Date.UTC maps 0050 to 1950); duplicate refuses an impossible `newDate` with 400 before any SQL; PUT `entryDate: null` keeps the date
- 2026-10-02 (review round 5): bulk refuses malformed dates and a non-number `hoursOverride`; time-entries POST/PUT refuse an entry date that is not a real date (e.g. year 10000) with 400
- 2026-10-02 (review round 4): bulk — refusals-only per-date failures, 500 + rollback for any database error, 400 for bad templateId / weekdays / NUL
- 2026-10-02 (review round 2): mid-request job move → 400 (not 500); bulk per-date savepoint + sanitised failure text; body guard on bulk and duplicate
- 2026-10-02 (review round 1): closed-job and job-move refusals, bulk `jobId`, typed budget 400, body/jobId guards
- 2026-10-02: Engagement Budgets — `reports/engagement-budgets`; `jobId` on time entries is now written and fenced (400 on a foreign/other-client job); `budgetAmount` on jobs
- 2026-09-30: R-170 — `''` for `clientGroupId`/`linkCustomerId` no longer 500s on the `::UUID` cast (create stores NULL, update clears); `clients/[id]` gained an `isUuidParam` guard so a malformed route id is 400, not 500
- 2026-09-30: R-161 — client group ownership fence on the clients POST / `[id]` PUT; R-163 — rate-overrides route uses the R-073 fence, malformed id → 400
- 2026-09-29 (R-123): `clients/[id]/rate-overrides` and `clients/[id]/staff` no longer 500 where app_user cannot read `auth.users`: staff names come from migrations 715/716 (company-bound SECURITY DEFINER). The staff list follows `cu_select` — owner/admin see every member, a manager only themselves.
- 2026-09-29: R-073 — practice client ownership fence on the contact, job-update and entry-template writes
- 2026-04-22: 4 Bugsink-surfaced regressions
- 2026-04-20: PRD-01 Phase 5A — bulk CSV import + export for clients
- 2026-04-19: PRD-01/02/03 — rate overrides, leave, IRP5, EMP501, period close
- 2026-04-19: PRD-01 Phase 5B — cron automation (recurring tasks, digest, monthly reports) (#27)
