# email-templates-practice-digest.ts

## Purpose
Daily practice digest email — lists overdue tasks and flags missing timesheets for a staff member, sent by the PRD-01 Phase 5B cron.

## Key exports
- `interface DigestTask` — `{ id, title, dueDate, daysOverdue, priority: 'low'|'normal'|'high'|'urgent', jobTitle, clientName }`
- `interface DigestPayload` — `{ recipientName, overdueTasks, missingTimesheetDate, appBaseUrl }`
- `renderPracticeDigestSubject(payload): string` — e.g. `Practice digest — 5 overdue, timesheet missing`
- `renderPracticeDigestHtml(payload): string` — full HTML with overdue-tasks table and optional missing-timesheet banner

## Dependencies
- `./email-templates-shared` — `BRAND`, `emailLayout`, `ctaButton`

## Critical notes
- All user-controlled strings (`recipientName`, task `title`, `jobTitle`, `clientName`, `dueDate`) are passed through a local `esc()` HTML-escaper before interpolation.
- Task rows with `daysOverdue > 7` render with a red-tinted background (`#fff1f2`).
- Priority colour map: low `#94a3b8`, normal `#64748b`, high `#f59e0b`, urgent `#ef4444`.
- Deep-link URLs use `encodeURIComponent` on the task id and date — safe against URL injection.
- When `overdueTasks` is empty AND `missingTimesheetDate` is null, the digest renders just the greeting — the cron should skip sending in that case (check via payload before calling this module).

## Recent changes
- 2026-04-19: Added during PRD-01 Phase 5B cron automation rollout (PR #27).
