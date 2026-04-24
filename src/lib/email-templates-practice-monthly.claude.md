# email-templates-practice-monthly.ts

## Purpose
Monthly practice management report email — KPI grid, top-staff utilisation, top-clients, and WIP-aging snapshot. Sent by the PRD-01 Phase 5B cron.

## Key exports
- `interface MonthlyReportPayload` — `{ recipientName, companyName, periodLabel, totals, utilisation[], topClients[], wipAging[], appBaseUrl }`
- `renderMonthlyReportSubject(payload): string` — e.g. `Monthly Practice Report — Acme, March 2026`
- `renderMonthlyReportHtml(payload): string` — full HTML with 4 KPI cards, three tables, and "View Full Report" CTA

## Dependencies
- `./email-templates-shared` — `BRAND`, `emailLayout`, `ctaButton`

## Critical notes
- All user-controlled strings go through the local `esc()` HTML-escaper.
- Currency formatting: `R` prefix, `en-ZA` locale, 2 decimals. Hours: `Xh` with 1 decimal. Percent: 1 decimal.
- Utilisation colour thresholds: ≥75% green `#16a34a`, ≥50% amber `#ca8a04`, otherwise red `#dc2626`.
- Tables are truncated to top-5 rows (staff, clients, WIP aging ≥31 days).
- WIP aging section only renders rows where `bucket31plus > 0`; section is omitted entirely when no aged client.
- `reportUrl` embeds `periodLabel.replace(' ', '-')` — crude; a period containing multiple spaces would break the query string. Payload is cron-generated so this is acceptable.
- `recipientName` nullable — when null the greeting becomes "Practice Report" instead of "Hi <name>,".

## Recent changes
- 2026-04-19: Added during PRD-01 Phase 5B cron automation rollout (PR #27).
