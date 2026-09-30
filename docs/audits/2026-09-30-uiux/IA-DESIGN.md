# IsaFlow — Information Architecture & Navigation Design (proposal)

Owner review draft · 2026-09-30 · Base: worktree `uiux-plan` @ `3591a6380`. The page tree is identical to the audited `66e776d81`: `git diff 66e776d81 HEAD -- pages ':!pages/api'` is empty.
Inputs: `findings/journey.md`, `findings/navcode.md` (+ `navcode/table.md`, `navcode/active.txt`), `findings/benchmark.md`, `rows.json` (349 findings), plus the code cited inline.

## The strongest argument against this proposal

This is a navigation and IA redesign for a product whose audit found **53 P0s, and most of them are wrong numbers, not wrong menus**. Examples: six cash figures (RPT-01), AR subledger R10.8M against a GL control of R154k (RPT-10, LED-05), asset cost missing from the GL (LED-04), and a calendar that never marks a return filed (TAX-01). A cockpit that puts these numbers on the first screen makes the product look *worse* until the ledger issues are fixed. A new rail also changes the muscle memory of every live tenant, and it will be built by parallel agent sessions on a repo where drift is already the main failure mode. The honest counter-case is "fix the numbers and the dead ends; leave the chrome alone for a quarter".

This plan takes that seriously in three ways:
- The first four PRs change **no layout**. They fix the dead ends and make every landing number come from the existing figure registry.
- The cockpit shows reconciliation gaps as exceptions instead of hiding them.
- The new shell ships behind a per-user flag, with **no URL changes**.

If the owner only funds PR-01 to PR-04, most of the "things lie to me" complaints still go away.

---

## 1. Personas and top jobs

| Persona | Who | Lands today | Top jobs (in order) |
|---|---|---|---|
| **Practice accountant** (bureau member, 5–200 client companies) | Partner, manager or clerk in an SA accounting firm | `/bureau`, via `src/lib/auth/resolveLanding.ts:16`. Not in the nav afterwards (NAV-09, BMK-01) | 1. See what needs attention across all clients today (SARS dates, close blockers, client replies, AI proposals). 2. Clear one client's queue: code bank lines, approve proposals, reconcile. 3. Run month-end and VAT/EMP201 per client. 4. Run payroll for payroll clients. 5. Log time, bill WIP and fixed fees, see whether each client is profitable. 6. Produce the client pack and AFS. |
| **Business owner / in-house bookkeeper** (direct client, 1–3 companies) | SME owner or their bookkeeper | `/home` (`resolveLanding.ts:17`). Orphaned after the first click (JRN-11) | 1. "Can I pay salaries / VAT / suppliers?" 2. Invoice and get paid. 3. Capture bills and receipts. 4. Answer the accountant's questions. 5. Run payroll if they do it themselves. |

Design consequence: **two scopes, one shell.**
- **Firm** scope contains everything that spans clients. It is shown only to bureau members.
- **Books** scope contains everything inside one company. Both personas see it.
- The owner persona never sees Firm.

---

## 2. Proposed information architecture

### 2.1 Shape

```
┌ Top bar ─────────────────────────────────────────────────────────────────────┐
│ [Scope: Firm ▾ | Brightsphere ▾]  [ Search / Ask  Ctrl+K ]  [+]  [Inbox 12] [avatar ▾] │
└──────────────────────────────────────────────────────────────────────────────┘
┌ Left rail (from registry) ┐┌ Breadcrumb (from registry) ─────────────────────┐
│ FIRM (bureau members)     ││ Brightsphere › Sales › Invoices › INV0004208     │
│  Today                    │├──────────────────────────────────────────────────┤
│  Clients                  ││ PageHeader (title · status · primary actions)    │
│  Work (jobs·tasks·dates)  ││                                                  │
│  Time & Billing           ││ page                                              │
│  Firm reports             ││                                                  │
│ BOOKS (active company)    ││                                                  │
│  Overview · Inbox (n)     ││                                                  │
│  Close                    ││                                                  │
│  Banking (n to review)    ││                                                  │
│  Sales · Purchases        ││                                                  │
│  Payroll* · Tax           ││                                                  │
│  Ledger · Reports         ││                                                  │
│  Inventory*               ││                                                  │
│ ─ Settings · All pages    ││                                                  │
└───────────────────────────┘└──────────────────────────────────────────────────┘
 * shown only when the company has employees / stock items (data-gated, like vatNav.ts does for VAT)
```

What it replaces:
- **The 5-tab front door and the 179-link Library flyout** (NAV-17, `accountingNavConfig.ts:30-36`, `navSections/library.ts`). Today's module sub-nav (`SecondaryModuleNav.tsx`) becomes the rail group's expanded sections.
- **The Settings cog mega-menu** (SET-07, JRN-24). It becomes a `/settings` hub page holding configuration only.
- **The Library landing** (`/accounting/library`). It becomes a searchable, registry-generated "All pages" index (JRN-32).

**Principle: URLs do not move.** The IA lives in a route registry, not in the folder tree. The only new routes are `/today`, `/accounting/inbox`, `/accounting/practice` (a 404 today, PRC-04), `/payroll` (a redirect today, `next.config.js:93`) and `/settings`. Retired pages become `next.config.js` redirects. Bookmarks, e2e specs and emailed links all keep working.

### 2.2 Page map: every page file in `pages/` (365 excluding `_app`/`_document`/`api`)

Legend:
- **KEEP**: same URL, new nav home.
- **MERGE→X**: consolidate into X, then redirect.
- **RETIRE→X**: redirect only.
- **RELINK**: orphaned or link-only today.
- **NEW**: new route.

The reach and orphan status come from `findings/navcode.md` (every route in the tree appears in its table; verified by `comm` against the tree).

**FIRM scope**

| Current route(s) | Reached today via | New home | Action / finding |
|---|---|---|---|
| — | — | Firm › **Today** `/today` | **NEW**. The cockpit, see §3.1 |
| `/bureau` | login landing only | Firm › Today | **MERGE→/today** (NAV-09, BMK-01) |
| `/accounting/portfolio-workbench` | Portfolio tab | Firm › Today (health grid) | **MERGE→/today** (JRN-12) |
| `/bureau/clients` | link from /bureau | Firm › Clients | **MERGE→/accounting/practice/clients**. One client list (BMK-02) |
| `/bureau/clients/[companyId]` | link | Firm › Clients › client 360 "Books" tab | **MERGE→practice/clients/[id]** |
| `/accounting/practice/clients`, `/new`, `/[id]` | Library › Practice | Firm › Clients | KEEP. Add edit, links and 360 tabs (PRC-01/04/06) |
| `/accounting/practice/jobs`, `/new`, `/[id]` | Library › Practice | Firm › Work › Jobs | KEEP |
| `/accounting/practice/tasks` | Library › Practice | Firm › Work › Tasks | KEEP |
| — | — | Firm › Work › Deadlines | **NEW**. Cross-client view over `complianceCalendarEngine.ts` |
| `/accounting/practice/time-entry` | Library › Practice | Firm › Time & Billing › Time | KEEP. Becomes day, week and timer (PRC-09) |
| `/accounting/timesheets`, `/accounting/time-tracking` | Settings cog, "My Timesheet" | — | **RETIRE→/accounting/practice/time-entry?view=week** (NAV-14, PAY-15) |
| `/accounting/practice/approvals` | Library › Practice | Firm › Time & Billing › Approvals | KEEP (counts also feed Inbox) |
| `/accounting/practice/wip` | Library › Practice | Firm › Time & Billing › WIP | KEEP. Drop the no-op "Generate Invoice" item (PRC-14) |
| — | — | Firm › Time & Billing › Engagements & fees | **NEW** (§5.1, PRC-03/27) |
| `/accounting/practice/reports` | **ORPHAN** | Firm › Reports (landing) | **RELINK** (NAV-08) |
| `/accounting/practice/reports/{utilisation,profitability,wip-aging,revenue-pipeline,compliance,service-mix}` | Library › Practice | Firm › Reports | KEEP. Rename "compliance"→"Timesheet compliance" and "revenue-pipeline"→"WIP forecast" (PRC-11) |
| `/accounting/practice/{job-categories,staff-rates,staff-cost-rates,report-recipients}` | Library › Practice › Admin | Settings › Practice | KEEP |

**BOOKS scope: Overview, Inbox, Close**

| Current route(s) | Reached today via | New home | Action / finding |
|---|---|---|---|
| `/accounting` | Dashboard tab | Books › **Overview** | KEEP URL. Rebuilt as the client cockpit (§3.2). Remove the CoA, Journals, Periods and Reports tabs (NAV-19, RPT-13) |
| `/home` | direct-client login only | Books › Overview | **MERGE→/accounting** (JRN-11). Its owner cash questions become the Overview's owner variant |
| — | — | Books › **Inbox** `/accounting/inbox` | **NEW** (NAV-31) |
| `/accounting/approvals` | Settings cog | Books › Inbox › Approvals | KEEP (PUR-18) |
| `/accounting/auto-postings` | Ledger › Journals | Books › Inbox › Agent activity | KEEP (NAV-30) |
| `/accounting/month-end-workbench` | Month-End tab | Books › **Close** | KEEP. Cards carry `?period=` (JRN-07) |
| `/accounting/financial-years`, `/accounting/year-end` | Accounting › Periods | Books › Close › Financial year-end | **MERGE→financial-years** (year-end becomes a step). NAV-32 year-end row, LED-16 |
| `/accounting/audit-packs` | Reports › Audit ("Evidence Packs") | Books › Close › Evidence packs | KEEP. Retitle so it stops clashing with "Audit Trail" (JRN-23) |

**BOOKS: Banking**

| Current route(s) | New home | Action |
|---|---|---|
| `/accounting/bank-accounts` | Banking › Accounts | KEEP (cards show work, BNK-34) |
| `/accounting/bank-transactions`, `/new` | Banking › To review | KEEP. URL state (BNK-07) |
| `/accounting/bank-reconciliation`, `/new`, `/[reconId]` | Banking › Reconcile | KEEP |
| `/accounting/bank-reconciliation/import`, `/accounting/bank/statements`, `/accounting/bank/statements/import-pdf` | Banking › Statements & imports | **MERGE** into one hub at `/accounting/bank/statements`; import-pdf becomes a step (BNK-13). `/bank-reconciliation/import` redirects |
| `/accounting/bank-reconciliation/rules` | Banking › Rules | KEEP. One label (BNK-29) |
| `/accounting/bank/queries` | Banking › Client queries (+ Inbox) | KEEP. Fixes the Dashboard highlight (BNK-08) |
| `/accounting/bank/provisional` | Banking › Provisional | KEEP |
| `/accounting/bank-transfers` | Banking › Transfers | KEEP |
| `/accounting/cashbook` | Banking › Cashbook | KEEP (BNK-01 is data, not IA) |
| `/accounting/bank-feeds` | Banking › Feeds | KEEP |
| `/accounting/netcash` | Banking › Payments (Netcash) | KEEP |

**BOOKS: Sales**

| Current route(s) | New home | Action |
|---|---|---|
| `/accounting/customers`, `/new`, `/[customerId]`, `/dedup`; `/accounting/customer-categories` | Sales › Customers | KEEP. Customer 360 (SAL-06) |
| `/accounting/sales-reps` | Sales › Customers (setup) | **RELINK** (orphan, SAL-11) |
| `/accounting/customer-quotes` | Sales › Quotes | KEEP (create via `?new=1`, §4.4) |
| `/accounting/customer-sales-orders`, `/[id]`; `/accounting/delivery-notes`, `/new`, `/[id]` | Sales › Orders & delivery | KEEP |
| `/accounting/customer-invoices`, `/new`, `/[invoiceId]`, `/edit/[invoiceId]`; `/accounting/recurring-invoices`, `/new`, `/[id]` | Sales › Invoices | KEEP |
| `/accounting/credit-notes`, `/new`, `/[creditNoteId]` | Sales › Credit notes | KEEP. Customer credit notes only (SAL-15) |
| `/accounting/customer-payments`, `/new`, `/[paymentId]` | Sales › Receipts | KEEP |
| `/accounting/customer-allocations`, `/accounting/ar/receipt-match` | Sales › Receipts › Allocate | **MERGE** into one allocate view with an auto-match tab (SAL-17) |
| `/accounting/debtors-manager`, `/accounting/ar-aging` | Sales › Collections | KEEP. `ar-aging` is the one aging (NAV-32) |
| `/accounting/reports/ar-aging` | — | **RETIRE→/accounting/ar-aging** (NAV-32, SAL-18) |
| `/accounting/customer-statements`, `/[clientId]`, `/accounting/customers/statement`, `/accounting/statement-run`, `/accounting/statements` | Sales › Collections › Statements | **MERGE→/accounting/customer-statements** (preview, then batch download or email as a mode; NAV-32) |
| `/accounting/ar/dunning`, `/runs`; `/accounting/disputes`; `/accounting/write-offs` | Sales › Collections | KEEP |
| `/accounting/dunning` | — | **RETIRE→/accounting/ar/dunning** (stub; NAV-28) |
| `/accounting/ar/settings/sent-mirror` | Settings › Email | KEEP. Fix the dead crumb (NAV-15) |
| `/accounting/adjustments` (`?type=customer\|supplier`) | Sales › Adjustments / Purchases › Adjustments | KEEP. Registry `variant` by `type`. No type falls to Ledger |

**BOOKS: Purchases**

| Current route(s) | New home | Action |
|---|---|---|
| `/accounting/suppliers`, `/new`, `/[supplierId]`, `/dedup`; `/accounting/supplier-categories` | Purchases › Suppliers | KEEP (supplier 360, PUR-19) |
| `/accounting/suppliers/rules`, `/[supplierId]/rules` | Purchases › Coding rules | KEEP |
| `/accounting/suppliers/expectations` (ORPHAN), `/accounting/suppliers/missing-invoices` (link-only) | Purchases › Expected & missing bills | **RELINK + MERGE** into one page (NAV-07, PUR-17) |
| `/accounting/purchase-orders`, `/new`, `/[poId]`; `/accounting/goods-received`, `/new` | Purchases › Orders & receiving | KEEP |
| `/accounting/supplier-purchase-orders`, `/[poId]` | — | **RETIRE** after the data decision (PUR-06, Q3) |
| `/accounting/supplier-invoices`, `/new`, `/[invoiceId]`; `/accounting/supplier-returns` | Purchases › Bills | KEEP |
| `/accounting/supplier-credit-notes`, `/new`, `/[id]` | Purchases › Credit notes | KEEP |
| `/accounting/supplier-payments`, `/new`, `/[paymentId]`; `/accounting/batch-payments`, `/new`, `/[batchId]`; `/accounting/supplier-allocations` | Purchases › Payments | KEEP |
| `/accounting/ap-aging` | Purchases › Payables | KEEP |
| `/accounting/reports/ap-aging` | — | **RETIRE→/accounting/ap-aging** (PUR-22) |
| `/accounting/supplier-statements`, `/[supplierId]` + `/accounting/ap/supplier-statements`, `/[id]` | Purchases › Statements (Balances · Reconcile tabs) | **RELINK** reconciliation as a tab (NAV-07, PUR-17) |
| `/accounting/capture/inbox`, `/accounting/capture`, `/capture/settings`, `/capture/settings/mirror`; `/accounting/fraud/signals` | Purchases › Capture | KEEP (camera becomes an action). Fixes the highlight (PUR-15) |
| `/accounting/document-capture`, `/[docId]` | — | **MERGE→/accounting/capture/inbox** (NAV-32, PUR-08) |
| `/accounting/expenses`, `/new`, `/[id]` | Purchases › Expense claims | KEEP |

**BOOKS: Payroll** (data-gated)

| Current route(s) | New home | Action |
|---|---|---|
| `/payroll` (redirect today) | Payroll › This month | **NEW** stepper home. Delete `next.config.js:93-94` (PAY-25) |
| `/payroll/runs`, `/new`, `/[id]`, `/[id]/variance`, `/[id]/cost-centre-summary`, `/[id]/cash-register` | Payroll › Pay runs | KEEP |
| `/payroll/employees`, `/new`, `/[id]`, `/bulk-update`; `/payroll/duplicates` | Payroll › Employees | KEEP |
| `/payroll/leave`, `/new`, `/[id]`, `/balances` | Payroll › Leave | KEEP. Move out of "Setup" (PAY-19) |
| `/payroll/loans`, `/new`, `/[id]`; `/payroll/batches`, `/new`, `/[id]` | Payroll › Inputs | KEEP |
| `/accounting/sars/emp201` | Payroll › Statutory › EMP201 (Tax cross-links) | KEEP URL, single home Payroll (PAY-10, TAX-14) |
| `/payroll/emp501`, `/irp5`, `/uif`, `/tax-directives`, `/equity/eea2`, `/training`, `/training/wsp-atr`, `/compliance` | Payroll › Statutory | KEEP. Payroll stays the active group (PAY-10) |
| `/payroll/year-end` | Payroll › Statutory › Tax year-end | **UNSHADOW**: delete `next.config.js:95` (NAV-02, PAY-02) |
| `/payroll/parallel-run` | Payroll › Tools | KEEP |
| `/payroll/components`, `/pay-scales`, `/pay-packages`, `/[id]`, `/cost-centres` | Payroll › Setup | KEEP |

**BOOKS: Tax**

| Current route(s) | New home | Action |
|---|---|---|
| `/accounting/sars` | Tax › Calendar | KEEP |
| `/accounting/sars/vat201`, `/vat-locks` | Tax › VAT201 (Locks tab) | KEEP (winner: it has locks, exceptions and submit) |
| `/accounting/reports/vat-return` | — | **MERGE→/accounting/sars/vat201** only after TAX-05 (different payable figures) is settled (Q3) |
| `/accounting/reports/vat-reconciliation`, `/accounting/vat-adjustments`, `/accounting/drc-vat` | Tax › VAT | KEEP |
| `/accounting/sars/submissions` | Tax › Submissions | KEEP |

**BOOKS: Ledger** (renamed from "Accounting"; the whole app is accounting, LED-25)

| Current route(s) | New home | Action |
|---|---|---|
| `/accounting/chart-of-accounts` | Ledger › Accounts | KEEP. Rows open account detail (LED-18) |
| `/accounting/journal-entries`, `/new`, `/[entryId]`; `/accounting/recurring-journals`; `/accounting/recurring-transactions` (Settings cog today) | Ledger › Journals | KEEP. `journal-entries` becomes a real paged list, not a redirect to `/accounting?tab=` (NAV-19, LED-10) |
| `/accounting/trial-balance`, `/accounting/opening-balances` | Ledger › Balances | KEEP. One home each (NAV-18; opening balances is listed 3× today) |
| `/accounting/fiscal-periods` | Ledger › Periods | KEEP |
| `/accounting/audit-log` | Ledger › Change log | KEEP. Retitle (NAV-32 audit-trail row) |
| `/accounting/assets`, `/new`, `/[assetId]`, `/categories`, `/disposals`, `/register`, `/far-report`, `/below-threshold`; `/accounting/depreciation` | Ledger › Fixed assets | KEEP |
| `/accounting/loans`, `/new`, `/[id]`, `/rate-curves`, `/period-close` | Ledger › Loans | KEEP. Fixes the highlight (LED-15) |
| `/accounting/cost-centres`, `/business-units`, `/budgets` | Ledger › Management accounting | KEEP |
| `/accounting/currencies`, `/accounting/exchange-rates` (both ORPHAN) | — | **MERGE** the manage functions into `/accounting/settings/currencies` and `/settings/exchange-rates`, then RETIRE (NAV-08, SET-08) |

**BOOKS: Reports** (`/accounting/reports` is the group landing; it has no menu entry today, NAV-11)

| Current route(s) | New home | Action |
|---|---|---|
| `/accounting/reports` | Reports (hub, searchable, recents) | KEEP (RPT-14) |
| `/reports/{income-statement,balance-sheet,cash-flow,general-ledger,account-detail/[accountId],account-transactions,bank-transactions,journal-entries,audit-trail}` | Reports › Financial & ledger | KEEP. `audit-trail` retitled "Journal audit trail" |
| `/reports/cash-movement` (ORPHAN) | Reports › Financial | RELINK after RPT-01, or RETIRE |
| `/reports/{cash-flow-forecast,three-way-forecast}` + `/accounting/cash-flow-forecast` (ORPHAN) | Reports › Forecasts | **MERGE** the orphan's UI into the `/reports/` URL (NAV-32, RPT-05/09) |
| `/reports/{executive-dashboard,financial-analysis,trend-analysis,waterfall,budget-vs-actual,project-profitability,management-accounts}` | Reports › Management | KEEP (hub-only today) |
| `/reports/report-packs`, `/accounting/afs/management-packs`, `/reports/present/[pack]` | Reports › Client packs | **MERGE** into one pack object (RPT-12) |
| `/reports/{sales-by-customer,customer-ledger,unallocated-receipts}`; `/reports/customer-reports`; `/reports/customer-communication` (ORPHAN) | Reports › Sales | customer-reports **MERGE→sales-by-customer** (RPT-15). customer-communication RELINK or RETIRE |
| `/reports/{purchases-by-supplier,supplier-ledger,supplier-pos,unallocated-payments}`; `/reports/supplier-reports` | Reports › Purchases | supplier-reports **MERGE→purchases-by-supplier** (RPT-15) |
| `/accounting/afs`, `/[documentId]`, `/[documentId]/compliance`, `/portal-contacts`, `/mapping` (ORPHAN), `/report-templates` (ORPHAN), `/pis-score` (ORPHAN); `/reports/disclosure-notes`, `/reports/caseware-export` | Reports › AFS | **RELINK** the three orphans (NAV-07) |
| `/reports/builder`, `/reports/my-reports` | Reports › Custom | KEEP |
| `/accounting/group`, `/setup`, `/trial-balance`, `/income-statement`, `/balance-sheet`, `/intercompany`, `/eliminations`; `/accounting/consolidation` | Reports › Group | Move out of Settings (JRN-24). `consolidation` **MERGE→/accounting/group** (RPT-21, SET-12) |

**BOOKS: Inventory** (data-gated, INV-10)

| Current route(s) | New home | Action |
|---|---|---|
| `/accounting/items`, `/new`, `/[itemId]`, `/item-categories`, `/item-adjustments`, `/item-pricing`, `/item-opening-balances`, `/stock-levels`; `/reports/{item-listing,item-movement,item-quantities,item-valuation,sales-by-item,purchases-by-item}` | Inventory | KEEP. Item reports are cross-listed in the Reports hub |
| `/accounting/products`, `/new`, `/[productId]` | — | **RETIRE** after the data migration (INV-01, Q3) |

**Settings hub** `/settings` (NEW landing; existing URLs kept)

| Current route(s) | New home |
|---|---|
| `/accounting/company-settings` | Settings › Company (tabs in the URL, SET-14) |
| `/accounting/user-access` | Settings › Users & security |
| `/accounting/my-account` | Avatar menu (JRN-23) |
| `/accounting/accounting-settings`, `/default-accounts`, `/settings/account-reporting-groups`, `/settings/currencies`, `/settings/exchange-rates` | Settings › Accounting |
| `/accounting/duplicates`, `/data-archiving` | Settings › Data quality |
| `/accounting/migration` + `/{ap-invoices,ar-invoices,chart-of-accounts,customers,suppliers,opening-balances,external,validate}`, `/accounting/gl-import`, `/accounting/sage-migration` | Settings › Import data (one launcher, NAV-32 last row) |
| `/accounting/webhooks`, `/developer/personal-tokens`, `/developer/oauth-apps`, `/accounting/settings/connected-apps`, `/accounting/settings/integrations-mcp` | Settings › Developer & AI |
| `/accounting/settings/billing/flows`, `/compare`, `/flows/return` (ORPHAN) | Settings › Plan & billing (**RELINK**, SET-10) |
| `/accounting/library` | "All pages" (rail footer), generated from the registry (JRN-32) |

**Outside the app shell** (registry `scope: 'public' | 'external' | 'admin'`; no rail, but titled)

| Routes | Notes |
|---|---|
| `/`, `/pricing`, `/contact`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/offline`, `/onboarding`, `/accept-invite`, `/invite/[token]`, `/oauth/authorize` | Public/auth. Fix `/accept-invite` → `/accounting/dashboard` 404 (NAV-01) and the anonymous `/home` "session expired" (JRN-28) |
| `/portal`, `/portal/invoice/[token]`, `/portal/pay/[token]`, `/portal/payments/paystack/return`, `/share/[token]`, `/audit-portal/[sessionId]`, `/accounting/afs/portal/{login,dashboard,documents/[documentId]}`, `/accounting/afs/sign/[token]`, `/accounting/reports/present/[pack]` | External and full-screen. Present mode returns to its origin on Esc (RPT-11) |
| `/admin/*` (26 pages) | Separate host. Out of scope apart from SET-22 |

---

## 3. The cockpits

**Hard rule for every tile.** A tile may render only when all three hold:
1. It declares a `figureBasis` id from `src/lib/mcp/contracts/figures.ts` whose `owner` is non-null, **or** a `queueId` from the new `queues/queueDefinitions.ts`.
2. It shows its as-at date or period.
3. Its link opens a view that evaluates **the same predicate** and echoes it ("30 bills due 30 Sep – 7 Oct").

A unit test enumerates the tile definitions and fails on an unowned basis. Money is **never summed across clients**.

Why this matters: the registry already names the one owner of cash. It is `bank/cashBalanceService#getCashBalance` (`figures.ts:128-136`; the service header explains the four rival answers). The landing pages still bypass it:
- `bureauClientMetricsService.ts:72-90` (used by `/home`, `/bureau/clients/[id]` and `ownerCashPositionService`) sums **all** posted bank-subtype lines with no as-at bound, so future-dated journals (2031) count.
- The `/accounting` "Cash position" sums `bank_transactions.amount` (`kpiDashboardService.ts:87-101`), which is `cash.statement.v1` wearing the ledger's label (verify-c JRN-03).
- Revenue MTD in `clientMetricsSnapshot` has a lower bound only.

### 3.1 Firm › Today (`/today`)

| # | Widget | Source today | Basis | Backend work |
|---|---|---|---|---|
| T1 | **Do next**: one ranked cross-client list (deadline × severity × amount). Each row has a one-click action that switches company through `CompanyContext.switchCompany` and deep-links with the exact filter | `src/modules/bureau/services/bureauWorkAggregatorService.ts` (`aggregateBureauWork`, incl. `bureauVatSignal`, `complianceSignal`, `bankQuerySignal`, payroll signals), `bureauClientTriageService.ts`; UI `pages/bureau/index.tsx` | queue ids per row | WorkItem gets `{queueId, routeId, params}` instead of a raw `href`. Drop `approved` from pending (`bureauWorkAggregatorService.ts:47`, PAY-13). "Filed?" comes from the PR-08 service (TAX-01/03) |
| T2 | **Client health grid**: clients × 8 close areas for the selected period. Every cell is a link (client + module + period) | `src/modules/accounting/services/workbench/portfolioWorkbenchService.ts` → `monthEndWorkbenchService.getMonthEndWorkbench`; UI `pages/accounting/portfolio-workbench.tsx` | card ids | Population = `bureau_companies` for firm users (today `getUserCompanies`). Cells carry `routeId` + `?period=` (JRN-07/12). Drill-in via `switchCompany`, not a raw fetch (`portfolio-workbench.tsx:114`, JRN-08). Add a "ties to GL" column from `gl/closeReadinessChecks/{arSubLedgerCheck,apSubLedgerCheck,tbBalancedCheck,bankReconciledCheck}.ts` |
| T3 | **Deadlines, next 14 days**: VAT201, EMP201 (7th, weekend-adjusted), EMP501, IRP6, CIPC per client, with a filed state | `bureau/services/complianceCalendarEngine.ts`, `complianceObligationsService.ts` | — | Obligations must be derived per company (payroll only if employees, IRP6 only if provisional; TAX-11). Filed state from one source (PR-08) |
| T4 | **AI awaiting approval**, per client: close-run proposals, agent postings, provisional lines, high-confidence bank suggestions | `pages/api/accounting/close-run/*` + `gl/closeRun/closeRunTypes.ts`, `bank/agentActivityService.ts#listAgentPostings`, `/accounting/bank/provisional` | queue ids | **New** cross-company count endpoint, using the per-company pool pattern already in `portfolioWorkbenchService.ts:1-28` |
| T5 | **Client replies waiting** | `bureau/services/bankQuerySignal.ts` | queue `client_queries.replied` | Wiring |
| T6 | **Practice strip** (firm's own tenant): WIP to bill, time awaiting approval, overdue tasks, fee realisation | `practice/practiceWipService.ts#getWipByClient`, `practiceTimeEntryService.ts`, `practiceTaskService.ts` | practice queues | Needs `bureaus.practice_company_id` (Q1). Fee realisation is the new fee engine (PR-17) |

Not on Today: cash, revenue or any money total across clients. The old "Days to close —" tile goes too (JRN-22).

### 3.2 Books › Overview (`/accounting`), one per company. Owner variant for direct clients

| # | Widget | Owner service (figure registry) | Replaces | Backend work |
|---|---|---|---|---|
| O1 | **Cash** as at today, per account, plus the line "Bank statements say R X (Δ R Y)" linking to coverage | `cash.ledger.v1` → `bank/cashBalanceService.ts#getCashBalance(companyId, today)`. Second line `cash.statement.v1` → `bankAccountStatusService#getBankAccountsStatus`. Gap → `bankStatementCoverageService.ts` | `kpiDashboardService.ts:87-101` tile; `bureauClientMetricsService.ts:72-90` | Wiring only (JRN-03, RPT-01 for landings, BNK-03) |
| O2 | **Receivables**: total and overdue as at today, with a "ties to control ✓/✗ (Δ)" badge | `ar.subledger.v1` → `ar/arAgingService#getARAging`. Badge: `ar.control.v1` (**owner null** today) | `clientMetricsSnapshot` AR (allowlist basis, not aging); `dashboard-todos.ts:69` LIMIT-10 badge | Settle the `ar.control.v1` owner: promote the MCP `reconcile_subledger` logic (`src/lib/mcp/tools/reconcileSubledger.ts`) into a service. This needs the owner's control-account decision (Q5; `controlAccountService.ts` header). Closes the visible side of LED-05 and RPT-10 |
| O3 | **Payables**: total, overdue, due in 7 days | `ap.subledger.v1` → `ap/apAgingService#getAPAging`; queue `bills.due_7d` | `workbenchService.ts:62-72` (no lower bound in the list, JRN-04) | Shared predicate used by the tile and by `ap/supplierInvoiceWhereBuilder.ts` |
| O4 | **Revenue & net profit, month to date** (bounded `[monthStart, today]`) | `revenue.period.v1` → `reports/incomeStatementService#getIncomeStatement` | `clientMetricsSnapshot` revenue (no upper bound); kpi revenue "+1231%" (JRN-22) | Wiring. Show the comparison base when showing a %, or hide the % |
| O5 | **VAT for the period that is due next** | `vat.output.v1`/`vat.input.v1` → `reports/vat201ReportService#getVat201Report` | "VAT estimate (current period)" opening a different period (JRN-04, TAX-09) | The tile and the VAT201 link share one period resolver |
| O6 | **Payroll**: next run status, EMP201 due, last net pay | `payroll.netpay.v1` → `payroll/payrollJournalBuilder#buildPayrollJournalPlan`; run status `payrollRunQueryService.ts`; due date from `complianceCalendarEngine` | — | "Current period" fix (PAY-11) |
| O7 | **Needs you** (counts that link to filtered lists): bank lines to review, captured docs pending, draft bills, draft invoices, overdue invoices, draft journals, approvals, AI proposals, client replies | new `queues/queueDefinitions.ts` | `dashboard-todos.ts` (LIMIT-10 as count, JRN-02), `workbenchService.ts` (drafts = customer + supplier, JRN-04), 5 rival "unreconciled" predicates (JRN-05) | **New**, small. One predicate per queue, used by the tile, the list page filter parser and the month-end cards |
| O8 | **Close status** for the period | `monthEndWorkbenchService.getMonthEndWorkbench` | — | Cards carry the period. The Exceptions card links to the Inbox (JRN-07) |
| O9 | Owner variant: "Can I pay salaries / VAT / suppliers?" | `bureau/services/ownerCashPositionService.ts` | — | Take O1's cash as input instead of `metrics.cash` (`pages/api/home.ts`) |
| O10 | **Explain** on every tile (PR-19) | `/api/accounting/nl-query`, `ai-narrative` (no UI caller today, NAV-29) | — | Wiring |

### 3.3 Books › Inbox (`/accounting/inbox`)

One list mixing human to-dos and AI suggestions. Each row has a one-click action:

| Tab | Source |
|---|---|
| To code | bank queue O7 |
| Documents | `capture/*` |
| Approvals | `/accounting/approvals` + draft bills (PUR-18) + leave requests |
| AI proposals | close-run, smart-categorise suggestions, `suppliers/expectations` |
| Agent activity | `listAgentPostings`, `auto-postings`, with undo via `autoPostUndoService.ts` |
| Client replies | `bank/queries` |

This is also the "notifications" answer to the misleading 13-badge (JRN-20).

---

## 4. Navigation mechanics: data model and component contracts

### 4.1 Route registry (the single source for rail, active state, breadcrumbs, titles, search pages, quick-create)

Files: `src/lib/nav/registry/{firm,overview,banking,sales,purchases,payroll,tax,ledger,reports,inventory,settings,outside}.ts`, each under 300 lines, plus `src/lib/nav/registry/index.ts`. The registry supersedes `navSections/*`. `navSections/{accountants,afs,customers,generalLedger,items,suppliers,tools}.ts` are dead today (NAV-07) and get deleted.

```ts
export type Scope = 'firm' | 'books' | 'settings' | 'public' | 'external' | 'admin';
export type GroupId = 'today'|'clients'|'work'|'time-billing'|'firm-reports'
  |'overview'|'inbox'|'close'|'banking'|'sales'|'purchases'|'payroll'|'tax'|'ledger'|'reports'|'inventory'|'settings';
export type PageKind = 'hub'|'list'|'record'|'create'|'edit'|'report'|'workspace'|'settings'|'wizard'|'external';
export type EntityType = 'customer'|'supplier'|'customer_invoice'|'supplier_invoice'|'quote'|'sales_order'
  |'credit_note'|'receipt'|'supplier_payment'|'journal'|'gl_account'|'bank_txn'|'item'|'employee'|'pay_run'
  |'asset'|'loan'|'practice_client'|'job'|'task'|'afs_document'|'company';

export interface RouteNode {
  id: string;                       // 'sales.invoices.record'
  pattern: string;                  // Next pathname: '/accounting/customer-invoices/[invoiceId]'
  variant?: { query: Record<string, string> };   // e.g. adjustments?type=customer
  scope: Scope;
  group: GroupId;                   // ONE home → active rail group (no prefix heuristics)
  section?: string;                 // rail sub-section label
  kind: PageKind;
  label: string;                    // crumb + title fallback
  parent?: string;                  // id → breadcrumb chain; lists/hubs up to the group
  entity?: EntityType;              // record pages: label resolver + search target
  preserveQuery?: string[];         // list filters kept when a crumb links back (BNK-07, PRC-16)
  nav?: { order: number; badgeQueue?: QueueId; gate?: 'vat'|'payroll'|'inventory'|'bureau' };
  alsoListedIn?: GroupId[];         // cross-links only; never changes the active group (NAV-06, NAV-18)
  create?: { label: string; shortcut?: string; via: 'page' | 'modal' };   // quick-create target
  synonyms?: string[];              // Ctrl+K page search ("VAT201", "tax return")
}
```

Contracts (pure functions in `src/lib/nav/`):
- `resolveRoute(pathname, query): RouteNode | null`. Exact match on Next's `router.pathname` pattern, `variant` first. **No `startsWith` lists**, so `activeTab.ts` shrinks to a registry lookup.
- `buildTrail(node, ctx: { company?: string; recordLabel?: string; from?: ReturnRef }): Crumb[]`. Walks `parent`. Scope root = company name in books scope, "Firm" in firm scope.
- `href(routeId, params?, query?): string`. The only way to build internal links in new code. A lint rule for new files comes later.
- `ReturnRef = { routeId: string; params: Record<string,string>; query: Record<string,string> }`, carried as `?from=<routeId>&fp=<base64url(JSON)>`. It is validated against the registry and the origin node's `preserveQuery`, so an unknown `from` is dropped. This generalises the safe design of `src/components/accounting/invoiceReturnContext.ts`, which only knows 5 sources today (NAV-12).

Tests, added to `bun run ci` via `scripts/ci/run-ci.sh`:
1. Every `pages/**/*.tsx` file (365) has exactly one node.
2. Every nav entry's node group equals the group that lists it.
3. Every literal `href`/`router.push` target resolves, which ports `navcode-deadlinks.mjs`.
4. Every `create` node renders a form.

### 4.2 Shell components

| Component | Contract |
|---|---|
| `AppLayout` (`src/components/layout/AppLayout.tsx`) | Calls `resolveRoute`. Renders the Rail (or today's top nav while the flag is off), the TopBar and `<AppBreadcrumb/>`. Sets `document.title = "<leaf> · <company> · IsaFlow"` (JRN-17). Moves the tour gate from `pathname === '/accounting'` (line 511) to a registry flag |
| `usePageMeta({ recordLabel?, status? })` | The only thing a record page supplies. Replaces ~122 hand-rolled "← Back to X" links in 4 styles (NAV-10) |
| `<AppBreadcrumb/>` | Renders `buildTrail`. If `from` is valid, the trail becomes *origin trail + current record*. The last crumb is text. Uses `next/link`, not `<a href>` (`PageHeader.tsx:215` does a full reload today) |
| `PageHeader` (`src/components/ui/PageHeader.tsx`) | Gets a `crumbs` slot. `backLink` is deprecated |
| `Rail` / `TopBar` | Built from the registry `nav` fields. Buttons with `aria-expanded`, open on click, arrow keys (JRN-16). Mobile = drawer with an accordion above the tab bar (JRN-18). Badge counts come from `queueDefinitions` |
| Scope switcher | Firm ↔ company. Firm means active company = `bureaus.practice_company_id` (Q1). Always via `CompanyContext.switchCompany` |

### 4.3 Behaviour rules

| Rule | Spec | Closes |
|---|---|---|
| Active group | `node.group`. Cross-listed entries keep their home group highlighted | NAV-05, NAV-06, JRN-15, PAY-10 |
| Back | The header Back button goes to the **previous crumb** (not history). Browser Back is untouched. Never `router.back()` in Cancel | NAV-21, NAV-11 |
| Cancel on create/edit | → `from` if valid, else `parent` | SAL-10, PRC-20 |
| Save on create | `router.replace(record)` + `?created=1` banner with next actions (Send, Record payment, Allocate, Print). If `from`, offer "Back to <origin>" | NAV-13 |
| Company switch | On `record`/`create`/`edit` → nearest `list`/`hub` ancestor. Elsewhere keep URL and query | JRN-09 |
| List state | Filters, tab and page live in the query string (`useUrlState`, `preserveQuery`) | BNK-07, PRC-16, SET-14 |
| Tile → list | Tiles link through `queueDefinitions[q].href(params)`. The list echoes the predicate | JRN-04, JRN-06, JRN-29 |
| Keyboard | `G`-chords come from `nav.order`, and Tax honours the VAT gate (NAV-22). `N` opens `+` | NAV-22 |

### 4.4 Global search (Ctrl+K: "Go / Find / Do / Ask")

Server: `globalSearchService.ts` is split into one provider per entity (`src/modules/accounting/services/search/providers/*.ts`), each with a DB-backed test.
- **A provider failure is an error, not `[]`**. The response carries `degraded: EntityType[]` (JRN-01: four providers query non-existent columns and swallow the throw, `globalSearchService.ts:129-131, 154-156, 178-180, 251-253`).
- Results return `{ entity, id, title, subtitle, companyId }`. The client builds the URL with `href(recordRouteFor(entity), {id})`, so it opens the record, not `list?id=` (NAV-03).

| Provider | Scope | Fields | Target |
|---|---|---|---|
| Companies / practice clients | all companies the user can access + firm's `practice_clients` | name, trading name, reg no, tax no | switch company → Overview; or client 360 |
| Customers, suppliers | active company | name, code, VAT no, email | record |
| Customer invoices, supplier invoices, quotes, sales orders, credit notes | active | number, reference, counterparty name (`COALESCE(ci.client_id, ci.customer_id)`), amount | record |
| Receipts, supplier payments | active | reference, amount | record |
| Journals | active | entry number, description | record |
| GL accounts | active | code, name | account detail (not `?tab=accounts`, NAV-03) |
| Bank transactions | active | description, reference, exact amount | bank tx list filtered to the line |
| Items, fixed assets, loans | active | code, description | record |
| Employees, pay runs | active | name, employee no, ID no (masked), period | record |
| Jobs, tasks | firm tenant | title, client | record |
| Pages | registry | label, synonyms, section | route |
| Actions | registry `create` nodes + verbs ("close March", "VAT201 Demo") | — | create / workspace with params (BMK-05) |
| Ask | active company or firm | free text | `/api/accounting/nl-query` (exists, no UI caller, NAV-29) |

Recents: keep `localStorage` item recents (`CommandPalette.tsx`), and seed page recents from the existing `page_visits` API (`pages/api/accounting/page-visits.ts`, `useTrackPageVisit.ts`). `PAGE_REGISTRY` (`src/modules/accounting/constants/pageRegistry.ts`, 25 entries) is absorbed into the route registry.

### 4.5 Quick-create "+" menu

`CreateTarget = RouteNode & { create }`, filtered by scope and gates. Today 4 of 7 items go to `?action=new`, which no page reads (`CreateNewMenu.tsx:46-52`, JRN-10, NAV-04).

| Target | Route | Via |
|---|---|---|
| Invoice | `/accounting/customer-invoices/new` | page |
| Quote | `/accounting/customer-quotes?new=1` | modal (existing quote modal opened by the `useCreateIntent()` hook) |
| Receipt (was "Record Payment") | `/accounting/customer-payments/new` | page |
| Credit note | `/accounting/credit-notes/new` | page |
| Bill | `/accounting/supplier-invoices/new` | page |
| Pay supplier | `/accounting/supplier-payments/new` | page |
| Expense claim | `/accounting/expenses/new` | page |
| Upload document | `/accounting/capture` | page |
| Journal | `/accounting/journal-entries/new` | page |
| Bank transfer | `/accounting/bank-transfers?new=1` | modal |
| Customer / Supplier | `/accounting/customers/new`, `/accounting/suppliers/new` | page |
| Pay run *(payroll gate)* | `/payroll/runs/new` (defaults to the next open period, PAY-12) | page |
| Employee *(payroll gate)* | `/payroll/employees/new` | page |
| Log time *(firm)* | `/accounting/practice/time-entry` | page |
| Job *(firm)* | `/accounting/practice/jobs/new` | page |
| Client *(firm)* | `/accounting/practice/clients/new` | page |

Contextual pre-fill: on a record page, `+` passes the record as context (`?customerId=`, `?supplierId=`, `?clientId=`).

---

## 5. End-to-end flows

Type key:
- **W** = wiring: backend exists, UI or link missing.
- **B** = small backend change.
- **N** = new feature.

### 5.1 Practice: client → engagement/fee → jobs → time/WIP → invoice → profitability

| # | Step | Today | Gap | Type | Findings |
|---|---|---|---|---|---|
| 1 | Firm identity | `bureaus` has no link to the company that holds practice data (`practice_clients.company_id` = whatever tenant was active) | `bureaus.practice_company_id` | B (migration) | Q1 |
| 2 | Add client (one wizard) | New Client defaults to Prospect, no AR customer link, no company link, no edit screen | Creates `practice_client` + AR customer in the firm books + link to the client's IsaFlow company (`bureau_companies`) or "books elsewhere". Edit screen (the PUT exists) | W + B (`practice_clients.linked_company_id`) | PRC-01, 05, 06, 07, 17, 29 |
| 3 | Engagement & fee | **Nothing reads** `billing_model`, `fixed_fee_amount`, `budgeted_hours` | **Fee engine** (below) | **N** | PRC-03, 27; BMK-06 |
| 4 | Jobs & deadlines | Jobs are manual. `practiceRecurringTaskService.ts` + cron exist with no UI. No SARS deadlines per client | Engagement lines generate recurring jobs. `complianceCalendarEngine` generates per-client statutory tasks | W (recurrence UI) + **N** (engagement→jobs) | PRC-13; IDEA-BMK-09 |
| 5 | Time | `time_entries.job_id` never written. Work item required but none seeded. 3 time UIs on 2 services | Job picker, seeded work items, week grid + timer on one service | B + W | PRC-02, 08, 09; NAV-14 |
| 6 | Approve | `/accounting/practice/approvals` works | Counts into Today/Inbox | W | — |
| 7 | WIP | `practiceWipService.getWipByClient` works. Invoicing refuses without `link_customer_id` (`practiceWipService.ts:165`) | Solved by step 2. Show draft/submitted time upstream | W | PRC-01, 30 |
| 8 | Invoice | Hourly: `generateWipInvoice` exists. Toast links to `list?id=` (PRC-10). VAT typed by hand | Fixed and retainer: recurring invoice from the engagement. VAT from company status | W + **N** | PRC-10, 25 |
| 9 | Collect | Invoice sits in the firm's Sales; `/portal/pay/[token]` exists | Shown on client 360 (Invoices tab) | W | PRC-04 |
| 10 | Profitability | Revenue = time `billed` only (fixed fees show R0). Two "billed" definitions | Revenue = invoices to the linked customer. Cost = time × cost rate (`practiceCostRateService.ts`). Fee vs effort per client | B + **N** | PRC-12, 21 |

**Fee engine v1 (N).**
- **Volume drivers**, trailing 3 months from the linked company: bank lines/month (`bank_transactions`), sales and purchase documents/month, active employees (`payroll_employees`), VAT cadence, entity count, AFS required. For "books elsewhere" clients the volumes are entered by hand.
- **Pricing**: the firm rate card holds package × volume tier (bookkeeping, VAT, payroll per employee, AFS, secretarial). The engine *suggests* a monthly fee plus one-off fees, and the accountant confirms.
- **Storage**: stored as `engagements` / `engagement_lines`.
- **Monthly drift check**: flags clients whose volume moved over 20%, or whose fee vs time cost margin dropped below the target.
- **E-sign**: the engagement letter reuses the token-sign pattern from `pages/accounting/afs/sign/[token].tsx` (N, PR-18).

### 5.2 Payroll: pay run → approve → payslips → pay → EMP201 → IRP5/EMP501

| # | Step | Today | Gap | Type | Findings |
|---|---|---|---|---|---|
| 1 | This month's payroll | `/payroll` redirects to employees (`next.config.js:93`). Period bar = highest run ("Jan 2031") | Stepper home. "Current" = first unapproved period ≤ today, anchored to the March tax year | W + B | PAY-11, 25 |
| 2 | Create run | `runs/new` defaults to the calendar month; free year input | Default next open period, block far-future | W | PAY-12 |
| 3 | Calculate | `POST runs/[id]/calculate` works | — | — | — |
| 4 | Review | Variance page separate. 11 near-duplicate warnings. Anchors missing. No bank or payment-method fields | Grouped warnings with fix-all. DOB from ID number. Bank details section. Net waterfall | W + B | PAY-06, 07, 08, 09, 17 |
| 5 | **Approve** | `pages/api/payroll/runs/[id]/approve.ts` exists; **no button anywhere** (verify-c) | Primary "Review & approve" with a summary of the journal it will post | **W** | PAY-01 |
| 6 | Journal | Approval posts it; `journalEntryId` returned, never rendered | Run ↔ journal ↔ EMP201 links | W | PAY-24 |
| 7 | **Payslips** | Builders exist (`core/payrollPdfBuilders2.ts#buildBatchPayslips` via `payrollPdfService.buildPayrollPdf`), but **no API route calls them** (the header cites a non-existent `pages/api/payroll/payroll-documents.ts`) | API route + payslip drawer + bulk PDF. Email/ESS distribution later (outbound) | B + W; distribution **N** | PAY-05 |
| 8 | Pay | Netcash submit handles `supplier_payment_batches` only (`pages/api/accounting/netcash/submit.ts:52-64`). No code sets a run to `paid` | Salary bank file / Netcash salary batch, and a "Mark paid" status | **N** + B | PAY-13 |
| 9 | EMP201 | `/accounting/sars/emp201` works (`reports/sarsService#generateEMP201`), but it lives under Tax and has no GL control compare | Home in Payroll › Statutory. PAYE/UIF/SDL control variance. Filed state from PR-08. Due 7th on Today | W + B | PAY-10, TAX-16 |
| 10 | IRP5 / EMP501 | IRP5 strict code-year lookup (`sarsCodesService.ts:83-93`). EMP501 is a self-consistency check. e@syFile export exists (`payroll/easyFileExportService.ts`) | Code-table fallback + one banner. EMP501 vs filed EMP201 vs PAYE control. Gate "ready" on IRP5 | B | PAY-03, 04 |
| 11 | Tax year-end | `/payroll/year-end` shadowed by `next.config.js:95` | Delete the redirect; fix its `/accounting/settings/company` links | W | NAV-02 |

---

## 6. Borrow from, and deliberately not copy (from `benchmark.md`)

| Borrow | From | IsaFlow form |
|---|---|---|
| One firm home ranked by readiness | Xero Partner Hub, Karbon My Week [S1][S5] | `/today` (T1–T3) on existing aggregators |
| "Ready to post" approval queue with evidence | QBO Accounting Agent, Puzzle [S3][S7] | Inbox › AI proposals (close-run already approve-only) |
| Batched client requests with reminders | QBO magic links, Uncat, Keeper [S3][S11][S12] | Later step on the Inbox "Client replies" tab (BMK-03, BNK-32). Plumbing exists in `bankTxQueryReplyService` |
| Book-health score | Dext Precision [S10] | T2 "ties to GL" column from `closeReadinessChecks` |
| Ask box over the books | Ask Digits, Puzzle Chat [S9][S7] | Ctrl+K "Ask" on `nl-query` (validator exists) |
| Keyboard-first command palette | Digits [S9] | §4.4 verbs + cross-client jump |
| Volume-priced engagements | Ignition [S13] | Fee engine. IsaFlow already *holds* the volumes Ignition has to ask for |

| Do **not** copy | Why |
|---|---|
| Sage/Pastel module tree (Lists / Transactions / Special / Reports flyouts) | That is what the Library recreated: 179 links (NAV-17, BNK-29) |
| Xero's separate practice product (XPM ↔ Xero) | IsaFlow's advantage is one database. Link practice clients to books companies instead of syncing (BMK-02) |
| "Coming soon" agent autonomy / auto-post by default | Xero's own reviewers warn against it [S2]. Keep "nothing posts until you approve" |
| Dashboards of vanity KPIs (% change without base, "Days to close —") | JRN-22. Every tile must be actionable and have an owner |
| Cross-client money totals ("firm cash") | Meaningless, and a tenant-isolation smell |
| QBO-style flat "My Menu" customisation | It hides the IA instead of fixing it. Recents and pins in Ctrl+K are enough |

---

## 7. Migration plan (incremental, flag-gated, no URL moves)

Sizes: S ≈ ½ day, M ≈ 1–2 days, L ≈ 3–5 days for one session. Lanes can run in parallel sessions:
- **A** = navigation
- **B** = truth and cockpits
- **C** = payroll
- **D** = practice

PR-02, PR-03 and PR-08 have no dependencies and can start at once.

| PR | Lane | Title / scope | Depends | Closes (audit ids) | Size | New feature? |
|---|---|---|---|---|---|---|
| **01** | A | Route registry for all 365 pages + registry-derived `getActiveModuleId`/`getActiveTabId` (same visuals) + CI tests (§4.1) | — | NAV-05, NAV-28, JRN-15, BNK-08, SAL-11, INV-04, LED-15, RPT-28, SET-16 (highlight), PUR-15 (highlight) | M | no |
| **02** | A | Dead ends: accept-invite target, unshadow `/payroll/year-end`, `/accounting/ar` crumb, footer 404 links, `router.back()` cancels, anonymous `/home`, accept-invite without token | — | NAV-01, NAV-02/PAY-02, NAV-15/SAL-12, NAV-16, NAV-21, JRN-28, SET-13 | S | no |
| **03** | B | One truth for landings: `landingFigures` calls `getCashBalance`/`getARAging`/`getAPAging`/`getIncomeStatement`/`getVat201Report` with as-at dates. New `queues/queueDefinitions.ts` (COUNT + top-N) used by `dashboard-todos`, `workbenchService`, `/api/home`, `/api/bureau/client`, list filters | — | JRN-02, 03, 04, 05, 06, 29; SAL-02; PUR-10; BNK-03, 04 | M | no |
| **04** | A | Search and "+" land on the thing: per-entity providers with fixed columns and surfaced errors, record URLs, registry create targets, `useCreateIntent` for quote/transfer modals, fix WIP "View invoice" | 01 | JRN-01, JRN-10, NAV-03, NAV-04, PRC-10, PRC-14, PRC-24 (targets) | M | no |
| **05** | A | `<AppBreadcrumb/>`, `usePageMeta`, `document.title`, generalised `from` return context. Migrate the top ~40 detail pages; the rest follow module by module as sub-PRs | 01 | NAV-10, NAV-11, NAV-12, JRN-17, RPT-13, BNK-23, LED-25, TAX-15, INV-08, PUR-21, SAL-10, PRC-20, PAY-18 | L | no |
| **06** | A | Behaviour rules: save→record + next-step banner, cancel→from/parent, switch on record→list, `useUrlState` for lists | 05 | NAV-13, JRN-09, BNK-07, BNK-24, PRC-16, SET-14 | M | no |
| **07** | A | Relink orphans; trivial merges via redirects: aging×2, dunning stub, currencies/FX, reports hub as landing, JE real list, cash-flow forecast, customer/supplier report twins, EMP201 twin entry. Delete the 7 dead nav files | 01 | NAV-07, NAV-08, NAV-18, NAV-19, PUR-17, PUR-22, SAL-18 (aging), RPT-14 (orphans), RPT-15, SET-08, TAX-14, JRN-23 (names) | M | no |
| **08** | B | Filing status single source (calendar, submissions, VAT201, EMP201 all ask one service). Per-company obligations | — | TAX-01, TAX-03, TAX-11, TAX-12 | M | no (backend) |
| **09** | B | Books › Overview cockpit at `/accounting` (O1–O9). `/home` → redirect. Direct-client landing → `/accounting` | 03, 05 | JRN-11, JRN-13, JRN-14, JRN-22, JRN-07 (period deep links), NAV-09 (direct), LED-05 (visible) | M | no |
| **10** | B | Firm › Today at `/today` (T1–T5). `/bureau` and portfolio → redirects. Firm landing → `/today`. Fix approved-as-pending. Cells link through `switchCompany`. Temporary "Today" entry in `TABS` until PR-11 | 03, 08 | BMK-01, NAV-09, JRN-08, JRN-12, PAY-13 (board), PAY-14, TAX-19 | M | no |
| **11** | A | Shell v2 behind the `nav_v2` user flag: rail from the registry, scope switcher, TopBar with avatar menu, `/settings` hub, accessible flyouts/drawer, data gates for Payroll/Inventory | 01, 05, 10 | NAV-17, NAV-20, NAV-22, JRN-16, JRN-18, JRN-23, JRN-24, JRN-30, SET-07, SET-10, BNK-29, PAY-10, PAY-19, PRC-24 | L | no |
| **12** | B | Books › Inbox (§3.3), including agent activity with undo | 03 | NAV-30, NAV-31, PUR-18, JRN-20, JRN-07 (Exceptions card), LED-12 (part) | M | partly (aggregation) |
| **13** | C | Payroll cycle UI: `/payroll` stepper, **Approve** button, payslip API + drawer, run↔journal↔EMP201 links, period bar, grouped warnings | 05 | PAY-01, PAY-05, PAY-06, PAY-08, PAY-09, PAY-11, PAY-12, PAY-24, PAY-25 | M | no |
| **14** | C | Payroll pay and statutory truth: bank/payment fields, DOB from ID, SARS code fallback, EMP501 vs filed EMP201 vs control, **salary bank file / Netcash salary batch**, `paid` status | 08, 13 | PAY-03, PAY-04, PAY-07, PAY-13 (paid), PAY-17, TAX-16 | M | **yes** (bank file) |
| **15** | D | One client entity: `bureaus.practice_company_id`, `practice_clients.linked_company_id`, client wizard + edit + billing customer, default Active, client 360 tabs, `/accounting/practice` home | 05 | PRC-01, PRC-04, PRC-05, PRC-06, PRC-07, PRC-17, PRC-18, BMK-02 | M | small schema |
| **16** | D | One time model: job on time, seeded work items, week grid + timer on `practiceTimeEntryService`; retire `/timesheets`, `/time-tracking` and the core invoice route | 15 | NAV-14, PRC-02, PRC-08, PRC-09, PAY-15, PRC-30 | M | no |
| **17** | D | **Fee engine v1**: rate card, volume drivers, suggested fee, fixed/retainer recurring invoices, fee-vs-effort profitability | 15, 16 | PRC-03, PRC-12, PRC-21, PRC-25, PRC-27, BMK-06 (part) | L | **yes** |
| **18** | D | **Engagements**: letter + e-sign, engagement→recurring jobs, per-client statutory deadlines as tasks, renamed practice reports | 08, 17 | PRC-11, PRC-13, BMK-06, IDEA-BMK-07/09 | L | **yes** |
| **19** | B | Ask and Explain: Ctrl+K Ask (`nl-query`), Explain on Overview tiles (`ai-narrative`), cross-client jumps and verbs | 04, 10 | JRN-31, JRN-32, NAV-29 (part), BMK-04, BMK-05, RPT-31 (part) | M | partly |
| **20** | A | Flip `nav_v2` on for everyone. Delete Library flyout, old `TABS`, `activeTab.ts` prefix lists, layout toggle. Rewrite the onboarding tour for the new IA | 07, 09, 10, 11, 12 | JRN-19, NAV-17 (final) | S | no |

Deliberately **not** in this plan: merges that need a data or number decision before any redirect (Q3). These are VAT201 vs vat-return (TAX-05), the two PO tables (PUR-06), items vs products (INV-01), and the four pack systems (RPT-12). They also include the ledger P0s the IA surfaces but does not fix (RPT-01/02, LED-01..06, SAL-03/04, PUR-01..09). Each deserves its own ticket, and the cockpit shows their gaps from PR-09 onward.

---

## 8. Open questions for the owner (with recommendations)

1. **Is a bureau the accounting firm, and does its practice data live in one designated company?**
   - Why it matters: today three unlinked "client" lists exist (`bureau_companies`, `getUserCompanies`, `practice_clients`).
   - *Recommend:* yes. Add `bureaus.practice_company_id`. Firm scope = that company. A practice client links to at most one books company.
2. **Left rail by default, or keep the top bar?**
   - *Recommend:* rail by default for everyone once PR-11 is flag-tested with 2–3 firms. Keep the top/side toggle for one release, then remove it. A rail scales to 12 groups; the top bar only fit 5 by hiding 8 modules in "Library".
3. **Which implementation wins where two exist on different data?** This covers VAT201 page vs VAT return (different payable, TAX-05), `purchase_orders` vs `supplier_purchase_orders` (PUR-06), `items` vs `products` (INV-01).
   - *Recommend:* `/accounting/sars/vat201` after both are re-pointed to `vat201ReportService#getVat201Report` (the registry owner); `purchase_orders`, because it feeds GRN and 3-way match; `items`, with a one-off migration of any `products` rows.
4. **Fee model: price from volumes, or from estimated hours?**
   - *Recommend:* package × volume tier from a firm rate card, **suggest-only** (the accountant confirms). Monthly drift and margin alerts use existing staff cost rates. Hourly WIP stays for out-of-scope work.
5. **Which account is the AR/AP control account per company?**
   - Why it matters: `ar.control.v1` and `ap.control.v1` have `owner: null`. `controlAccountService.ts` explicitly leaves this business call to you. The Overview "ties to GL" badge needs it.
   - *Recommend:* an explicit per-company setting (one control account per subledger), chosen in Settings › Accounting. The reconciler keeps reporting other receivable-typed accounts as warnings, not as control accounts.
