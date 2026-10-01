# Navcode (static nav / breadcrumb / consistency audit) — audit

Scope: static code audit of `/home/hein/Workspace/IsaFlow/.worktrees/uiux-audit` @ 66e776d81 (all 365 page routes).
Live checks were limited to `curl` against `http://localhost:3200` with a minted QA session (status codes + two read-only
aging APIs). No browser screenshots were taken for this area, so every visual claim below comes from code and is marked
where it is an inference.

Scripts and raw outputs (re-runnable, read-only):
`$AUD/scripts/navcode-scan.mjs` (per-page scan → `$AUD/navcode/scan.json`), `navcode-graph.mjs` (nav graph + orphans →
`$AUD/navcode/graph.json`), `navcode-active.ts` (runs the real `activeTab.ts` against every route → `$AUD/navcode/active.txt`),
`navcode-deadlinks.mjs` (every in-app link literal → does the route exist), `navcode-table.ts` (→ `$AUD/navcode/table.md`, the
per-page table reproduced at the end of this file).

## Verdict

Navigation is where IsaFlow feels least finished. The nav config has **no dead menu links**. The problems sit around it:
- **2 P0s:** invited users land on a 404 after accepting, and both "Year-End Workflow" menu items open the GL financial-year close instead of the payroll tax-year workflow.
- **Search and "+ Create" don't reach their targets.** Ctrl+K search and the header "+ Create" menu send users to list pages whose query string no page reads.
- **Wrong or missing highlighting.** 40 routes highlight "Dashboard" and lose their module bar.
- **No trail for the user to follow.** Only 3 of 339 app pages have a breadcrumb.
- **Lost pages.** A nav restructure left 7 old nav files behind and orphaned a handful of real features (AFS mapping, PIS score, supplier statement reconciliation, supplier expectations).
- **Duplicate pages.** About 15 groups of pages do the same job, several on different backing tables.
- **Unsurfaced AI.** A lot of AI exists server-side (NL query, report narratives, anomaly scan, AFS note drafting, client chatbot, MCP reclassification) with no UI at all.

## Findings

| ID | Sev | Type | Route / flow | Finding | Evidence | Recommendation |
|---|---|---|---|---|---|---|
| NAV-01 | P0 | broken | `/accept-invite` → after "Accept" | After a successful invite accept the page does `router.push('/accounting/dashboard')`. That route does not exist, so the new team member's first screen is a 404. `/accept-invite` is the live emailed accept link (`acceptUrl` in `pages/api/invitations/index.ts:91`). | `pages/accept-invite.tsx:66`. Live: `curl` with QA session → `/accounting/dashboard 404`. No page file, no redirect in `next.config.js:67-96`, nothing in `middleware.ts`. | Push to `/api/auth/landing`'s answer (or `/accounting`). Add a unit test that every literal `router.push` target resolves to a route (the script `navcode-deadlinks.mjs` does this in ~40 lines). |
| NAV-02 | P0 | broken | Tax › "Year-End Workflow", Payroll › Reports › "Year-End Workflow" | `next.config.js:95` redirects `/payroll/year-end` → `/accounting/year-end`. Redirects run before the filesystem, so the real **Payroll Year-End guided workflow** page (`pages/payroll/year-end/index.tsx`: IRP5 / EMP501 / e@syFile / lockdown steps) is unreachable. Both menu items open **GL "Year-End Processing — close financial year, create closing journals"** instead. It is a different process, and an irreversible one sits one click away. | `next.config.js:95`; `src/components/accounting/navSections/tax.ts:22`, `payroll.ts:48`. Live: `/payroll/year-end 307 → /accounting/year-end`. The redirect came in with commit dc147ddeb (#65). That page also links to `/accounting/settings/company`, which is a 404 (`pages/payroll/year-end/index.tsx:230,284`). | Delete the redirect and fix the two dead links inside the payroll page. Keep GL year-end under Accounting › Periods only. |
| NAV-03 | P1 | navigation | Ctrl+K command palette results | Every search hit navigates to a **list** page with `?id=<uuid>`, and none of those pages read `id`. Searching "INV-0042" drops the user on the unfiltered invoice list. GL-account hits go to `/accounting?tab=accounts`, but the valid tab id is `chart-of-accounts`, so they land on the Overview. Bank-transaction hits go to the unfiltered bank list. | `src/modules/accounting/services/core/globalSearchService.ts:101,126,151,175,199,224,248`. No `router.query.id` in `pages/accounting/{customers,suppliers,customer-invoices,journal-entries,items}/index.tsx`. Dashboard tab ids: `pages/accounting/index.tsx:25-30`. | Return detail URLs (`/accounting/customers/${id}`, `/accounting/customer-invoices/${id}`, …) and `/accounting/chart-of-accounts?account=`. This is the one-line fix with the biggest payoff in the area. |
| NAV-04 | P1 | workflow | Header "+ Create" menu; Practice nav | "New Invoice", "New Bill", "New Quote" and "Bank Transfer" go to `?action=new` on the list pages, and no page reads `action`, so the user lands on the list, not a form. Practice › "Generate Invoice" (`/practice/wip?action=invoice`) and "Client Groups" (`/practice/clients?view=groups`) have the same problem: the WIP and clients pages never read `router.query`. | `src/components/layout/CreateNewMenu.tsx:46-48,52`; `navSections/practice.ts:14,36`. No handler found (`grep query.action` finds only API routes). `pages/accounting/practice/wip/index.tsx` has no `useRouter`. | Point to the real `/new` routes. Where no route exists (quotes, transfers), open the create modal from `?action=new`. Drop or implement `view=groups`. |
| NAV-05 | P1 | navigation | 40 routes | `getActiveModuleId` falls through to `'dashboard'` for 40 in-app routes. On those pages the top bar highlights **Dashboard** and the **module sub-nav disappears**. Affected: Banking pages under `/accounting/bank/*` (Client Queries, Provisional, Statement Imports), `/cashbook`, `/netcash`; Purchases › Capture inbox/settings, Fraud signals, Expenses; Sales › Delivery notes, Disputes; Inventory › Stock levels; Accounting › Loans (all 5); Reports › Audit packs; Settings › Developer and MCP pages; `/adjustments` without `?type`. | `src/components/accounting/navSections/activeTab.ts:94` (`startsWith('/accounting/bank-')` misses `/accounting/bank/`), `:165` (default). Full list: `$AUD/navcode/active.txt` (produced by running the real resolver). | Derive the resolver from the nav config (a route belongs to the module whose tree lists it, with longest prefix winning) instead of a hand-kept prefix list. Add a test that every nav href resolves to the module that lists it. |
| NAV-06 | P1 | navigation | Cross-module entries | Some entries sit in one module but resolve to another, so the user jumps bars. Payroll › Reports › IRP5 / EMP501 / UIF / Tax Directives / Year-end resolve to **Tax**, and the Payroll bar is replaced by the Tax bar. Reports › Trial Balance and Audit Trail resolve to **Accounting**. Sales › Opening Balances and Purchases › Opening Balances resolve to Accounting. Practice › "My Timesheet" resolves to **Settings**, which has no module bar, so nothing highlights. | `$AUD/navcode/active.txt` "MULTI-LISTED" section. `activeTab.ts:104-110,117-137,30-31`. | Each page gets one home module and appears in the others as a cross-link, not a duplicate menu entry. Or keep the originating module in the URL/state for the highlight. |
| NAV-07 | P1 | navigation | Nav restructure fallout | Seven old nav files are still in the repo, imported by nothing: `accountants.ts`, `afs.ts`, `customers.ts`, `generalLedger.ts`, `items.ts`, `suppliers.ts`, `tools.ts`. When they were replaced, six pages lost their **only** menu entry: **AFS Account Mapping**, **AFS Report Templates**, **Public Interest Score** (AFS compliance), **Supplier Expectations** (learned billing cadence), **Supplier Statement Reconciliation** (`/accounting/ap/supplier-statements`, linked only from its own child page), and **Missing Invoices** (linked only from one dashboard widget). | `navSections/afs.ts:12-14`, `suppliers.ts:50-52`. Import graph: none of these 7 files is imported (only `generalLedger` in `tests/unit/vatNav.test.ts`). Inbound links: `$AUD/navcode/graph.json`. | Put the six pages back: AFS mapping, templates and PIS under Reports › AFS; expectations, missing invoices and statement reconciliation under Purchases. Delete the 7 dead files. |
| NAV-08 | P1 | navigation | Orphans + self-linked duplicates | These have zero inbound links from nav or any page: `/accounting/cash-flow-forecast` (427-line AI forecast, richer than the linked `/reports/cash-flow-forecast`), `/accounting/currencies` (the page that **manages** currencies, with POST/PUT; the nav's "Currencies" opens the **read-only** `/settings/currencies`), `/accounting/exchange-rates`, `/accounting/practice/reports` (Practice reports hub), `/accounting/reports/cash-movement`, `/accounting/reports/customer-communication`, `/accounting/sales-reps`. These are linked only from their own child pages: `/accounting/products` (+new/[id]; separate `products` table from `items`) and `/accounting/supplier-purchase-orders` (separate `supplier_purchase_orders` table from `purchase_orders`). | `navcode-graph.mjs` output ("ORPHAN" list). `pages/accounting/settings/currencies.tsx:2-4` ("Read-only listing"); `src/components/accounting/currencies/CurrencyList.tsx:43,73` (POST/PUT). Backing services: `pages/api/accounting/supplier-purchase-orders.ts` → `purchaseOrderService` vs `purchase-orders.ts` → `procurementService`. | For each: link it, merge it into the page that wins (see the duplicates table) or delete it. The currencies swap is user-visible: the menu opens the page that cannot do the job. |
| NAV-09 | P1 | navigation | Post-login landing | Login sends accountants to **`/bureau`** (cross-client cockpit) and direct clients to **`/home`**. Neither has a nav entry, and the header logo is a plain `<Image>`, not a link. The "Dashboard" tab goes to `/accounting`, a different page. After their first click, the accountant can get back to their own landing page only by re-login or typing the URL. The app also has four competing "home" surfaces: `/bureau`, `/home`, `/accounting` (Dashboard), `/accounting/portfolio-workbench` (Portfolio). | `src/lib/auth/resolveLanding.ts:15-17`; `pages/login.tsx:276`; `src/components/accounting/accountingNavConfig.ts:30-36`; `src/components/layout/AppLayout.tsx:389` (logo not linked). Inbound links to `/bureau` come only from `pages/bureau/clients/index.tsx:147`. | Pick one home per persona. Make "Dashboard" resolve to it (`/bureau` for firm users), link the logo to it, and fold Portfolio workbench and bureau into one cockpit. |
| NAV-10 | P1 | breadcrumb | Whole app | Breadcrumbs are effectively absent. `<Breadcrumb>` is used on 2 pages (customer and supplier invoice detail), and AFS document and compliance have hand-rolled crumbs. **3 of 339** AppLayout pages have one. Everything else uses a per-page "← Back to X" link (122 pages) in at least 4 visual styles: a text link in the ff header band, a text link inside the gradient hero, an icon-only arrow button, and `PageHeader.backLink`. `PageHeader.backLink` renders a raw `<a href>`, so it does a full page reload. | `grep -rl Breadcrumb` → `pages/accounting/{customer,supplier}-invoices/[invoiceId].tsx`, `afs/[documentId]/index.tsx:116`. `src/components/ui/PageHeader.tsx:215` (`<a href>`). Per-page detail in the table below. | Build the crumb trail in AppLayout from the nav tree plus the record name (module › section › list › record). Have every page supply only the record label. That also fixes NAV-11 and NAV-12 in one place. |
| NAV-11 | P1 | navigation | Reports | "Back to Reports" goes to three different places. Income Statement, Balance Sheet and Project Profitability go to `/accounting?tab=reports`, a dashboard tab with 4 tiles. 18 other reports go to `/accounting/reports`, the full hub. General Ledger says "Back to Accounting" and goes to `/accounting`. 21 reports have no back link. The full hub **has no menu entry**; you reach it only from a report's back link or the Ctrl+K "Reports" action. So 8 reports are reachable only through the hub: Executive Dashboard, Financial Analysis, General Ledger, Management Accounts, Three-Way Forecast, Trend Analysis, Waterfall, and the Reports audit trail. | `pages/accounting/reports/{income-statement.tsx:184,balance-sheet.tsx:136,project-profitability.tsx:63}` vs `ar-aging.tsx:147` etc.; `general-ledger.tsx:112`. Hub links: `pages/accounting/reports/index.tsx:90-114`. Nav: `navSections/reports.ts` has no `/accounting/reports` entry. | Make `/accounting/reports` the Reports landing (library tile, nav header, `g r` shortcut). Point all back links at it. Remove the dashboard "Reports" tab. |
| NAV-12 | P1 | navigation | Record → invoice → Back | The invoice return-context design (`?from=`) is good, but it only knows 5 sources: debtors, AR/AP aging, and the two invoice lists. Opening an invoice from a **customer or supplier record**, a statement, a receipt allocation, a dispute, an auto-posting, the to-do widget, a sales order or a delivery note sends the user back to the **Invoices list**, not where they came from. | `src/components/accounting/invoiceReturnContext.ts:48-54` (SOURCES). Raw links without `from`: `pages/accounting/customers/[customerId].tsx:62-65`, `customer-payments/[paymentId].tsx:223`, `disputes/index.tsx:142`, `auto-postings.tsx:115-118`, `src/components/dashboard/widgets/TodoWidget.tsx:64`, `statements/CustomerStatementPreview.tsx:59`, `supplierStatementParts.tsx:3`. | Add `customer`, `supplier`, `statement`, `receipt` and `todo` sources, and use `buildInvoiceHref` everywhere. Longer term, generalise it into the AppLayout crumb trail (NAV-10). |
| NAV-13 | P1 | workflow | Create → save | Where the user lands after saving depends on the document type. Invoices, bills, journals, customers, suppliers, POs, supplier payments, loans, expense claims and payroll objects open the **new record**. Receipts, credit notes, supplier credit notes, items, assets, delivery notes, goods received, recurring invoices, batch payments and manual bank transactions return to the **list**. A receipt started from an invoice (pre-filled from the query) lands on the receipts list, with no confirmation of what was allocated and no way back to the invoice. | `pages/accounting/customer-payments/new.tsx:46,136`; `credit-notes/new.tsx:74`; `items/new.tsx:153`; `assets/new.tsx:92`; `delivery-notes/new.tsx:104`; `goods-received/new.tsx:103`; `recurring-invoices/new.tsx:101`; `supplier-credit-notes/new.tsx:92`; `batch-payments/new.tsx:87`; `bank-transactions/new.tsx:153`. | Standard rule: save → the record, with a success banner and next-step buttons (Send, Record payment, Allocate, Print). If opened from a parent (`?from=`), return there. |
| NAV-14 | P1 | workflow | Time capture | Time is captured in three UIs over the same `time_entries` table through two services and two invoicing paths. Settings cog › "Time Tracking" and "Timesheets (Week View)" use core `timeTrackingService` and `/api/accounting/time-entries-invoice`. Practice › "Enter Time" uses `practiceTimeEntryService` and WIP › Generate Invoice. The split has already caused a double-billing defect: the fix comment is at `time-entries-invoice.ts:148-152`. Time tracking also sits under **Settings** for a practice user. | `navSections/settings.ts:26-27`, `practice.ts:20-22`. `pages/api/accounting/time-entries.ts:15-22` vs `practice/time-entries.ts:14-17`. `pages/api/accounting/time-entries-invoice.ts:148-155`. | Make Practice › Time the single surface (day + week views) and WIP the only invoicing path. Retire `/time-tracking` and the core time-entry invoice route. |
| NAV-15 | P1 | broken | `/accounting/ar/settings/sent-mirror` | The "‹ Accounts Receivable" link above the title goes to `/accounting/ar`, which is a 404. | `pages/accounting/ar/settings/sent-mirror.tsx:194`. Live with session: `/accounting/ar 404`. | Point it at the Sales module (e.g. `/accounting/customers`) or at the crumb trail. |
| NAV-16 | P1 | broken | Public site footer | The landing page footer links Privacy, Terms and Security, and all three are 404s. For a POPIA-regulated accounting SaaS the missing privacy and terms pages are a trust and compliance gap, not polish. | `src/components/landing/LandingPricingTestimonialsFooter.tsx:241-243`. Live: `/privacy 404`, `/terms 404`, `/security 404`. | Publish the pages. Until then, remove the links. |
| NAV-17 | P1 | navigation | Library tab | Sales, Purchases, Inventory, Accounting, Reports, Tax, Payroll and Practice are all "demoted" under one **Library** tab. Its hover flyout renders **179 links** across 8 sections. The accountant's daily modules (sales, purchases, payroll, practice, reports) are two hops away, while Banking and Month-End get top-level tabs. | `navSections/library.ts:25-41`; count from `$AUD/scripts/navcode-count.ts` (`library links: 179`). `accountingNavConfig.ts:30-36`. | Put Sales, Purchases, Payroll, Practice and Reports in the top bar, or better, a left rail. Keep the Library grid for rare items. The module sub-bar already exists and works. |
| NAV-18 | P2 | consistency | Nav config duplicates | Tax › SARS Submissions has "EMP201 Submission" and "EMP201 / SDL (Payroll)" pointing at the **same** href. "Opening Balances" is listed 3× (Sales › **Statement Run** section, Purchases › Special, Accounting). Other repeats: VAT Return ×2, Trial Balance ×2, Audit Trail ×2, five SARS payroll items in both Tax and Payroll, Import Statement ×2 (Banking, Settings), and Timesheets ×2 under different labels ("My Timesheet" / "Timesheets (Week View)"). | `navSections/tax.ts:20-21`; `sales.ts:53`; `purchases.ts:60`; `accounting.ts:39`; full list in `navcode-graph.mjs` output ("duplicate nav hrefs"). | Remove the EMP201 twin. Give each page one home and use cross-links elsewhere (see NAV-06). |
| NAV-19 | P2 | consistency | Journals / CoA / periods | Nav "Journal Entries" (`/accounting/journal-entries`) is a client-side redirect to the Dashboard's `?tab=journal-entries`: the user sees a spinner flash, then the dashboard hero. CoA and Fiscal Periods exist both as dashboard tabs and as standalone pages. Their `PageHeader.backLink` is labelled "Accounting" but goes to `/accounting`, the Dashboard. | `pages/accounting/journal-entries/index.tsx:9`; `pages/accounting/index.tsx:25-30,97-104`; `chart-of-accounts/index.tsx:44`; `fiscal-periods/index.tsx:19`. | Make Journal Entries a real page like CoA and Fiscal Periods. Strip the ledger tabs from the dashboard. |
| NAV-20 | P2 | consistency | Settings cog | "Banking Settings" opens `company-settings?tab=general` ("General Settings"), which has no banking section. The Settings cog also holds operational work that belongs in modules: Document Capture, Approvals, Time Tracking, Timesheets, and Group Consolidation (8 links, two engines, see duplicates). | `navSections/banking.ts:42`; `src/components/accounting/settings/settingsNav.ts:38-39`; `navSections/settings.ts:14-67`. | Keep the cog for configuration only. Move the workflow pages into their modules. |
| NAV-21 | P2 | navigation | Payroll cancel buttons | "Cancel" on `/payroll/batches/new` and `/payroll/loans/new` is `router.back()`. On a deep link or new tab it leaves the app. | `pages/payroll/batches/new.tsx:156`; `pages/payroll/loans/new.tsx:253`. | Use explicit parent hrefs, as every other create page does. |
| NAV-22 | P2 | consistency | Shortcuts | `G then T` always opens the VAT return. For a non-VAT company the nav strips VAT pages and the Library "Tax" tile points to `/accounting/sars`, but the shortcut still lands on the VAT return. `G then B` goes to bank-transactions, while the Banking tab has no href. | `src/components/layout/AppLayout.tsx:216-222`; `navSections/library.ts:69-75`; `navSections/vatNav.ts`. | Drive the shortcuts from `libraryModulesFor(isVatRegistered)`. |
| NAV-23 | P2 | consistency | Page headers | Pages use 3 header patterns plus ad-hoc ones. `<PageHeader>` is used by **18** pages. **319** AppLayout pages hand-roll an `<h1>`: the "ff header band" (`border-b … bg-[var(--ff-bg-secondary)] px-6 py-4`) in **98** pages, the dark gradient hero (`from-slate-900 via-slate-800`) in **22**, and the rest are one-offs. Create forms mostly use the gradient hero, and lists and details mostly use the band, so the same flow changes look on each step. | `$AUD/navcode/scan.json` (fields `pageHeader`, `hand_h1`). `grep` counts in this report. Example: `pages/accounting/customer-invoices/new.tsx:104-107` (hero) vs `[invoiceId].tsx:185` (band). | Migrate to `PageHeader` with an optional crumb slot (NAV-10). Retire the gradient hero outside the dashboard. |
| NAV-24 | P2 | consistency | Buttons, modals, feedback | The design-system primitives are mostly unused. `<Button>`: 42 uses vs **1,574** raw `<button>` (124 files hand-code `bg-teal-600`). `ui/Modal`: 4 files vs **76** hand-rolled `fixed inset-0` overlays. There are 3 confirm components (`ui/ConfirmDialog` ×4, `accounting/ConfirmDialog` ×5, `admin/ConfirmModal` ×10) plus **48** `window.confirm`, **9** `prompt()` and 8 `alert()` call sites (e.g. deleting a customer uses `alert`, and a payroll-run reason uses `prompt`). There are 2 toast systems: react-hot-toast via `utils/toast` (31 files), and `ui/Toast`, which has no provider in `_app` and is used only by the showcase. **285** pages hand-roll `setError` banners. `EmptyState`: 4 files. `Skeleton`: 13 files vs `Loader2` spinners in 491. | `src/components/ui/index.ts`; `pages/_app.tsx:4,111`; `pages/accounting/customers/[customerId].tsx:131`; `pages/payroll/runs/[id].tsx:127`; counts from `grep` (commands in the session log). | Pick one of each (Button, Modal, ConfirmDialog, toast, EmptyState, Skeleton), add a lint rule banning `window.confirm/alert/prompt` in `pages/`, and migrate module by module. |
| NAV-25 | P2 | consistency | Number and date formatting | There are at least 6 shared money helpers (`utils/formatters.formatCurrency` in 81 files, `lib/money/formatMoney`, `lib/format/money.formatMoney`, `<Money>` in 3 files, `loans/types.fmt`, `capture/fmtZAR`) plus **140 local `fmt`/`fmtZAR`/`fmtCurrency` definitions** (91 are `const fmt =`), **131** inline `new Intl.NumberFormat`, **85** `.toFixed(` and **26** `toLocaleString()` calls with no locale. There are 8 `toLocaleDateString()` calls with no locale, which render US-style dates on a non-ZA browser (inference from JS semantics, not observed). Worst pages: `/accounting/sars/vat201` (7 local fmts, 11 toFixed), `/accounting` (6/9), `/accounting/bank-transactions` (5/5), `/accounting/sars/emp201` (9 toFixed). | `src/lib/money/formatMoney.ts:15`, `src/lib/format/money.ts:19`, `src/utils/formatters.ts:6`; `pages/accounting/journal-entries/[entryId].tsx`, `src/components/accounting/settings/DetailsTab.tsx` (no-locale dates); per-page counts in `scan.json`. | One `formatMoney` (R, thousands separator, negatives in brackets or minus, decided once) and one `formatDate` (dd MMM yyyy, en-ZA). Codemod the local `fmt`s. |
| NAV-26 | P2 | consistency | Table density toggle | Every page header shows a comfortable/compact density toggle, but only 2 components read it (`TrialBalanceRow`, `AuditLogTable`). The other 290 files with raw `<table>` ignore it, so on most pages the control does nothing. | `src/components/layout/AppLayout.tsx:443`; `grep useTableDensity` → `src/components/reports/TrialBalanceRow.tsx`, `src/components/accounting/audit-log/AuditLogTable.tsx`. | Apply density through a CSS variable on `<main>` (`--ff-density-y` already exists in `styles/globals.css:92`) or hide the toggle. |
| NAV-27 | P2 | visual | Page wrappers | **250** pages under AppLayout wrap their content in `min-h-screen`, inside a main area that is already `h-screen` and scrolls (`AppLayout.tsx:314,485-490`). This is **likely** to add a viewport's worth of empty scroll below short pages and centre loading spinners off-screen. I infer this from the CSS and have not checked it visually. | `grep -rl min-h-screen pages/accounting pages/payroll` → 250; `src/components/layout/AppLayout.tsx:485-490`. | Drop `min-h-screen` from page roots. The layout owns height. |
| NAV-28 | P2 | consistency | Dead nav code and legacy paths | Besides the 7 unused nav files (NAV-07), `activeTab.ts` still lists `/accounting/dunning` (a redirect stub), `/accounting/currencies` and `/accounting/exchange-rates` (orphans), and `/payroll/emp201` (no such route). The file header describes the old "Option B 9-menu spine", not the current 5-tab front door. Admin → Company → Billing "Create subscription" goes to `/admin/billing/subscriptions/new`, which does not exist. | `activeTab.ts:1-9,56,105,125-126`; `pages/accounting/dunning/index.tsx:15-17`; `src/components/admin/companies/BillingTabParts.tsx:224`. | Delete, and regenerate the resolver per NAV-05. |
| NAV-29 | IDEA | idea | AI with no UI surface | Server-side AI endpoints with **zero** UI callers (the only callers are e2e "does not 404" tests): `nl-query` (natural-language questions over the ledger), `ai-narrative` and `ai-commentary` (report commentary), AFS `sections/[id]/ai-narrative` (IFRS note drafting via `noteAiService`), `anomaly-scan`, `smart-reminder`, `ai-forecast`, `ai-categorize`, `multi-doc-match`, `continuous-close`, `month-end-close`, and `portal/chat` (a client-facing chatbot). | `pages/api/accounting/{nl-query,ai-narrative,ai-commentary,ai-forecast,ai-categorize,anomaly-scan,smart-reminder,multi-doc-match,continuous-close,month-end-close}.ts`; `pages/api/accounting/afs/[documentId]/sections/[sectionId]/ai-narrative.ts`; `pages/api/portal/chat.ts`. Callers: `tests/e2e/sprint1{0,2,3,4,5,6,7,8}-*.spec.ts` only. | Surface them where the numbers are. Put an "Ask" box in Ctrl+K backed by `nl-query`, an "Explain this" narrative panel on IS/BS/TB and management packs, anomaly flags on the Month-End workbench, "Draft note" on AFS sections, and the chatbot on the client portal. |
| NAV-30 | IDEA | idea | MCP-only capabilities | These agent tools have no in-app equivalent: `list_agent_postings` (what unattended agents posted), `propose_reclassification` / `post_reclassification_batch`, `data_integrity_checks`, `chart_of_accounts_health`, `reconcile_subledger` (AR/AP vs GL), `reconcile_fixed_assets`, `merge_gl_accounts`. An accountant cannot see or review agent postings in the product. The MCP settings page only configures the connector. | `src/lib/mcp/tools/{agentActivity.ts:19,integrity.ts:41,108,reconcileSubledger.ts:100,reclassificationPropose.ts:44,writeMergeGlAccounts.ts,reconcileFixedAssets.ts}`; `grep` finds no page using these; `pages/accounting/settings/integrations-mcp.tsx`. | Add an "Agent activity" review inbox (approve/undo), a "Books health" card (integrity + CoA health + subledger-vs-GL) on Month-End, and reclassification proposals as one-click suggestions on the TB. |
| NAV-31 | IDEA | idea | Existing AI surfaces are scattered | The AI that is exposed is buried in inconsistent places. The Close agent appears only on the Month-End workbench (`CloseAgentPanel`). Supplier Expectations (learned billing cadence) is orphaned (NAV-07). The AI cash-flow forecast has two pages, and the richer one is orphaned. Scan & Fill appears on only 4 create forms. Auto-post LLM config lives in Accounting Settings. Fraud signals sit under Purchases › Capture. Smart categorise appears only inside Bank Transactions. There is no single place to see "what AI did / suggests for me today". | `pages/accounting/month-end-workbench.tsx` (CloseAgentPanel); `src/components/accounting/ScanAndFillButton.tsx` consumers: `customer-invoices/new`, `supplier-invoices/new`, `customer-payments/new`, `supplier-payments/new`; `pages/accounting/accounting-settings.tsx` (AutoPostLlmSection); `navSections/purchases.ts:47`; `src/components/accounting/bank-transactions/useBankTxActions.ts:91,210`. | Create one "Inbox / To-do" home (the bureau cockpit is the natural host) that mixes human to-dos with AI suggestions (categorisations, matches, anomalies, missing invoices, expected bills) and a one-click next action on each row. |
| NAV-32 | IDEA | idea | Duplicate-page consolidation | See the table below: about 15 groups of pages do the same job. Four of them are backed by **different tables or services**: products vs items, `supplier_purchase_orders` vs `purchase_orders`, `company-groups` vs `consolidation`, and the two time-entry services. That is a correctness risk, not just clutter. | See "Duplicate pages" below. | Consolidate in the order given in "Top 5" below. |

### Duplicate pages (task item 4)

| Group | Pages | Both/all linked? | Do they differ? | Should win |
|---|---|---|---|---|
| AR aging | `/accounting/ar-aging` (Sales › Reports) · `/accounting/reports/ar-aging` (Reports › Aging) | Both in nav | Different grain and engine: per-customer (`arAgingService`, invoice drill with return context) vs per-invoice (`reports-ar-aging`, rows capped at 1,000 with a banner). **Totals agree**: live demo API returned 10,819,135.43 from both, and each bucket matches. | `/accounting/ar-aging`, with an invoice-level expand. Make the Reports entry point to it. |
| AP aging | `/accounting/ap-aging` · `/accounting/reports/ap-aging` | Both in nav | Same split. Totals agree live (3,167,625.84). | `/accounting/ap-aging` |
| Dunning | `/accounting/dunning` (redirect stub) · `/accounting/ar/dunning` + `/runs` | Stub unlinked | Stub only redirects (`pages/accounting/dunning/index.tsx:15-17`) | `/accounting/ar/dunning`. Delete the stub and its `activeTab` entry. |
| Customer statements | `/customer-statements` (+`[clientId]`) "Statements" · `/customers/statement` "Generate Statement" · `/statement-run` "Statement Run" · `/statements` "Send Statements" | All 4 in Sales nav | Overlapping jobs: list/preview, date-range PDF, batch download, bulk email. All call `customer-statement(s)` APIs. | One Statements workspace: single preview, then batch (download or email) as a mode. |
| Supplier statements | `/supplier-statements` (balances) · `/ap/supplier-statements` (statement **reconciliation**, PRD-05 P7) | Only the first is linked. The second is orphaned (NAV-07). | Different jobs | Merge: reconciliation becomes a tab on the supplier statement. |
| Currencies | `/accounting/currencies` (manage: POST/PUT) · `/accounting/settings/currencies` (read-only) | Only the **read-only** one is linked | Yes. The linked page cannot manage. | The `/accounting/currencies` functionality at the `/settings/currencies` URL. |
| Exchange rates | `/accounting/exchange-rates` (91-line panel) · `/accounting/settings/exchange-rates` (full CRUD + converter) | Only settings linked | Settings is a superset | `/settings/exchange-rates`. Delete the other. |
| Time | `/timesheets` · `/time-tracking` · `/practice/time-entry` | All linked (2 under Settings) | 2 services and 2 invoicing paths on one table. They caused a double-billing bug (NAV-14). | Practice › Time + WIP |
| Cash-flow forecast | `/accounting/cash-flow-forecast` (427 lines) · `/accounting/reports/cash-flow-forecast` (249) | Only the reports one | Same API; the orphan has more UI | `/reports/cash-flow-forecast`, with the orphan's extra sections merged in |
| Items vs products | `/accounting/items` · `/accounting/products` (+new/[id]) | Only items | **Different tables** (`items` vs `products`) | Items. Retire products after checking for data. |
| Purchase orders | `/accounting/purchase-orders` · `/accounting/supplier-purchase-orders` | Only the first | **Different tables and services** (`procurementService`/`purchase_orders` vs `purchaseOrderService`/`supplier_purchase_orders`) | Decide which table three-way match reads, then keep only that one. |
| Audit trail | `/accounting/audit-log` ("Audit Trail" in Accounting and Reports) · `/accounting/reports/audit-trail` (hub-only) | Different reach | Different data: field-level change log vs GL journal audit trail. Both are labelled "Audit Trail". | Keep both, rename them ("Change log" / "Journal audit trail"), and link them to each other. |
| Document capture | `/document-capture` (Settings cog) · `/capture/inbox` (Purchases) · `/capture` (PWA camera, linked only from capture settings) | Mixed | Two ingestion pipelines (`document-capture` API vs `capture/*`) | One Capture inbox under Purchases, with camera upload as an action. |
| Group consolidation | `/accounting/group/*` (6 pages) · `/accounting/consolidation` | Both in the Settings cog | Different APIs (`company-groups`/`consolidated-reports` vs `consolidation/*`) | `/accounting/group`. Also move it out of Settings. |
| Year-end | `/accounting/year-end` · `/accounting/financial-years` ("close the year-end") · `/payroll/year-end` (shadowed, NAV-02) | First two in Accounting › Periods | Both GL pages claim year-end close | Financial Years with a year-end step. Restore the payroll page. |
| Reports landing | `/accounting/reports` (hub, no menu entry) · `/accounting?tab=reports` (4 tiles) · Library › Reports → Income Statement | Mixed | Three landings | `/accounting/reports` (NAV-11) |
| Journals / CoA / periods | Dashboard tabs · standalone pages | Both | Same data | Standalone pages (NAV-19) |
| Data import | Migration Wizard · External import · Sage Migration · GL Import · Bank Import (5 entries in Settings › Data Import) | All linked | Distinct importers, one entry each | One "Import data" launcher that picks the source |

### AI surfaces (task item 5): where they are and whether the UI shows them

| Capability | Backend | UI surface |
|---|---|---|
| Bank smart categorisation / learning | `smart-categorize`, `llmCategorizationPass` | Bank Transactions only (`useBankTxActions.ts:91,210`) |
| Confidence auto-post | `bank-auto-post`, `autoPostGateService` | Accounting Settings (`AutoPostLlmSection`) and the Bank Tx runs panel |
| Document OCR / VLM extract (Scan & Fill) | `vlm-extract`, `ocrService` | 4 create forms, plus the Capture inbox and Document capture |
| Receipt auto-match | `ar/receipt-match` | Sales › Receipt Auto-Match |
| Fraud signals | `fraud/*` + cron | Purchases › Capture › Fraud Signals |
| Three-way match | `supplier-invoices/[id]/three-way-match` | Supplier invoice detail |
| Close agent | `close-run/*` | Month-End workbench only |
| Pack commentary (approve/reject) | `commentary/*`, `packAiSummaryService` | Report packs and shared packs |
| AI cash-flow forecast | `cash-flow-forecast`, `cashFlowForecastAiService` | 2 pages, the richer one orphaned |
| Supplier billing expectations | `cron/expectations-daily` | Orphaned page (`/accounting/suppliers/expectations`) |
| Onboarding extraction | `onboarding/extract`, `extract-id` | Onboarding wizard |
| **NL query, report narrative, AI commentary, AFS note drafting, anomaly scan, smart reminder, AI forecast, multi-doc match, continuous close, client chatbot** | endpoints listed in NAV-29 | **None** |
| **Agent postings review, reclassification proposals, integrity / CoA health, subledger reconciliation, FA reconciliation, account merge** | MCP tools (NAV-30) | **None (MCP only)** |

## Page inventory

This is a static per-page table. "Loads?" was not tested in a browser for this area. Routes verified live by `curl`:
`/accounting/dashboard` 404, `/accounting/ar` 404, `/accounting/settings/company` 404, `/privacy` `/terms` `/security` 404,
`/payroll/year-end` 307→`/accounting/year-end`, `/accounting/practice/reports` 200, `/accounting/sales-reps` 200,
`/accounting/cash-flow-forecast` 200, `/accounting/currencies` 200.

How to read the columns:
- **Header:** `PageHeader` component vs a hand-rolled `<h1>`.
- **Breadcrumb:** `Breadcrumb` component, hand-rolled, or none (—).
- **Back / Cancel target:** the href next to an ArrowLeft/ChevronLeft/"Back to" affordance in the page file.
- **Post-save / redirect:** literal `router.push/replace` targets in the page file.
- **Top tab → module:** `getActiveTabId → getActiveModuleId` computed by running the real `activeTab.ts`.
- **Reach:** `nav` = in the live nav, create menu, Ctrl+K actions or shortcuts; `link-only (n)` = only in-page links; `ORPHAN` = none.
- **Flags:** automatic checks.

| Route | Layout | Header | Breadcrumb | Back / Cancel target | Post-save / redirect (router.push in page) | Top tab → module | Reach | Flags |
|---|---|---|---|---|---|---|---|---|
| /accept-invite | none | hand-rolled h1 | — | — | '/invite/${encodeURIComponent(token)}' ; '/accounting/dashboard | n/a | ORPHAN |  |
| /accounting/accounting-settings | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/adjustments | AppLayout | hand-rolled h1 | — | — | '/accounting/adjustments?type=customer ; '/accounting/adjustments?type=supplier | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/afs/[documentId]/compliance | AppLayout | hand-rolled h1 | hand (AFS › Document › …) | /accounting/afs/[documentId] (crumb) | — | library→reports | link-only (3) |  |
| /accounting/afs/[documentId] | AppLayout | hand-rolled h1 | hand (AFS › doc) | /accounting/afs (crumb) | '/accounting/afs/${documentId}/compliance' | library→reports | link-only (5) |  |
| /accounting/afs | AppLayout | PageHeader | — | — | — | library→reports | nav |  |
| /accounting/afs/management-packs | AppLayout | hand-rolled h1 | — | — | — | library→reports | nav |  |
| /accounting/afs/mapping | AppLayout | PageHeader | — | — | — | library→reports | ORPHAN | orphan |
| /accounting/afs/pis-score | AppLayout | PageHeader | — | — | — | library→reports | ORPHAN | orphan |
| /accounting/afs/portal-contacts | AppLayout | PageHeader | — | — | — | library→reports | nav |  |
| /accounting/afs/portal/dashboard | none | none | — | — | — | n/a | link-only (5) |  |
| /accounting/afs/portal/documents/[documentId] | none | none | — | /accounting/afs/portal/dashboard | — | n/a | link-only (2) |  |
| /accounting/afs/portal/login | none | hand-rolled h1 | — | — | — | n/a | link-only (4) |  |
| /accounting/afs/report-templates | AppLayout | PageHeader | — | — | — | library→reports | ORPHAN | orphan |
| /accounting/afs/sign/[token] | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |
| /accounting/ap-aging | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/ap/supplier-statements/[id] | AppLayout | hand-rolled h1 | — | /accounting/ap/supplier-statements' ("Back to statements") | '/accounting/ap/supplier-statements ; '/accounting/supplier-invoices/${line.matchedSupplierInvoiceId}' ; '/accounting/supplier-invoices/${inv.invoiceId}' | dashboard→dashboard | link-only (2) | tab falls to Dashboard |
| /accounting/ap/supplier-statements | AppLayout | hand-rolled h1 | — | — | '/accounting/ap/supplier-statements/${json.data.id}' ; '/accounting/ap/supplier-statements/${s.id}' | dashboard→dashboard | link-only (1) | tab falls to Dashboard |
| /accounting/approvals | AppLayout | PageHeader | — | — | — | settings→settings | nav |  |
| /accounting/ar-aging | AppLayout | hand-rolled h1 | — | — | location= '/api/accounting/ar-aging-export?${params}' | library→sales | nav |  |
| /accounting/ar/dunning | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/ar/dunning/runs | AppLayout | hand-rolled h1 | — | /accounting/ar/dunning ("Back to templates") | — | library→sales | nav |  |
| /accounting/ar/receipt-match | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/ar/settings/sent-mirror | AppLayout | hand-rolled h1 | — | /accounting/ar | — | library→sales | nav |  |
| /accounting/assets/[assetId] | AppLayout | hand-rolled h1 | — | /accounting/assets ("Back to Assets") | '/accounting/assets | library→accounting | link-only (9) |  |
| /accounting/assets/below-threshold | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/assets/categories | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/assets/disposals | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/assets/far-report | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/assets | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/assets/new | AppLayout | hand-rolled h1 | — | /accounting/assets ("Back to Assets") | '/accounting/assets | library→accounting | nav |  |
| /accounting/assets/register | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/audit-log | AppLayout | hand-rolled h1 | — | — | '/api/accounting/audit-log-export?${params.toString()}' | library→accounting | nav |  |
| /accounting/audit-packs | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/auto-postings | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/bank-accounts | AppLayout | hand-rolled h1 | — | — | — | banking→banking | nav |  |
| /accounting/bank-feeds | AppLayout | hand-rolled h1 | — | — | — | banking→banking | nav |  |
| /accounting/bank-reconciliation/[reconId] | AppLayout | hand-rolled h1 | — | /accounting/bank-reconciliation ("Back to Reconciliations") | '/accounting/bank-reconciliation | banking→banking | link-only (10) |  |
| /accounting/bank-reconciliation/import | AppLayout | hand-rolled h1 | — | /accounting/bank-reconciliation ; /accounting/bank-reconciliation ("Back to bank reconciliation") | — | banking→banking | nav |  |
| /accounting/bank-reconciliation | AppLayout | hand-rolled h1 | — | — | — | banking→banking | nav |  |
| /accounting/bank-reconciliation/new | AppLayout | hand-rolled h1 | — | /accounting/bank-reconciliation ("Back to Reconciliations") | '/accounting/bank-reconciliation/${data.id}' | banking→banking | link-only (1) |  |
| /accounting/bank-reconciliation/rules | AppLayout | hand-rolled h1 | — | — | — | banking→banking | nav |  |
| /accounting/bank-transactions | AppLayout | hand-rolled h1 | — | — | — | banking→banking | nav |  |
| /accounting/bank-transactions/new | AppLayout | hand-rolled h1 | — | /accounting/bank-transactions ("Back to Bank Transactions") | '/accounting/bank-transactions | banking→banking | link-only (1) |  |
| /accounting/bank-transfers | AppLayout | hand-rolled h1 | — | — | — | banking→banking | nav |  |
| /accounting/bank/provisional | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/bank/queries | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/bank/statements/import-pdf | AppLayout | hand-rolled h1 | — | /accounting/bank/statements' ("Back to imports") | '/accounting/bank/statements/import-pdf?id=${json.data.id}' ; '/accounting/bank/statements | dashboard→dashboard | link-only (2) | tab falls to Dashboard |
| /accounting/bank/statements | AppLayout | hand-rolled h1 | — | — | '/accounting/bank/statements/import-pdf ; '/accounting/bank/statements/import-pdf?id=${imp.id}' | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/batch-payments/[batchId] | AppLayout | hand-rolled h1 | — | /accounting/batch-payments | — | library→purchases | link-only (3) |  |
| /accounting/batch-payments | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/batch-payments/new | AppLayout | hand-rolled h1 | — | /accounting/batch-payments ("Back to Batches") | '/accounting/batch-payments | library→purchases | link-only (1) |  |
| /accounting/budgets | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/business-units | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/capture/inbox | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/capture | AppLayout | hand-rolled h1 | — | — | '/accounting/capture/inbox | dashboard→dashboard | link-only (1) | tab falls to Dashboard |
| /accounting/capture/settings | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/capture/settings/mirror | AppLayout | hand-rolled h1 | — | /accounting/capture/settings | — | dashboard→dashboard | link-only (1) | tab falls to Dashboard |
| /accounting/cash-flow-forecast | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | ORPHAN | orphan; tab falls to Dashboard |
| /accounting/cashbook | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/chart-of-accounts | AppLayout | PageHeader | — | /accounting ("Accounting") | — | library→accounting | nav | back→Dashboard |
| /accounting/company-settings | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/consolidation | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/cost-centres | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/credit-notes/[creditNoteId] | AppLayout | hand-rolled h1 | — | /accounting/credit-notes ("Back to Credit Notes") | '/accounting/credit-notes | library→sales | link-only (3) |  |
| /accounting/credit-notes | AppLayout | hand-rolled h1 | — | — | location= '/accounting/credit-notes/${cn.id}' | library→sales | nav |  |
| /accounting/credit-notes/new | AppLayout | hand-rolled h1 | — | /accounting/credit-notes ("Back to Credit Notes") | '/accounting/credit-notes | library→sales | link-only (2) |  |
| /accounting/currencies | AppLayout | hand-rolled h1 | — | — | — | library→accounting | ORPHAN | orphan |
| /accounting/customer-allocations | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/customer-categories | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/customer-invoices/[invoiceId] | AppLayout | hand-rolled h1 | Breadcrumb | trail.back.href | '/accounting/customer-invoices/${prevId}' ; '/accounting/customer-invoices/${nextId}' | library→sales | link-only (25) |  |
| /accounting/customer-invoices/edit/[invoiceId] | AppLayout | hand-rolled h1 | — | /accounting/customer-invoices/${String(invoiceId)} ("Back to Invoice") | '/accounting/customer-invoices/${String(invoiceId)}' | library→sales | link-only (1) |  |
| /accounting/customer-invoices | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/customer-invoices/new | AppLayout | hand-rolled h1 | — | /accounting/customer-invoices ("Back to Invoices") | '/accounting/customer-invoices/new ; '/accounting/customer-invoices/${d.id}' | library→sales | nav |  |
| /accounting/customer-payments/[paymentId] | AppLayout | hand-rolled h1 | — | /accounting/customer-payments | — | library→sales | link-only (8) |  |
| /accounting/customer-payments | AppLayout | PageHeader | — | — | '/accounting/customer-payments/new ; '/accounting/customer-payments/${p.id}' | library→sales | nav |  |
| /accounting/customer-payments/new | AppLayout | hand-rolled h1 | — | /accounting/customer-payments ("Back to Payments") | '/accounting/customer-payments | library→sales | nav |  |
| /accounting/customer-quotes | AppLayout | PageHeader | — | — | '/accounting/customer-sales-orders/${json.data?.salesOrderId \|\| json.salesOrderId}' ; '/accounting/customer-sales-orders/${existingOrderId}' ; '/accounting/customer-invoices/${successMsg.invoiceId}' | library→sales | nav |  |
| /accounting/customer-sales-orders/[id] | AppLayout | hand-rolled h1 | — | /accounting/customer-sales-orders' ("Back to Orders") ; /accounting/customer-sales-orders | '/accounting/customer-invoices/${invoiceId}' ; '/accounting/customer-sales-orders | library→sales | link-only (4) |  |
| /accounting/customer-sales-orders | AppLayout | PageHeader | — | — | '/accounting/customer-sales-orders/${o.id}' | library→sales | nav |  |
| /accounting/customer-statements/[clientId] | AppLayout | hand-rolled h1 | — | /accounting/customer-statements ("Back to Customer Statements") ; /accounting/customer-statements | url | library→sales | link-only (3) |  |
| /accounting/customer-statements | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/customers/[customerId] | AppLayout | hand-rolled h1 | — | /accounting/customers ("Back to Customers") | '/accounting/customers ; '${TYPE_PATHS[row.type]}/${row.id}' | library→sales | link-only (14) |  |
| /accounting/customers/dedup | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/customers | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/customers/new | AppLayout | hand-rolled h1 | — | /accounting/customers | '/accounting/customers/new ; '/accounting/customers/${json.data?.id ??  | library→sales | nav |  |
| /accounting/customers/statement | AppLayout | hand-rolled h1 | — | /accounting/customer-statements ("Back to Customer Statements") | — | library→sales | nav |  |
| /accounting/data-archiving | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/debtors-manager | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/default-accounts | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/delivery-notes/[id] | AppLayout | hand-rolled h1 | — | /accounting/delivery-notes | '/accounting/delivery-notes ; '/accounting/customer-sales-orders/${note.salesOrderId}' ; '/accounting/customer-invoices/${note.invoiceId}' | dashboard→dashboard | link-only (3) | tab falls to Dashboard |
| /accounting/delivery-notes | AppLayout | hand-rolled h1 | — | — | '/accounting/delivery-notes/new ; '/accounting/delivery-notes/${n.id}' | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/delivery-notes/new | AppLayout | hand-rolled h1 | — | /accounting/delivery-notes ("Back to Delivery Notes") | '/accounting/delivery-notes | dashboard→dashboard | link-only (2) | tab falls to Dashboard |
| /accounting/depreciation | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/disputes | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/document-capture/[docId] | AppLayout | hand-rolled h1 | — | /accounting/document-capture ("Back to Document Capture") ; /accounting/document-capture | — | settings→settings | link-only (1) |  |
| /accounting/document-capture | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/drc-vat | AppLayout | hand-rolled h1 | — | — | — | library→tax | nav |  |
| /accounting/dunning | none | none | — | — | '/accounting/ar/dunning/runs | n/a | ORPHAN | no layout |
| /accounting/duplicates | AppLayout | PageHeader | — | — | — | settings→settings | nav |  |
| /accounting/exchange-rates | AppLayout | hand-rolled h1 | — | — | — | library→accounting | ORPHAN | orphan |
| /accounting/expenses/[id] | AppLayout | hand-rolled h1 | — | /accounting/expenses | — | dashboard→dashboard | link-only (5) | tab falls to Dashboard |
| /accounting/expenses | AppLayout | hand-rolled h1 | — | — | location= '/accounting/expenses/${c.id}' | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/expenses/new | AppLayout | hand-rolled h1 | — | /accounting/expenses | '/accounting/expenses/${json.data.claim.id}' | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/financial-years | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/fiscal-periods | AppLayout | PageHeader | — | /accounting ("Accounting") | — | library→accounting | nav | back→Dashboard |
| /accounting/fraud/signals | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/gl-import | AppLayout | hand-rolled h1 | — | — | '/accounting/journal-entries | settings→settings | nav |  |
| /accounting/goods-received | AppLayout | PageHeader | — | — | '/accounting/goods-received/new | library→purchases | nav |  |
| /accounting/goods-received/new | AppLayout | hand-rolled h1 | — | /accounting/goods-received ("Back to Goods Received") | '/accounting/goods-received | library→purchases | link-only (3) |  |
| /accounting/group/balance-sheet | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/group/eliminations | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/group/income-statement | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/group | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/group/intercompany | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/group/setup | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/group/trial-balance | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting | AppLayout | hand-rolled h1 | — | — | '/accounting ; '/onboarding ; '/accounting/chart-of-accounts | dashboard→dashboard | nav |  |
| /accounting/item-adjustments | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/item-categories | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/item-opening-balances | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/item-pricing | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/items/[itemId] | AppLayout | hand-rolled h1 | — | /accounting/items ("Back to Items") | — | library→inventory | link-only (4) |  |
| /accounting/items | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/items/new | AppLayout | hand-rolled h1 | — | /accounting/items ("Back to Items") | '/accounting/items | library→inventory | nav |  |
| /accounting/journal-entries/[entryId] | AppLayout | hand-rolled h1 | — | /accounting?tab=journal-entries | — | library→accounting | link-only (22) | back→Dashboard |
| /accounting/journal-entries | AppLayout | none | — | — | '/accounting?tab=journal-entries | library→accounting | nav |  |
| /accounting/journal-entries/new | AppLayout | hand-rolled h1 | — | /accounting?tab=journal-entries ("Back to Journal Entries") | '/accounting/journal-entries/${entry.id}' | library→accounting | nav | back→Dashboard |
| /accounting/library | AppLayout | hand-rolled h1 | — | — | — | library→dashboard | nav |  |
| /accounting/loans/[id] | AppLayout | hand-rolled h1 | — | /accounting/loans ("Back to Portfolio") ; /accounting/loans | — | dashboard→dashboard | link-only (11) | tab falls to Dashboard |
| /accounting/loans | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/loans/new | AppLayout | hand-rolled h1 | — | /accounting/loans | '/accounting/loans/${json.data.id}' | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/loans/period-close | AppLayout | hand-rolled h1 | — | /accounting/loans | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/loans/rate-curves | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/migration/ap-invoices | AppLayout | hand-rolled h1 | — | /accounting/migration ("Back to Migration Hub") | — | settings→settings | link-only (1) |  |
| /accounting/migration/ar-invoices | AppLayout | hand-rolled h1 | — | /accounting/migration ("Back to Migration Hub") | — | settings→settings | link-only (1) |  |
| /accounting/migration/chart-of-accounts | AppLayout | hand-rolled h1 | — | /accounting/migration ("Back to Migration Hub") | — | settings→settings | link-only (1) |  |
| /accounting/migration/customers | AppLayout | hand-rolled h1 | — | /accounting/migration ("Back to Migration Hub") | — | settings→settings | link-only (1) |  |
| /accounting/migration/external | AppLayout | hand-rolled h1 | — | /accounting/migration ("Back to Migration Wizard") | — | settings→settings | nav |  |
| /accounting/migration | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/migration/opening-balances | AppLayout | hand-rolled h1 | — | /accounting/migration ("Back to Migration Hub") | — | settings→settings | link-only (1) |  |
| /accounting/migration/suppliers | AppLayout | hand-rolled h1 | — | /accounting/migration ("Back to Migration Hub") | — | settings→settings | link-only (1) |  |
| /accounting/migration/validate | AppLayout | hand-rolled h1 | — | /accounting/migration ("Back to Migration Hub") | — | settings→settings | link-only (1) |  |
| /accounting/month-end-workbench | AppLayout | hand-rolled h1 | — | — | — | workbench→dashboard | nav |  |
| /accounting/my-account | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/netcash | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/opening-balances | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/portfolio-workbench | AppLayout | hand-rolled h1 | — | — | '/accounting/month-end-workbench?period=${encodeURIComponent(period)}' | portfolio→dashboard | nav |  |
| /accounting/practice/approvals | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/clients/[id] | AppLayout | hand-rolled h1 | — | /accounting/practice/clients ; /accounting/practice/clients ("Back to Clients") | — | library→practice | link-only (8) |  |
| /accounting/practice/clients | AppLayout | hand-rolled h1 | — | — | '/accounting/practice/clients/${id}' | library→practice | nav |  |
| /accounting/practice/clients/new | AppLayout | hand-rolled h1 | — | /accounting/practice/clients | '/accounting/practice/clients/${newId}?welcome=1' ; '/accounting/practice/clients | library→practice | nav |  |
| /accounting/practice/job-categories | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/jobs/[id] | AppLayout | hand-rolled h1 | — | /accounting/practice/jobs ("Back to Jobs") ; /accounting/practice/jobs | '/accounting/practice/jobs | library→practice | link-only (6) |  |
| /accounting/practice/jobs | AppLayout | hand-rolled h1 | — | — | { query: { ...router.query, view: v } }, undefined, { shallow: true } ; '/accounting/practice/jobs/${id}' | library→practice | nav |  |
| /accounting/practice/jobs/new | AppLayout | hand-rolled h1 | — | /accounting/practice/jobs | '/accounting/practice/jobs/${((j as { data?: PracticeJob }).data ?? (j as PracticeJob)).id}' | library→practice | link-only (2) |  |
| /accounting/practice/report-recipients | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/reports/compliance | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/reports | AppLayout | hand-rolled h1 | — | — | — | library→practice | ORPHAN | orphan |
| /accounting/practice/reports/profitability | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/reports/revenue-pipeline | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/reports/service-mix | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/reports/utilisation | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/reports/wip-aging | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/staff-cost-rates | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/staff-rates | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/tasks | AppLayout | hand-rolled h1 | — | — | { query: { ...router.query, tab: t } }, undefined, { shallow: true } | library→practice | nav |  |
| /accounting/practice/time-entry | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/practice/wip | AppLayout | hand-rolled h1 | — | — | — | library→practice | nav |  |
| /accounting/products/[productId] | AppLayout | hand-rolled h1 | — | /accounting/products ("Back to Products") | — | dashboard→dashboard | link-only (3) | tab falls to Dashboard |
| /accounting/products | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | link-only (5) | tab falls to Dashboard |
| /accounting/products/new | AppLayout | hand-rolled h1 | — | /accounting/products | '/accounting/products | dashboard→dashboard | link-only (2) | tab falls to Dashboard |
| /accounting/purchase-orders/[poId] | AppLayout | hand-rolled h1 | — | /accounting/purchase-orders ("Back to Purchase Orders") | '/accounting/purchase-orders | library→purchases | link-only (6) |  |
| /accounting/purchase-orders | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/purchase-orders/new | AppLayout | hand-rolled h1 | — | /accounting/purchase-orders ("Back to Purchase Orders") | '/accounting/purchase-orders/new ; '/accounting/purchase-orders/${json.data?.id ??  | library→purchases | link-only (3) |  |
| /accounting/recurring-invoices/[id] | AppLayout | hand-rolled h1 | — | /accounting/recurring-invoices | '/accounting/recurring-invoices | library→sales | link-only (3) |  |
| /accounting/recurring-invoices | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/recurring-invoices/new | AppLayout | hand-rolled h1 | — | /accounting/recurring-invoices ("Back to Recurring Invoices") | '/accounting/recurring-invoices | library→sales | link-only (2) |  |
| /accounting/recurring-journals | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/recurring-transactions | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/reports/account-detail/[accountId] | AppLayout | hand-rolled h1 | — | backHref | — | library→reports | link-only (3) |  |
| /accounting/reports/account-transactions | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | location= '/api/accounting/account-transactions-export?${params}' | library→reports | nav |  |
| /accounting/reports/ap-aging | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | nav |  |
| /accounting/reports/ar-aging | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | nav |  |
| /accounting/reports/audit-trail | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | location= '/api/accounting/audit-trail-export?${params}' | library→reports | link-only (1) |  |
| /accounting/reports/balance-sheet | AppLayout | hand-rolled h1 | — | /accounting?tab=reports ("Back to Reports") | — | library→reports | nav | back→Dashboard |
| /accounting/reports/bank-transactions | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | location= '/api/accounting/bank-transactions-export?${params}' | library→reports | nav |  |
| /accounting/reports/budget-vs-actual | AppLayout | hand-rolled h1 | — | — | — | library→reports | nav |  |
| /accounting/reports/builder | AppLayout | none | — | /accounting/reports/my-reports | '/accounting/reports/builder?id=${json.data.id}' | library→reports | nav |  |
| /accounting/reports/caseware-export | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | nav |  |
| /accounting/reports/cash-flow-forecast | AppLayout | hand-rolled h1 | — | — | — | library→reports | nav |  |
| /accounting/reports/cash-flow | AppLayout | hand-rolled h1 | — | — | — | library→reports | nav |  |
| /accounting/reports/cash-movement | AppLayout | hand-rolled h1 | — | — | — | library→reports | ORPHAN | orphan |
| /accounting/reports/customer-communication | AppLayout | hand-rolled h1 | — | — | — | library→reports | ORPHAN | orphan |
| /accounting/reports/customer-ledger | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | nav |  |
| /accounting/reports/customer-reports | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | location= '/api/accounting/customer-report-export?${params}' | library→reports | nav |  |
| /accounting/reports/disclosure-notes | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | nav |  |
| /accounting/reports/executive-dashboard | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | link-only (1) |  |
| /accounting/reports/financial-analysis | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | link-only (1) |  |
| /accounting/reports/general-ledger | AppLayout | hand-rolled h1 | — | /accounting ("Back to Accounting") | — | library→reports | link-only (1) | back→Dashboard |
| /accounting/reports/income-statement | AppLayout | hand-rolled h1 | — | /accounting?tab=reports ("Back to Reports") | — | library→reports | nav | back→Dashboard |
| /accounting/reports | AppLayout | hand-rolled h1 | — | — | — | library→reports | nav |  |
| /accounting/reports/item-listing | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/reports/item-movement | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/reports/item-quantities | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/reports/item-valuation | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/reports/journal-entries | AppLayout | hand-rolled h1 | — | — | '/accounting/journal-entries/${entry.id}' | library→reports | nav |  |
| /accounting/reports/management-accounts | AppLayout | hand-rolled h1 | — | /accounting/reports | — | library→reports | link-only (1) |  |
| /accounting/reports/my-reports | AppLayout | hand-rolled h1 | — | — | location= '/accounting/reports/builder?load=${id}' | library→reports | nav |  |
| /accounting/reports/present/[pack] | none | hand-rolled h1 | — | — | '/accounting/reports/report-packs | n/a | link-only (1) |  |
| /accounting/reports/project-profitability | AppLayout | hand-rolled h1 | — | /accounting?tab=reports ("Back to Reports") | — | library→reports | nav | back→Dashboard |
| /accounting/reports/purchases-by-item | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/reports/purchases-by-supplier | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/reports/report-packs | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | link-only (4) |  |
| /accounting/reports/sales-by-customer | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/reports/sales-by-item | AppLayout | hand-rolled h1 | — | — | — | library→inventory | nav |  |
| /accounting/reports/supplier-ledger | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | nav |  |
| /accounting/reports/supplier-pos | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/reports/supplier-reports | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | location= '/api/accounting/supplier-report-export?${params}' | library→reports | nav |  |
| /accounting/reports/three-way-forecast | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | link-only (1) |  |
| /accounting/reports/trend-analysis | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | link-only (1) |  |
| /accounting/reports/unallocated-payments | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/reports/unallocated-receipts | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/reports/vat-reconciliation | AppLayout | PageHeader | — | — | — | library→tax | nav |  |
| /accounting/reports/vat-return | AppLayout | hand-rolled h1 | — | — | — | library→tax | nav |  |
| /accounting/reports/waterfall | AppLayout | hand-rolled h1 | — | /accounting/reports ("Back to Reports") | — | library→reports | link-only (1) |  |
| /accounting/sage-migration | AppLayout | hand-rolled h1 | — | /accounting ("Back to Accounting") | — | settings→settings | nav | back→Dashboard |
| /accounting/sales-reps | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | ORPHAN | orphan; tab falls to Dashboard |
| /accounting/sars/emp201 | AppLayout | hand-rolled h1 | — | /accounting/sars | — | library→tax | nav |  |
| /accounting/sars | AppLayout | hand-rolled h1 | — | — | — | library→tax | nav |  |
| /accounting/sars/submissions | AppLayout | hand-rolled h1 | — | /accounting/sars | — | library→tax | nav |  |
| /accounting/sars/vat-locks | AppLayout | hand-rolled h1 | — | /accounting/sars/vat201 | — | library→tax | nav |  |
| /accounting/sars/vat201 | AppLayout | hand-rolled h1 | — | /accounting/sars | — | library→tax | nav |  |
| /accounting/settings/account-reporting-groups | AppLayout | hand-rolled h1 | — | /accounting/chart-of-accounts | — | library→accounting | nav |  |
| /accounting/settings/billing/compare | AppLayout | hand-rolled h1 | — | /accounting/settings/billing/flows ("Back to Flows") | — | dashboard→dashboard | link-only (1) | tab falls to Dashboard |
| /accounting/settings/billing/flows | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | link-only (6) | tab falls to Dashboard |
| /accounting/settings/billing/flows/return | AppLayout | hand-rolled h1 | — | /accounting/settings/billing/flows ("Back to Flows") | — | dashboard→dashboard | ORPHAN | orphan; tab falls to Dashboard |
| /accounting/settings/connected-apps | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/settings/currencies | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/settings/exchange-rates | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/settings/integrations-mcp | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/statement-run | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/statements | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/stock-levels | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /accounting/supplier-allocations | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/supplier-categories | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/supplier-credit-notes/[id] | AppLayout | hand-rolled h1 | — | /accounting/supplier-credit-notes ("Back to Supplier Credit Notes") | '/accounting/supplier-credit-notes | library→purchases | link-only (2) |  |
| /accounting/supplier-credit-notes | AppLayout | hand-rolled h1 | — | — | '/accounting/supplier-credit-notes/${cn.id}' | library→purchases | nav |  |
| /accounting/supplier-credit-notes/new | AppLayout | hand-rolled h1 | — | /accounting/supplier-credit-notes | '/accounting/supplier-credit-notes | library→purchases | link-only (2) |  |
| /accounting/supplier-invoices/[invoiceId] | AppLayout | hand-rolled h1 | Breadcrumb | /accounting/supplier-invoices ("Back to invoices") ; trail.back.href | — | library→purchases | link-only (12) |  |
| /accounting/supplier-invoices | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/supplier-invoices/new | AppLayout | hand-rolled h1 | — | /accounting/supplier-invoices ("Back to Supplier Invoices") | '/accounting/supplier-invoices/${(invoice as { id: string }).id}' | library→purchases | link-only (5) |  |
| /accounting/supplier-payments/[paymentId] | AppLayout | hand-rolled h1 | — | /accounting/supplier-payments | — | library→purchases | link-only (8) |  |
| /accounting/supplier-payments | AppLayout | PageHeader | — | — | — | library→purchases | nav |  |
| /accounting/supplier-payments/new | AppLayout | hand-rolled h1 | — | /accounting/supplier-payments ("Back to Payments") | '/accounting/supplier-payments/${payment.id}' | library→purchases | link-only (3) |  |
| /accounting/supplier-purchase-orders/[poId] | AppLayout | hand-rolled h1 | — | /accounting/supplier-purchase-orders ("Back to Purchase Orders") | — | library→purchases | link-only (2) |  |
| /accounting/supplier-purchase-orders | AppLayout | PageHeader | — | — | — | library→purchases | link-only (2) |  |
| /accounting/supplier-returns | AppLayout | PageHeader | — | — | — | library→purchases | nav |  |
| /accounting/supplier-statements/[supplierId] | AppLayout | hand-rolled h1 | — | /accounting/supplier-statements?as_at_date=${asAtDate} ("Back to Supplier Statements") ; /accounting/supplier-statements?as_at_date=${asAtDate} | url | library→purchases | link-only (3) |  |
| /accounting/supplier-statements | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/suppliers/[supplierId] | AppLayout | hand-rolled h1 | — | /accounting/suppliers ("Back to Suppliers") | '/accounting/suppliers | library→purchases | link-only (17) |  |
| /accounting/suppliers/[supplierId]/rules | AppLayout | hand-rolled h1 | — | /accounting/suppliers ("Back to Suppliers") ; /accounting/suppliers/${sid} | '/accounting/suppliers/${sid}' | library→purchases | link-only (6) |  |
| /accounting/suppliers/dedup | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/suppliers/expectations | AppLayout | hand-rolled h1 | — | — | — | library→purchases | ORPHAN | orphan |
| /accounting/suppliers | AppLayout | hand-rolled h1 | — | — | — | library→purchases | nav |  |
| /accounting/suppliers/missing-invoices | AppLayout | hand-rolled h1 | — | — | — | library→purchases | link-only (1) |  |
| /accounting/suppliers/new | AppLayout | hand-rolled h1 | — | /accounting/suppliers | '/accounting/suppliers/new ; '/accounting/suppliers/${json.data?.id ??  | library→purchases | nav |  |
| /accounting/suppliers/rules | AppLayout | hand-rolled h1 | — | — | location= '/accounting/suppliers/${r.supplierId}/rules')}> | library→purchases | nav |  |
| /accounting/time-tracking | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/timesheets | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/trial-balance | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /accounting/user-access | AppLayout | PageHeader | — | — | — | settings→settings | nav |  |
| /accounting/vat-adjustments | AppLayout | hand-rolled h1 | — | — | — | library→tax | nav |  |
| /accounting/webhooks | AppLayout | hand-rolled h1 | — | — | — | settings→settings | nav |  |
| /accounting/write-offs | AppLayout | hand-rolled h1 | — | — | — | library→sales | nav |  |
| /accounting/year-end | AppLayout | hand-rolled h1 | — | — | — | library→accounting | nav |  |
| /admin/analytics | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/audit | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/billing/flow-bundles | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | link-only (1) |  |
| /admin/billing | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/billing/invoices | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/billing/payg | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | link-only (1) |  |
| /admin/billing/paystack/return | none | hand-rolled h1 | — | /admin/billing ("Back to billing") | — | n/a | ORPHAN |  |
| /admin/billing/plans | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/billing/subscriptions | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/companies/[id] | AdminLayout+AppLayout | hand-rolled h1 | — | adminHref('/admin/companies') ("Back to Companies") | adminHref('/admin/companies | n/a | link-only (7) |  |
| /admin/companies | AdminLayout+AppLayout | hand-rolled h1 | — | — | location= adminHref('/admin/companies/${companyId}') ; location= adminHref('/admin/companies/${c.id}') | n/a | nav |  |
| /admin/components | AdminLayout+AppLayout | hand-rolled h1 | Breadcrumb | — | — | n/a | nav |  |
| /admin/email-log | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/features | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/health | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/job-queue | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/payroll/sars-codes | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/settings | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/tools/announcements | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/tools | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/tools/migrations | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/tools/sage-import | AdminLayout+AppLayout | hand-rolled h1 | — | adminHref('/admin/tools') ("Back to Admin Tools") | — | n/a | nav |  |
| /admin/trials | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /admin/users/[id] | AdminLayout+AppLayout | hand-rolled h1 | — | adminHref('/admin/users') ("Back to Users") | — | n/a | link-only (5) |  |
| /admin/users | AdminLayout+AppLayout | hand-rolled h1 | — | — | location= adminHref('/admin/users/${u.id}') | n/a | nav |  |
| /admin/waitlist | AdminLayout+AppLayout | hand-rolled h1 | — | — | location= adminHref('/admin/companies/${data.companyId}') | n/a | nav |  |
| /admin/web-analytics | AdminLayout+AppLayout | hand-rolled h1 | — | — | location= '/api/admin/analytics/web/export?website_id=${websiteId}&range=${range}' | n/a | nav |  |
| /admin/webhooks | AdminLayout+AppLayout | hand-rolled h1 | — | — | — | n/a | nav |  |
| /audit-portal/[sessionId] | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |
| /bureau/clients/[companyId] | AppLayout | hand-rolled h1 | — | /bureau/clients ("Back to clients") ; /bureau/clients | item.href | n/a | link-only (2) |  |
| /bureau/clients | AppLayout | hand-rolled h1 | — | /bureau | — | n/a | link-only (3) |  |
| /bureau | AppLayout | hand-rolled h1 | — | — | '/accounting ; item.href | n/a | link-only (2) |  |
| /contact | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |
| /developer/oauth-apps | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /developer/personal-tokens | AppLayout | hand-rolled h1 | — | — | — | dashboard→dashboard | nav | tab falls to Dashboard |
| /forgot-password | none | none | — | /login ("Back to sign in") | — | n/a | ORPHAN |  |
| /home | AppLayout | hand-rolled h1 | — | — | it.href | n/a | ORPHAN | orphan |
| / | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |
| /invite/[token] | none | hand-rolled h1 | — | — | '/accounting | n/a | link-only (1) |  |
| /login | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |
| /oauth/authorize | none | hand-rolled h1 | — | — | location= json.data.redirectTo ; location= url.toString() | n/a | link-only (1) |  |
| /offline | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |
| /onboarding | none | none | — | — | '/login ; location= '/accounting | n/a | link-only (6) |  |
| /payroll/batches/[id] | AppLayout | hand-rolled h1 | — | /payroll/batches | — | library→payroll | link-only (4) |  |
| /payroll/batches | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/batches/new | AppLayout | hand-rolled h1 | — | router.back() | '/payroll/batches/${id}' | library→payroll | link-only (2) |  |
| /payroll/compliance | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/components | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/cost-centres | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/duplicates | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/emp501 | AppLayout | hand-rolled h1 | — | — | — | library→tax | nav |  |
| /payroll/employees/[id] | AppLayout | hand-rolled h1 | — | /payroll/employees | — | library→payroll | link-only (8) |  |
| /payroll/employees/bulk-update | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/employees | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/employees/new | AppLayout | hand-rolled h1 | — | /payroll/employees | '/payroll/employees/${created.id}' | library→payroll | nav |  |
| /payroll/equity/eea2 | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/irp5 | AppLayout | hand-rolled h1 | — | — | — | library→tax | nav |  |
| /payroll/leave/[id] | AppLayout | hand-rolled h1 | — | /payroll/leave | '/payroll/leave ; '/payroll/leave | library→payroll | link-only (6) |  |
| /payroll/leave/balances | AppLayout | hand-rolled h1 | — | /payroll/leave | — | library→payroll | nav |  |
| /payroll/leave | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/leave/new | AppLayout | hand-rolled h1 | — | /payroll/leave | '/payroll/leave | library→payroll | nav |  |
| /payroll/loans/[id] | AppLayout | hand-rolled h1 | — | /payroll/loans | — | library→payroll | link-only (4) |  |
| /payroll/loans | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/loans/new | AppLayout | hand-rolled h1 | — | router.back() | '/payroll/loans/${id}' | library→payroll | link-only (2) |  |
| /payroll/parallel-run | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/pay-packages/[id] | AppLayout | hand-rolled h1 | — | /payroll/pay-packages ("Back to packages") | — | library→payroll | link-only (1) |  |
| /payroll/pay-packages | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/pay-scales | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/runs/[id] | AppLayout | hand-rolled h1 | — | /payroll/runs | — | library→payroll | link-only (10) |  |
| /payroll/runs/[id]/cash-register | AppLayout | hand-rolled h1 | — | /payroll/runs/${runId} ("Back to run") | — | library→payroll | link-only (9) |  |
| /payroll/runs/[id]/cost-centre-summary | AppLayout | hand-rolled h1 | — | /payroll/runs/${id} | — | library→payroll | link-only (9) |  |
| /payroll/runs/[id]/variance | AppLayout | hand-rolled h1 | — | /payroll/runs/${runId} | — | library→payroll | link-only (9) |  |
| /payroll/runs | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/runs/new | AppLayout | hand-rolled h1 | — | /payroll/runs | '/payroll/runs/${created.id}' | library→payroll | nav |  |
| /payroll/tax-directives | AppLayout | hand-rolled h1 | — | — | — | library→tax | nav |  |
| /payroll/training | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/training/wsp-atr | AppLayout | hand-rolled h1 | — | — | — | library→payroll | nav |  |
| /payroll/uif | AppLayout | hand-rolled h1 | — | — | — | library→tax | nav |  |
| /payroll/year-end | AppLayout | hand-rolled h1 | — | — | — | library→tax | link-only (2) |  |
| /portal | none | none | — | — | — | n/a | ORPHAN |  |
| /portal/invoice/[token] | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |
| /portal/pay/[token] | none | none | — | — | location= json.data.checkoutUrl as string ; '/portal/pay/${token}' | n/a | ORPHAN |  |
| /portal/payments/paystack/return | none | hand-rolled h1 | — | router.back() | router.asPath | n/a | ORPHAN |  |
| /pricing | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |
| /register | none | hand-rolled h1 | — | — | '/accept-invite?token=${encodeURIComponent(inviteToken)}' | n/a | ORPHAN |  |
| /reset-password | none | none | — | /login ("Back to sign in") | — | n/a | ORPHAN |  |
| /share/[token] | none | hand-rolled h1 | — | — | — | n/a | link-only (2) |  |
| /verify-email | none | hand-rolled h1 | — | — | — | n/a | ORPHAN |  |

## Top 5 recommendations for this area

1. **Fix the two P0s and the dead links now** (NAV-01, NAV-02, NAV-15, NAV-16, NAV-28): each is a one-line change. Add a unit test that walks every `href`/`router.push` literal and nav entry against the `pages/` tree (the logic is in `navcode-deadlinks.mjs`), so a route rename can never again produce a 404 or a shadowing redirect.
2. **Make search and "+ Create" land on the thing** (NAV-03, NAV-04): search results open the record, and Create opens the form. This is the cheapest change that makes the app feel fast and modern, since Ctrl+K becomes the accountant's main way around.
3. **Derive active-tab, breadcrumbs and back links from the nav tree** (NAV-05, NAV-06, NAV-10, NAV-11, NAV-12): one resolver in AppLayout gives every page a correct highlight, a module bar and a trail (module › section › list › record), plus a return context when a record was opened from another record. That removes about 120 hand-rolled back links in 4 styles.
4. **Give the accountant one home and bring the modules up out of Library** (NAV-09, NAV-17, NAV-31): `/bureau` as the Dashboard for firm users, an inbox that mixes to-dos with AI suggestions, and Sales/Purchases/Payroll/Practice/Reports as first-class tabs or a rail instead of a 179-link flyout.
5. **Consolidate the duplicate pages, starting with the ones on separate tables** (NAV-14, NAV-32, NAV-08, NAV-07): time entry, products vs items, the two PO tables, the two consolidation engines, then statements and currencies. Put the six orphaned features back in the nav, and surface the unused AI endpoints (NL query, narratives, anomaly scan, AFS note drafting) in context (NAV-29, NAV-30).
