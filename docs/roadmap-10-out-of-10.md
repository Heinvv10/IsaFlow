# ISAFlow 10/10 Roadmap

Last updated: 2026-04-26

## Goal

Move ISAFlow from a broad, credible platform to a product that feels dependable, polished, demo-ready, and operationally mature.

The path to 10/10 is not more module breadth first. It is trust, polish, reliability, and sharper workflows.

## Phase 0 - Immediate Trust Fixes

Target: 1-2 days

These are credibility breakers and should be fixed before new feature work.

- Fix production admin routing so `/admin/*` never redirects to `localhost`.
- Remove or merge the duplicate `/api/accounting/tax-directives` route.
- Document the canonical production host values for app, admin, API, and cookie domains.
- Refresh demo seed data so dashboard aging and overdue items look current.
- Add a route smoke test covering login, dashboard, customers, suppliers, reports, payroll, settings, and admin redirects.

Exit criteria:

- `https://isaflow.co.za/admin/companies` redirects only to the public admin host.
- No duplicate Next route warnings on startup.
- The demo company shows current-period dates and believable action items.
- Smoke test produces a simple pass/fail report.

## Phase 1 - Developer And Release Confidence

Target: 3-5 days

The repo should be easy to boot, test, and verify from a clean checkout.

- Align Node, Bun, Vitest, and Next requirements in `package.json`, docs, and CI.
- Make `bun run test:unit` runnable on the documented runtime.
- Add a safe local/demo environment profile that does not require production secrets.
- Reduce ESLint warnings from 68 to 0, prioritising hook dependencies and API `any` usage.
- Fail CI on duplicate routes, type errors, lint errors, and smoke test failures.
- Keep `type-check`, `lint`, unit tests, and a production build in the default pre-merge path.

Exit criteria:

- A new developer can run install, dev, type-check, lint, and unit tests from the docs.
- CI and local checks agree on supported runtime versions.
- `bun run lint` has no warnings.

## Phase 2 - UI System Consolidation

Target: 1-2 weeks

The app currently has a strong shell but too many surfaces share the same visual weight. Consolidate card usage into strict primitives.

Canonical surface types:

- `PageHeader`: page identity, subtitle, primary actions.
- `KpiStrip`: compact metrics with strong scan hierarchy.
- `DataTableShell`: filters, count, table, pagination, empty state.
- `FormSection`: labelled form group with clear required/optional fields.
- `DetailPanel`: read-only record facts, status, and audit metadata.
- `ActionPanel`: high-priority next actions and warnings.

Migration order:

1. Accounting dashboard.
2. Customers and suppliers.
3. Reports index and report detail pages.
4. Payroll employees and payroll run pages.
5. Admin companies and billing pages.

Exit criteria:

- Core screens use shared primitives rather than bespoke card styling.
- Primary actions are visually obvious within two seconds.
- Empty states include a useful next action and no dead space.
- Screenshots across desktop and mobile show no text overlap or awkward card stacking.

## Phase 3 - Gold Demo Journey

Target: 1 week

Build a curated story that proves ISAFlow in one clean walkthrough.

Recommended journey:

1. Login as demo admin.
2. Review dashboard action items.
3. Open a customer and invoice.
4. Import or review bank transactions.
5. Match/reconcile a transaction.
6. Review VAT/report output.
7. Open payroll employees and a payroll run.
8. Show admin company health or audit visibility.

Data requirements:

- Current dates in the active financial period.
- Realistic South African customer/supplier names.
- A small number of meaningful overdue items, not thousands of days old.
- At least one bank account with transactions.
- One payroll period in a sensible status with supporting employees.

Exit criteria:

- The demo route can be completed in under 8 minutes.
- Every screen in the journey has useful data.
- No dead ends, 404s, browser errors, or obviously stale values.

## Phase 4 - Workflow Excellence

Target: 2-4 weeks

Make each major module feel excellent at one flagship workflow.

- Sales: create invoice, send, receive payment, view ledger impact.
- Banking: import, match, reconcile, explain unmatched items.
- Payroll: prepare, validate, approve, export/post.
- Reports: generate, drill down, export.
- Admin: company health, user access, billing status, impersonation audit trail.
- Capture: upload, extract, review, post, attach evidence.

Exit criteria:

- Each flagship workflow has an owner, acceptance tests, and a demo script.
- Error states explain recovery, not just failure.
- Keyboard and bulk workflows are smooth for high-volume users.

## Phase 5 - Production Hardening

Target: ongoing

- Add synthetic uptime checks for login, app shell, admin shell, and core APIs.
- Track Core Web Vitals and slow API routes by tenant-safe metadata.
- Add database query budget checks for heavy reports.
- Review CSRF coverage for all mutating routes.
- Review externally reachable webhooks and portal routes for signature/token validation.
- Add dependency/security update cadence.

Exit criteria:

- Production failures are detected before users report them.
- Security-sensitive route classes have explicit test coverage.
- Heavy reports and imports degrade gracefully under load.

## Scoring Model

Use this every two weeks to keep the roadmap honest.

| Category | Target |
| --- | ---: |
| Product depth | 9.5 |
| Live UX/UI | 9.2 |
| Architecture | 9.0 |
| Security posture | 9.2 |
| Reliability and release readiness | 9.0 |
| Maintainability | 8.8 |
| Demo readiness | 9.5 |

10/10 does not mean perfect. It means the product is trustworthy enough that defects feel exceptional, not expected.
