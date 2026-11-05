# email-templates-budget-digest.ts

## Purpose
The budget overspend digest email (budgets P5-4): the alerts a daily run newly fired, one table row each, sent to each owner/admin by `budgets/overspendDigest.ts`. OFF unless the company flag AND env `BUDGET_ALERT_EMAIL_ENABLED=1`.

## Key exports
- `BudgetDigestAlert`, `BudgetDigestPayload` (`companyName, recipientName, alerts, appBaseUrl`)
- `renderBudgetDigestSubject(payload)`: `Budget alerts — <company>: N new overspend alert(s)`; line breaks in the company name are collapsed (a header, not HTML).
- `renderBudgetDigestHtml(payload)`, `escapeHtml`.

## Critical notes
- Every value from the books (company, recipient, account, slice, month, amounts, the link) is escaped before it is placed, text or attribute; links are `appBaseUrl` + the alert's in-app path.
- Unit test: `tests/unit/services/budgets/overspendDigest.test.ts` (hostile strings in every field).

## Recent changes
- 2026-11-03: added (budgets P5-4).
