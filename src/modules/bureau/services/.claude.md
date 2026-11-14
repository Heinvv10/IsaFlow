# bureau/services

Cross-client cockpit for accounting firms (bureaus). The `/bureau` page lands accountants on a deadline-aware, cross-client work queue aggregated over all companies in their bureau(s).

## Files
- `bureauService.ts` — bureau / bureau_companies / bureau_users membership CRUD (user-scoped, not tenant-scoped).
- `bureauWorkTypes.ts` — shared types + pure date helpers: `Severity`, `WorkItem`, `CompanyMeta`, `MonthEndStat`, `MONTHS`, `formatPeriod`, `endOfNextMonth`, `severityForDate`, `dedupeWorkItems` (collapses same company+task+dueAt, keeps first). Zero imports.
- `bureauWorkAggregatorService.ts` — the aggregator. Payroll, unreconciled-txn, and bills-to-approve signals + the month-end close-progress stat + `safeSignal` + `aggregateBureauWork`. Re-exports the shared types so API/test importers can keep importing from here.
- `bureauVatSignal.ts` — VAT-return-due signal (`shapeVatDue`, `vatDueSignal`), uses `vatPeriodHelper`.
- `vatPeriodHelper.ts` — pure SA VAT-cycle source of truth: `expectedVatPeriodAsOf` (bi-monthly AND monthly Cat C via the `cadence` param), `normalizeVatSetting`/`normalizeVatAlignment` (legacy rows store `'Bi-Monthly'`-style casing — ALWAYS normalize; `normalizeVatSetting` returns `'none'` for a company that is not a VAT vendor — `vat_period = 'none'` OR `vat_system_type = 'none'` — so every caller must decide what a non-vendor sees before it can reach a cadence-taking function; `isVatRegistered` is the boolean form), `vatQuickPeriods`/`defaultVatQuickPeriod` (consumed by `pages/accounting/sars/vat201.tsx` quick-period buttons). SARS semantics: `'odd'` = Category A = periods END in odd months (Jan/Mar/May/…), `'even'` = Category B = END in even months. The VatTab settings labels and the vat201 page were relabeled to match in 2026-06 (they previously said periods *start* odd/even — inverted).
- `complianceCalendarEngine.ts` — pure statutory due-date engine (Dotbiz Workstream E): VAT cycle (25th rule, monthly or bi-monthly; emits ONLY future-ending periods — `vatDueSignal` owns the just-ended one because it knows filing status), EMP201 (7th monthly, weekends pulled BACK to Friday per SARS; holidays out of scope), EMP501 (31 Oct interim / 31 May annual), IRP6 (last day of year-end month + 6 months prior, leap-aware), CIPC annual return (last day of anniversary month). Window `[today-grace(7d), today+horizon(90d)]`, UTC — due-today stays visible and missed deadlines linger as overdue for the grace period.
- `complianceSignal.ts` — signal over `company_compliance_obligations` (mig 494, opt-in: no row = no items) joined to `companies` for the VAT cycle; pure `shapeCompliance` + `complianceSignal`. VAT periods are disjoint from `vatDueSignal`'s by design; `dedupeWorkItems` (key incl. href) is drift insurance only. Monthly (Cat C) vendors are fully supported: `vatDueSignal` derives a one-month just-ended period from `companies.vat_period`, so a filed one-month return suppresses the item and the label is single-month (e.g. "May 2026").
- `complianceObligationsService.ts` — config CRUD (`getObligations`/`upsertObligations`/`validateObligations`) for `GET|PUT /api/accounting/compliance-obligations` and the company-settings Compliance tab.
- `bureauClientTriageService.ts` — pure roll-up: `rollupClientTriage(workItems: WorkItem[], roster: CompanyMeta[]): ClientTriage[]`. Groups already-aggregated work items by company into a single 4-tier traffic light per client: red (any overdue) > amber (any due_soon) > blue (info only) > green (clear). Sorted by light rank, then overdue desc, then name. Roster-driven — clear clients always produce a green row; items whose company is absent from the roster are ignored. No DB, no clock. Consumed server-side by `/api/bureau` (GET) and rendered by `ClientTriageBoard` on `pages/bureau/index.tsx`.

## Caller contract
`pages/api/bureau/index.ts` authenticates with `withUserAuth` (user-scoped, NOT the per-company `withAuth`), derives `companyIds` from `bureau_companies`, builds a `companyId → CompanyMeta` map, and calls `aggregateBureauWork(companyIds, meta, today)`. It returns `{ items: WorkItem[], monthEnd: MonthEndStat, clientTriage: ClientTriage[] }`. The `clientTriage` array is produced by `rollupClientTriage(items, roster)` and rendered by `ClientTriageBoard` above the flat feed on `pages/bureau/index.tsx`.

## Client home (Level 2)

`getBureauClientForUser(userId, companyId)` in `bureauService.ts` is the tenant gate for the per-client home page. It re-derives the caller's bureau companies and returns `CompanyMeta` only when `companyId` is in that set, else `null`. `GET /api/bureau/client/[companyId]` calls it first — a non-member `companyId` → immediate 404. On success the handler reads:

1. `clientMetricsSnapshot` (`bureauClientMetricsService.ts`) — accounting KPIs for the single verified company.
2. `aggregateBureauWork([companyId])` — work-queue items scoped to that one id.

Both reads are scoped to the single verified `companyId`; no new tenant surface is introduced. The path `companyId` is never trusted directly: it is always validated through the gate first. The metrics are the headline figures (`accounting/services/reports/headlineFigures`), the same numbers /accounting and Month-End show, as at the SAST day.

**Second consumer: `aggregateBureauWork` is also reused by the dashboard's "Needs attention" list (`accounting/services/dashboard/attentionService`, `GET /api/accounting/dashboard/attention`).** There, the caller is a non-bureau company user, so the gate is NOT `getBureauClientForUser`: `withAuth` validates `company_users` membership for the active company and supplies `req.companyId` (no URL-supplied id). That is an equivalent or stronger ownership check; the services themselves stay company-scoped and gate-agnostic. The list drops the feed's `/payroll/runs/...` and `/accounting/reports/bank-transactions` rows (it has its own) by href, so renaming either href here shows those rows twice on the dashboard.

## TENANT SAFETY (load-bearing)
These services run on the RLS-bypassing `@/lib/neon` pool (no `SET LOCAL ROLE app_user`). Isolation rests ENTIRELY on `company_id = ANY(${companyIds})`, where `companyIds` is derived ONLY from the caller's `bureau_companies`. Every signal query MUST keep that filter. Pure shapers additionally drop any row whose `company_id` is absent from the supplied `companyMeta` map. NEVER widen the company set inside a signal.

## Signals & stat
- Payroll: pending pay runs, IRP5 readiness, tax-directive renewals, leave approvals → `WorkItem[]`.
- Unreconciled txns: `bank_transactions` status NOT IN ('reconciled','matched','excluded') (matches the canonical `getUnreconciledBankTxns`).
- Bills to approve: `supplier_invoices.status='pending_approval'`, severity from earliest `due_date`.
- VAT due: no `vat_returns` row covers the expected just-ended period (bi-monthly, or one month for Cat C vendors per `companies.vat_period`); severity via the shared 7-day `severityForDate`.
- Month-end: `fiscal_periods` latest period per company; stat `{ closed, total }` (closed = status closed/locked). Index: `idx_fiscal_periods_company_end_date` (migration 490).
- Each signal degrades to empty on failure (`safeSignal`); the month-end stat has its own `.catch` fallback. One bad query can't 500 the cockpit.

## Bank-Tx Query Signal (Workstream D)
- `bankQuerySignal.ts` — `bankQuerySignal(companyIds, meta, today): Promise<WorkItem[]>` and pure `shapeBankQueries(rows, meta, today): WorkItem[]`. DB query groups by company, counts `replied` (highest priority — accountant must review) and `awaiting` (sent, not replied); `awaiting` only emits a `WorkItem` when the oldest-sent query is ≥3 days old. Registered in `bureauWorkAggregatorService.ts`. TENANT SAFETY: same `company_id = ANY(${companyIds})` guard + pure shaper drops unknown company_ids.

## Owner Cash Position (Workstream G)

`ownerCashPositionService.ts` answers "can I pay salaries" and "VAT set-aside" for the dashboard's "Needs attention" list. Two fail-soft sections (payroll, VAT), each degrades to null on error. Payroll reads the earliest open run of this SAST month or the month before (`PAY_RUN_WINDOW_MONTHS_BACK` in `bureauWorkTypes.ts`), never an older one. Deliberate exception: this is the only bureau service importing from accounting services (VAT); if a second such service appears, move the cluster to accounting/dashboard.

## Merchant-pattern sharing (Hein, 2026-10-21)
- **Owner = `bureaus.owner_user_id`**, never `bureau_users.role`: a bureau_users 'owner' row for anyone else reads as accountant and is refused (403); the owner_user_id user is allowed even with no bureau_users row. Checked by `getBureauRole` and re-checked with the bureau row locked in `setBureauSharingSetting`.
- **Hard gate `MERCHANT_SHARING_ENABLED`** (`merchantSharingGate.ts`, default off when unset; only `true` turns it on): the POPIA consent copy (`sharingConsentCopy.ts`) is a **DRAFT pending legal review**. While off: switching ON is a 409 `sharing_pending_legal_review` for the owner (checked after ownership, so a non-owner still gets 403, and "on" for a bureau already on is a no-op); switching OFF always works; GET reports `sharingAvailable: false` and the page shows "Coming soon - pending legal review" (or "On (paused pending legal review)" for a bureau stored on, since nothing pools); `poolEligibility` treats every bureau as not opted in (empty eligible set). Turn it on only after legal signs off the wording. The shared pool (PR 2, `accounting/services/sharedPool/`) checks the gate itself too: the job skips with no read or write, the admin recompute is a 409 `sharing_pending_legal_review`, the reader returns nothing; see `docs/security/shared-merchant-patterns.md`. `share_merchant_patterns` defaults to false for every bureau, existing rows included (mig 904 ADD COLUMN ... DEFAULT false).

## Tests
`tests/unit/bureau/*` — pure shapers (`shapeUnreconciled`, `shapeBillsToApprove`, `shapeVatDue`, `reduceMonthEnd`), the VAT period helper, and tenant-guard cases (shapers drop unknown company_ids). No DB/RTL (repo vitest is `environment: 'node'`).

## Company delegation authorization

`linkCompanyToBureau({ bureauId, companyId, addedBy }): Promise<boolean>` is re-exported from `bureauCompanyLinkService.ts` and runs on the migration_admin pool (932). New links require both ownership of the bureau and owner/admin membership of the target company. The company must not be suspended/deleted or carry a suspension timestamp. One SQL statement checks these conditions and inserts; authorized repeated links return true without duplicating the row. False means no authority (the API returns403). A bureau membership or a company viewer/accountant role is insufficient to grant bureau-wide access.

Existing links remain durable delegations until unlink; losing the grantor's direct company membership does not automatically remove the bureau. Historical links predating this check need consent review, not automatic deletion based on current membership. Bureau members can consume authorized links without their own company_users row. The trusted company-ID set on reads is unchanged.
