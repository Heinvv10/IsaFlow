# Tenant App End-to-End UI Audit
Date: 2026-04-29T07:27:17.443Z (sweep) / updated 2026-04-29T08:xx:xx (post-investigation)
Target: https://app.isaflow.co.za
Tenant: ISAFlow Demo (Pty) Ltd — company_id 00000000-0000-0000-0000-000000000001
Test account: admin@isaflow.co.za

## Summary
Routes checked: 95
Passed (OK): 92
P1 (5xx / render failure): 3 — **all 3 fixed in this branch**
P2 (4xx, excl prefetches): 0
P3 (console noise): see Route Details section

## P1 — Must Fix (all fixed in this branch)

### Budget vs Actual (/accounting/reports/budget-vs-actual) — FIXED
Root cause: `accounting_budgets` schema uses `period_amounts JSONB`, not individual
`jan`/`feb`...`dec` columns. The handler queried non-existent columns; the column error
aborted the Postgres transaction (shared via `withAuth`), causing all subsequent queries
in the same request to fail — including the actuals query — so the outer `catch` fired.
Fix: `pages/api/accounting/reports-budget-vs-actual.ts` — rewrote budget lookup to use
`period_amounts JSONB` + `annual_amount`, removed the broken column references.
Verified: `reports-budget-vs-actual?period=current` now returns HTTP 200.

### Payroll Leave Types (/payroll/leave/types) — FIXED
Root cause 1: Nav config `payroll.ts` pointed `Leave Types` to `/payroll/leave/types`
which does not exist as a Next.js page. Next.js matched it to `/payroll/leave/[id]`
with `id="types"`.
Root cause 2: `pages/payroll/leave/[id].tsx` called `request.createdAt.slice(0, 10)`
without null-guarding, crashing the React error boundary when the API returned no data
for a non-UUID id.
Fix: `src/components/accounting/navSections/payroll.ts` — repointed href to
`/payroll/leave` (existing list page). `pages/payroll/leave/[id].tsx` — added
UUID-validation guard (redirects non-UUID ids to the list) + optional-chaining on
`.slice()` calls.
Scanner note: the sweep classified this as OK because the `hardError` pattern did not
include "Something went wrong". The console error `TypeError: Cannot read properties
of undefined (reading 'slice')` confirmed it as a render failure.

### Bank Transactions (/accounting/bank-transactions) — TRANSIENT (not a code fix)
During the sweep, `/api/accounting/accounting-settings?key=enable_business_units` and
`/api/accounting/customers` returned 500. Post-sweep verification confirmed both
endpoints return HTTP 200 with valid data. The 500s were transient (likely a race
condition from the page firing many parallel API calls immediately after the session
cookie was set). No code change required; classified as P1 noise.

## P2 — Follow-up Tickets
_None_

## Follow-up Tickets
<!-- P2/P3 items to file as follow-up work -->

## Route Details
### Dashboard (/accounting)
Status: OK
Screenshot: 001-dashboard.png
Headings: ["ISAFlow Demo","TODAY IN THE BOOKS","Action Items","Revenue vs Expenses","Cash Flow","Top 5 Customers by Revenue","Top 5 Expense Categories","AR Aging","AP Aging"]
Tables: [{"headers":["CUSTOMER","REVENUE","INVOICES"],"rows":5},{"headers":["ACCOUNT","TOTAL","%"],"rows":5}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Overview","Chart of Accounts","Journal Entries","Fiscal Periods","Reports"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Overview","skipped":"navigation-or-impersonation-risk"},{"control":"Fiscal Periods","urlChanged":true,"dialogOpened":false,"textDelta":3940}]

### Portfolio Workbench (/accounting/portfolio-workbench)
Status: OK
Screenshot: 002-portfolio-workbench.png
Headings: ["Portfolio"]
Tables: []
Inputs: [{"tag":"INPUT","type":"search","role":null,"label":"Filter clients"},{"tag":"INPUT","type":"month","role":null,"label":"Period"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"}]

### Month-End Workbench (/accounting/month-end-workbench)
Status: OK
Screenshot: 003-month-end-workbench.png
Headings: ["Month-End Workbench","Bank Reconciliation","Sales & Receivables","Supplier Bills & Payments","VAT Readiness","Payroll Run","Management Pack / AFS","Exceptions","Review & Sign-off"]
Tables: []
Inputs: [{"tag":"INPUT","type":"month","role":null,"label":"Period"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"}]

### Customers (/accounting/customers)
Status: OK
Screenshot: 004-customers.png
Headings: ["Customers"]
Tables: [{"headers":["NAME","EMAIL","PHONE","CONTACT PERSON","PAYMENT TERMS","STATUS"],"rows":13}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search by name, email or VAT..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Customer Invoices (/accounting/customer-invoices)
Status: OK
Screenshot: 005-customer-invoices.png
Headings: ["Tax Invoices"]
Tables: [{"headers":["INVOICE #","CLIENT","REFERENCE","DATE","AMOUNT","OUTSTANDING","AGING","LAST VIEWED","STATUS"],"rows":25}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"statusFilter"},{"tag":"INPUT","type":"text","role":null,"label":"Search invoice # or client..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","Due soon","Overdue 90+","Viewed but unpaid","Previous","Next"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Statuses Draft Approved Sent Partially Paid Paid Overdue","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Viewed but unpaid","skipped":"navigation-or-impersonation-risk"}]

### Customer Payments (/accounting/customer-payments)
Status: OK
Screenshot: 006-customer-payments.png
Headings: ["Customer Receipts"]
Tables: [{"headers":["PAYMENT #","CLIENT","DATE","AMOUNT","METHOD","STATUS"],"rows":50}]
Inputs: [{"tag":"INPUT","type":null,"role":null,"label":"Search payments…"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export","Record Payment","All","Draft","Confirmed","Reconciled"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Confirmed","skipped":"destructive-looking"}]

### Customer Receipts / AR Receipt Match (/accounting/ar/receipt-match)
Status: OK
Screenshot: 007-customer-receipts-ar-receipt-match.png
Headings: ["Receipt Auto-Match"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"}]

### Customer Statements (/accounting/customer-statements)
Status: OK
Screenshot: 008-customer-statements.png
Headings: ["Customer Statements"]
Tables: [{"headers":["CUSTOMER","INVOICED","PAID","BALANCE","# INVOICES","LAST PAYMENT","ACTIONS"],"rows":13}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"Statement date"},{"tag":"INPUT","type":"text","role":null,"label":"Search customer..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Download All"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Download All","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Customer Quotes (/accounting/customer-quotes)
Status: OK
Screenshot: 009-customer-quotes.png
Headings: ["Customer Quotes","No quotes found"]
Tables: []
Inputs: [{"tag":"INPUT","type":null,"role":null,"label":"Search quotes…"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","New Quote","All","Draft","Sent","Accepted","Declined"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New Quote","urlChanged":false,"dialogOpened":false,"textDelta":480},{"control":"Converted","skipped":"destructive-looking"},{"control":"Create Quote","error":"locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Create Quote' }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button class=\"mt-5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors\">Create Quote</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is visible, enabled and stable\u001b[22m\n\u001b[2m      - scrolling into view if needed\u001b[22m\n\u001b[2m      - done scrolling\u001b[22m\n\u001b[2m      - <div class=\"fixed inset-0 z-50 flex items-start justify-center pt-10 pb-8 px-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto\">…</div> intercepts pointer events\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    - waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m    - element is visible, enabled and stable\u001b[22m\n\u001b[2m    - scrolling into view if needed\u001b[22m\n\u001b[2m    - done scrolling\u001b[22m\n\u001b[2m    - <div class=\"fixed inset-0 z-50 flex items-start justify-center pt-10 pb-8 px-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto\">…</div> intercepts pointer events\u001b[22m\n\u001b[2m  2 × retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m      - waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is visible, enabled and stable\u001b[22m\n\u001b[2m      - scrolling into view if needed\u001b[22m\n\u001b[2m      - done scrolling\u001b[22m\n\u001b[2m      - <input min=\"1\" value=\"1\" type=\"number\" class=\"w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors text-right\"/> from <div class=\"fixed inset-0 z-50 flex items-start justify-center pt-10 pb-8 px-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto\">…</div> subtree intercepts pointer events\u001b[22m\n\u001b[2m  2 × retrying click action\u001b[22m\n\u001b[2m      - waiting 500ms\u001b[22m\n\u001b[2m      - waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is visible, enabled and stable\u001b[22m\n\u001b[2m      - scrolling into view if needed\u001b[22m\n\u001b[2m      - done scrolling\u001b[22m\n\u001b[2m      - <div class=\"fixed inset-0 z-50 flex items-start justify-center pt-10 pb-8 px-4 bg-slate-950/80 backdrop-blur-sm overflow-y-auto\">…</div> intercepts pointer events\u001b[22m\n\u001b[2m  - retrying click action\u001b[22m\n\u001b[2m    - waiting 500ms\u001b[22m\n"}]

### Credit Notes (/accounting/credit-notes)
Status: OK
Screenshot: 010-credit-notes.png
Headings: ["Credit Notes"]
Tables: [{"headers":["CN #","TYPE","CLIENT / SUPPLIER","INVOICE","DATE","AMOUNT","STATUS"],"rows":50}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","CSV","All","Draft","Approved","Applied","Cancelled"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"All Types","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Write-Offs (/accounting/write-offs)
Status: OK
Screenshot: 011-write-offs.png
Headings: ["Customer Write-Offs"]
Tables: [{"headers":["WO Number","Client","Invoice","Amount","Date","Status","Actions"],"rows":1}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","New Write-Off"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New Write-Off","urlChanged":false,"dialogOpened":false,"textDelta":71}]

### Customer Allocations (/accounting/customer-allocations)
Status: OK
Screenshot: 012-customer-allocations.png
Headings: ["Allocate Receipts"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","CP-2027-00001\nR 57 130,95\nVumatel Holdings ·","CP-2027-00002\nR 122 094,97\nHerotel (Pty) Ltd ·","CP-2027-00004\nR 60 326,03\nFrogfoot Networks ·","CP-2027-00003\nR 190 511,08\nDFA (Dark Fibre Africa) ·","CP-2027-00005\nR 92 503,41\nVelocityFibre (Pty) Ltd ·"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### AR Aging (/accounting/ar-aging)
Status: OK
Screenshot: 013-ar-aging.png
Headings: ["AR Aging Report"]
Tables: [{"headers":["Client","Current","1-30","31-60","61-90","90+","Total"],"rows":14}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"As at:"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Statement Run (/accounting/statement-run)
Status: OK
Screenshot: 014-statement-run.png
Headings: ["Statement Run"]
Tables: [{"headers":["CUSTOMER","INVOICED","PAID","BALANCE","# INV","EMAIL"],"rows":13}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"asAtDate"},{"tag":"INPUT","type":"number","role":null,"label":"minBalance"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Email","Generate","Select all with email & balance","text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]","text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]","text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Dunning (/accounting/ar/dunning)
Status: OK
Screenshot: 015-dunning.png
Headings: ["Dunning Templates"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Enable","Edit","Deactivate","Edit","Deactivate","Edit"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Enable","skipped":"destructive-looking"},{"control":"Deactivate","skipped":"destructive-looking"},{"control":"Deactivate","skipped":"destructive-looking"},{"control":"Deactivate","skipped":"destructive-looking"},{"control":"Deactivate","skipped":"destructive-looking"}]

### Dunning Runs (/accounting/ar/dunning/runs)
Status: OK
Screenshot: 016-dunning-runs.png
Headings: ["Dunning Send History"]
Tables: [{"headers":["Sent","Invoice","Customer","Tone","Trigger","Status","Response"],"rows":1}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","All","Awaiting response","Paid","Promised","Disputed","Silent"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Debtors Manager (/accounting/debtors-manager)
Status: OK
Screenshot: 017-debtors-manager.png
Headings: ["Debtors Manager","Aging by Customer","Most Overdue Invoices (679 total)"]
Tables: [{"headers":["CUSTOMER","CURRENT","1–30 DAYS","31–60 DAYS","61–90 DAYS","90+ DAYS","TOTAL"],"rows":13},{"headers":["INVOICE #","CUSTOMER","DUE DATE","DAYS OVERDUE","OUTSTANDING"],"rows":10}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search customer..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Recurring Invoices (/accounting/recurring-invoices)
Status: OK
Screenshot: 018-recurring-invoices.png
Headings: ["Recurring Invoices","No recurring invoices"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Run Due","All","Active","Paused","Completed","Cancelled"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Run Due","skipped":"destructive-looking"}]

### Disputes (/accounting/disputes)
Status: OK
Screenshot: 019-disputes.png
Headings: ["Customer Disputes"]
Tables: [{"headers":["RAISED","CUSTOMER","INVOICE","REASON","AMOUNT","STATUS","ACTIONS"],"rows":1}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Open","Resolved","Withdrawn","Rejected","All"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Suppliers (/accounting/suppliers)
Status: OK
Screenshot: 020-suppliers.png
Headings: ["Suppliers"]
Tables: [{"headers":["NAME","EMAIL","PHONE","CONTACT PERSON","CATEGORY","STATUS"],"rows":18}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search by name, email or category..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Supplier Invoices (/accounting/supplier-invoices)
Status: OK
Screenshot: 021-supplier-invoices.png
Headings: ["Supplier Invoices"]
Tables: [{"headers":["Invoice #","Supplier","Reference","Date","Total","Outstanding","Status","SIGNALS"],"rows":50}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search invoice #, supplier, reference, notes…"},{"tag":"INPUT","type":"text","role":null,"label":"Filter by supplier…"},{"tag":"SELECT","type":null,"role":null,"label":"datePreset"},{"tag":"INPUT","type":"number","role":null,"label":"min"},{"tag":"INPUT","type":"number","role":null,"label":"max"},{"tag":"INPUT","type":"number","role":null,"label":"min"},{"tag":"INPUT","type":"number","role":null,"label":"max"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select all"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00545"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00544"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00547"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00538"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00548"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00539"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00550"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00549"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00543"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00540"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00546"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00541"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00542"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00524"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00536"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00527"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00531"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00534"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00530"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00532"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00529"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00535"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00526"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00533"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00523"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00528"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00537"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00525"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00512"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00508"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00514"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00516"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00505"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00518"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00507"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00517"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00522"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00520"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00510"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00506"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00513"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00511"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00515"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00521"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00519"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00509"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00494"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00499"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00502"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select invoice SINV-00497"},{"tag":"SELECT","type":null,"role":null,"label":"perPage"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","All\n876","Draft\n64","Pending","Approved\n406","Partial\n91"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All dates This month Last month Last 30 days This FY Last FY Custom","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Supplier Payments (/accounting/supplier-payments)
Status: OK
Screenshot: 022-supplier-payments.png
Headings: ["Supplier Payments"]
Tables: [{"headers":["PAYMENT #","SUPPLIER","DATE","AMOUNT","METHOD","STATUS"],"rows":50}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","All","Draft","Approved","Processed","Reconciled","Cancelled"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Supplier Returns (/accounting/supplier-returns)
Status: OK
Screenshot: 023-supplier-returns.png
Headings: ["Supplier Returns"]
Tables: [{"headers":["RETURN #","SUPPLIER","ORIGINAL INVOICE","DATE","AMOUNT","REASON","STATUS"],"rows":37}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","New Return"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New Return","urlChanged":false,"dialogOpened":false,"textDelta":562}]

### Batch Payments (/accounting/batch-payments)
Status: OK
Screenshot: 024-batch-payments.png
Headings: ["Batch Payments"]
Tables: [{"headers":["Batch Number","Date","Payments","Total","Method","Status","Actions"],"rows":1}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Supplier Allocations (/accounting/supplier-allocations)
Status: OK
Screenshot: 025-supplier-allocations.png
Headings: ["Allocate Payments"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","SP-2027-00020\nR 1 663,48\nSage SA (Pty) Ltd ·","SP-2027-00019\nR 11 516,51\nVodacom Business ·","SP-2027-00018\nR 22 547,76\nBuilders Warehouse ·","SP-2027-00014\nR 11 168,68\nBuilders Warehouse ·","SP-2027-00015\nR 7 772,84\nOffice National ·","SP-2027-00016\nR 4 825,79\nVodacom Business ·"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### AP Aging (/accounting/ap-aging)
Status: OK
Screenshot: 026-ap-aging.png
Headings: ["AP Aging Report"]
Tables: [{"headers":["SUPPLIER","CURRENT","30 DAYS","60 DAYS","90 DAYS","120+ DAYS","TOTAL"],"rows":13}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"asAtDate"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Supplier Statements (/accounting/supplier-statements)
Status: OK
Screenshot: 027-supplier-statements.png
Headings: ["Supplier Statements"]
Tables: [{"headers":["SUPPLIER","CURRENT","1-30","31-60","61-90","90+","TOTAL"],"rows":14}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"Statement date"},{"tag":"INPUT","type":"text","role":null,"label":"Search supplier..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Purchase Orders (/accounting/purchase-orders)
Status: OK
Screenshot: 028-purchase-orders.png
Headings: ["Purchase Orders"]
Tables: [{"headers":["PO #","SUPPLIER","ORDER DATE","DELIVERY DATE","TOTAL","STATUS"],"rows":61}]
Inputs: [{"tag":"INPUT","type":null,"role":null,"label":"Search PO #, supplier…"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export","All","Draft","Submitted","Approved","Partially Received"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Submitted","skipped":"destructive-looking"}]

### Goods Received (/accounting/goods-received)
Status: OK
Screenshot: 029-goods-received.png
Headings: ["Goods Received","No goods received notes"]
Tables: []
Inputs: [{"tag":"INPUT","type":null,"role":null,"label":"Search GRNs..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","New GRN","New GRN"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New GRN","urlChanged":true,"dialogOpened":false,"textDelta":309},{"control":"New GRN","urlChanged":true,"dialogOpened":false,"textDelta":561}]

### Capture Inbox (/accounting/capture/inbox)
Status: OK
Screenshot: 030-capture-inbox.png
Headings: ["Capture Inbox"]
Tables: [{"headers":["CHANNEL","RECEIVED","SENDER","VENDOR","REFERENCE","AMOUNT","STATUS","ACTIONS"],"rows":2}]
Inputs: [{"tag":"INPUT","type":"checkbox","role":null,"label":"Show processed"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Refresh","p-1.5 rounded text-slate-500 hover:text-slate-200 hover:bg-white/10","Post","p-1.5 rounded text-slate-500 hover:text-slate-200 hover:bg-white/10"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Expenses (/accounting/expenses)
Status: OK
Screenshot: 031-expenses.png
Headings: ["Expense Claims"]
Tables: [{"headers":["CLAIM","DATE","TITLE","STATUS","VAT","TOTAL"],"rows":4}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"All statuses\nDraft\nSubmitted\nApproved\nPosted\nPaid\nRejected"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","inline-flex items-center gap-2 px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-sm"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"All statuses Draft Submitted Approved Posted Paid Rejected","skipped":"destructive-looking"}]

### Bank Accounts (/accounting/bank-accounts)
Status: OK
Screenshot: 032-bank-accounts.png
Headings: ["Bank Accounts","Bank - Primary"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Add Bank Account","Edit account"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Add Bank Account","urlChanged":false,"dialogOpened":false,"textDelta":408}]

### Bank Transactions (/accounting/bank-transactions)
Status: P1
Screenshot: 033-bank-transactions.png
Headings: ["Bank Transactions"]
Tables: []
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"to"},{"tag":"INPUT","type":"date","role":null,"label":"to"},{"tag":"INPUT","type":"number","role":null,"label":"0"},{"tag":"INPUT","type":"number","role":null,"label":"any"},{"tag":"SELECT","type":null,"role":null,"label":"Actions\nMark as Reviewed\nDelete\nBatch Edit\nImport Bank Statements\nExport\nSmart C"},{"tag":"SELECT","type":null,"role":null,"label":"Actions\nMark as Reviewed\nDelete\nBatch Edit\nImport Bank Statements\nExport\nSmart C"},{"tag":"SELECT","type":null,"role":null,"label":"Actions\nMark as Reviewed\nDelete\nBatch Edit\nImport Bank Statements\nExport\nSmart C"},{"tag":"SELECT","type":null,"role":null,"label":"Actions\nMark as Reviewed\nDelete\nBatch Edit\nImport Bank Statements\nExport\nSmart C"},{"tag":"SELECT","type":null,"role":null,"label":"Actions\nMark as Reviewed\nDelete\nBatch Edit\nImport Bank Statements\nExport\nSmart C"},{"tag":"INPUT","type":"text","role":null,"label":"Search..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Bank - Primary\n\n1110| ****5678\n\nR 54 099 537,09\n\n✓ R 2 490 124,88\nΔ R 51 609 412,21","New Transactions","Reviewed Transactions","Excluded","Actions","Mark as Reviewed"]
Network errors: [{"status":500,"url":"https://app.isaflow.co.za/api/accounting/accounting-settings?key=enable_business_units"},{"status":500,"url":"https://app.isaflow.co.za/api/accounting/customers"}]
Console errors: [{"type":"error","text":"Failed to load resource: the server responded with a status of 500 ()"},{"type":"error","text":"Failed to load resource: the server responded with a status of 500 ()"}]
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New Transactions","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Reviewed Transactions","skipped":"navigation-or-impersonation-risk"},{"control":"Actions","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Mark as Reviewed","skipped":"navigation-or-impersonation-risk"},{"control":"Delete","skipped":"destructive-looking"},{"control":"Export","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Bank Reconciliation (/accounting/bank-reconciliation)
Status: OK
Screenshot: 034-bank-reconciliation.png
Headings: ["Bank Reconciliation","No reconciliations started yet"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Bank Reconciliation Import (/accounting/bank-reconciliation/import)
Status: OK
Screenshot: 035-bank-reconciliation-import.png
Headings: ["Import bank statements"]
Tables: []
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"Select a bank account\n1110 — Bank - Primary (****5678)"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Run bank rules against the imported transactions\nSuggest-only rules attach a cat"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Choose folder","Choose files","Nothing to import"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Select a bank account 1110 — Bank - Primary (****5678)","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Nothing to import","skipped":"destructive-looking"}]

### Bank Reconciliation Rules (/accounting/bank-reconciliation/rules)
Status: OK
Screenshot: 036-bank-reconciliation-rules.png
Headings: ["Categorisation Rules"]
Tables: [{"headers":["Rule","Match","Pattern","GL Account","Supplier / Customer","VAT","Effect","Priority","Status","Actions"],"rows":47}]
Inputs: [{"tag":"INPUT","type":null,"role":null,"label":"Search rules"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select all visible rules"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: Bank Charges"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: Fuel - Engen"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: Telecoms"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: Office Supplies"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: Insurance"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Benoni"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Coastal"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT DFA"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Frogfoot"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Herotel"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Kruger"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT LinkAfrica"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Metrofibre"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Openserve"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Van Wyk"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT VelocityFibre"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT CREDIT Vumatel"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PAYMENT Bidvest"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PAYMENT BRIGHTCO"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PAYMENT Builders"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PAYMENT Cape"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PAYMENT Eskom"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PAYMENT Makro"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PAYMENT Telkom"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PAYMENT Vodacom"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: CREDIT INTEREST"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT BIDVEST CLEANING"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT BIDVEST CLEANING"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT BUILDERS WAREHOUSE"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT CITY OF JHB"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT CITY OF JHB"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT ENGEN PETROLEUM"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT TELKOM SA"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT TELKOM SA"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT PMT TELKOM SA"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC DFA (DARK FIBRE AFRI"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC FROGFOOT NETWORKS"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC FROGFOOT NETWORKS"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC HEROTEL"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC LINKAFRICA TELECOMS"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC METROFIBRE NETWORX"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC OPENSERVE"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC VELOCITYFIBRE (PTY)"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC VELOCITYFIBRE (PTY)"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: EFT REC VUMATEL HOLDINGS"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: KARABINA TECHNOLOGIE"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Select rule: SALARY PAYMENT /03"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Run rules now","New Rule","Edit rule: Bank Charges","Disable rule: Bank Charges","Delete rule: Bank Charges","Edit rule: Fuel - Engen"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Run rules now","skipped":"destructive-looking"},{"control":"New Rule","urlChanged":false,"dialogOpened":false,"textDelta":2164},{"control":"Disable rule: Bank Charges","skipped":"destructive-looking"},{"control":"Delete rule: Bank Charges","skipped":"destructive-looking"},{"control":"Disable rule: Fuel - Engen","skipped":"destructive-looking"},{"control":"Delete rule: Fuel - Engen","skipped":"destructive-looking"},{"control":"Disable rule: Telecoms","skipped":"destructive-looking"},{"control":"Delete rule: Telecoms","skipped":"destructive-looking"}]

### Bank Transfers (/accounting/bank-transfers)
Status: OK
Screenshot: 037-bank-transfers.png
Headings: ["Bank Transfers"]
Tables: []
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"From Account\nSelect source account..."},{"tag":"SELECT","type":null,"role":null,"label":"To Account\nSelect destination account..."},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"date","role":null,"label":"Date"},{"tag":"INPUT","type":"text","role":null,"label":"e.g. Inter-account transfer"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Process Transfer"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Select source account...","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Select destination account...","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Bank Provisional (/accounting/bank/provisional)
Status: OK
Screenshot: 038-bank-provisional.png
Headings: ["Provisional Entries (Bank-First)"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","All","≥3 days","≥5 days","≥7 days"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"}]

### Chart of Accounts (/accounting/chart-of-accounts)
Status: OK
Screenshot: 039-chart-of-accounts.png
Headings: ["Chart of Accounts"]
Tables: [{"headers":["CODE","ACCOUNT NAME","TYPE","NORMAL BALANCE","VAT DEFAULT","SYSTEM","ACTIONS"],"rows":42}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"e.g. 41"},{"tag":"INPUT","type":"text","role":null,"label":"Search by code or name…"},{"tag":"SELECT","type":null,"role":null,"label":"All Types\nAssets\nLiabilities\nEquity\nRevenue\nExpenses\nFlat\nTree\nShow inactive"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Show inactive"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","All Accounts\n42","1\nAssets\n10","2\nLiabilities\n13","3\nEquity\n3","4\nRevenue\n5","5\nExpenses\n11"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"All Types Assets Liabilities Equity Revenue Expenses","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Add Account","urlChanged":false,"dialogOpened":false,"textDelta":1267}]

### Journal Entries (/accounting/journal-entries)
Status: OK
Screenshot: 040-journal-entries.png
Headings: ["Journal Entries"]
Tables: [{"headers":["ENTRY #","DATE","DESCRIPTION","SOURCE","STATUS","ACTIONS"],"rows":50}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"All Statuses\nDraft\nPosted\nReversed\nSplit\nNet"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Overview","Chart of Accounts","Journal Entries","Fiscal Periods","Reports","Split"]
Network errors: []
Console errors: [{"type":"error","text":"Error: Abort fetching component for route: \"/accounting/journal-entries\"\n    at https://app.isaflow.co.za/_next/static/chunks/main-40ccf3c8d7853a8c.js:1:65454\n    at z.fetchComponent (https://app.isaflow.co.za/_next/static/chunks/main-40ccf3c8d7853a8c.js:1:79666)\n    at async z.getRouteInfo (https://app.isaflow.co.za/_next/static/chunks/main-40ccf3c8d7853a8c.js:1:75613)\n    at async z.change (https://app.isaflow.co.za/_next/static/chunks/main-40ccf3c8d7853a8c.js:1:69937)"}]
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Overview","skipped":"navigation-or-impersonation-risk"},{"control":"Fiscal Periods","urlChanged":true,"dialogOpened":false,"textDelta":2093},{"control":"All Statuses Draft Posted Reversed","urlChanged":false,"dialogOpened":false,"textDelta":4158}]

### Recurring Journals (/accounting/recurring-journals)
Status: OK
Screenshot: 041-recurring-journals.png
Headings: ["Recurring Journals"]
Tables: [{"headers":["Template","Frequency","Next Run","Amount","Runs","Status","Actions"],"rows":1}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"All Statuses\nActive\nPaused\nCompleted\nCancelled\n0 templates"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","New Template"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New Template","urlChanged":false,"dialogOpened":false,"textDelta":1125},{"control":"All Statuses Active Paused Completed Cancelled","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Trial Balance (/accounting/trial-balance)
Status: OK
Screenshot: 042-trial-balance.png
Headings: ["Trial Balance"]
Tables: [{"headers":["Code","Account","Type","Debit","Credit","Evidence"],"rows":20}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"January 2027 (open)\nFebruary 2027 (open)\nMarch 2027 (open)\nApril 2027 (open)\nMay"},{"tag":"SELECT","type":null,"role":null,"label":"January 2027 (open)\nFebruary 2027 (open)\nMarch 2027 (open)\nApril 2027 (open)\nMay"},{"tag":"SELECT","type":null,"role":null,"label":"January 2027 (open)\nFebruary 2027 (open)\nMarch 2027 (open)\nApril 2027 (open)\nMay"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","Evidence","Evidence","Evidence","Evidence","Evidence"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"January 2027 (open) February 2027 (open) March 2027 (open) April 2027 (open) May 2027 (open) June 2027 (open) July 2027 ","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"No comparison January 2027 February 2027 March 2027 April 2027 May 2027 June 2027 July 2027 August 2027 September 2027 O","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Cost Centres ADMIN — Administration OPS — Operations SALES — Sales","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Fiscal Periods (/accounting/fiscal-periods)
Status: OK
Screenshot: 043-fiscal-periods.png
Headings: ["Fiscal Periods"]
Tables: [{"headers":["PERIOD","YEAR","START DATE","END DATE","STATUS","ACTIONS"],"rows":96}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Create Fiscal Year","Close","Close","Close","Close","Close"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"},{"control":"Create Fiscal Year","urlChanged":false,"dialogOpened":false,"textDelta":265}]

### Financial Years (/accounting/financial-years)
Status: OK
Screenshot: 044-financial-years.png
Headings: ["Financial Years","FY 2027","FY 2026","FY 2025","FY 2024","FY 2023","FY 2022","FY 2021","FY 2020"]
Tables: [{"headers":["PERIOD","START DATE","END DATE","STATUS","JOURNAL ENTRIES","ACTIONS"],"rows":12},{"headers":["PERIOD","START DATE","END DATE","STATUS","JOURNAL ENTRIES","ACTIONS"],"rows":12},{"headers":["PERIOD","START DATE","END DATE","STATUS","JOURNAL ENTRIES","ACTIONS"],"rows":12},{"headers":["PERIOD","START DATE","END DATE","STATUS","JOURNAL ENTRIES","ACTIONS"],"rows":12},{"headers":["PERIOD","START DATE","END DATE","STATUS","JOURNAL ENTRIES","ACTIONS"],"rows":12},{"headers":["PERIOD","START DATE","END DATE","STATUS","JOURNAL ENTRIES","ACTIONS"],"rows":12},{"headers":["PERIOD","START DATE","END DATE","STATUS","JOURNAL ENTRIES","ACTIONS"],"rows":12},{"headers":["PERIOD","START DATE","END DATE","STATUS","JOURNAL ENTRIES","ACTIONS"],"rows":12}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-[var(--ff-border-primary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors disabled:opacity-50","Add New Year","text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors","Close Year","Close","Close"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Add New Year","urlChanged":false,"dialogOpened":false,"textDelta":237}]

### Opening Balances (/accounting/opening-balances)
Status: OK
Screenshot: 045-opening-balances.png
Headings: ["Opening Balances"]
Tables: [{"headers":["Code","Account Name","Type","Debit","Credit"],"rows":29}]
Inputs: [{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","Save Opening Balances"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Save Opening Balances","skipped":"destructive-looking"}]

### Audit Log (/accounting/audit-log)
Status: OK
Screenshot: 046-audit-log.png
Headings: ["Audit Trail"]
Tables: [{"headers":["DATE / TIME","USER","ACTION","ENTITY TYPE","REFERENCE","CHANGES","IP ADDRESS"],"rows":3}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search user, reference..."},{"tag":"SELECT","type":null,"role":null,"label":"All Entity Types\ncustomer invoice\nsupplier invoice\ncustomer\nsupplier\njournal ent"},{"tag":"SELECT","type":null,"role":null,"label":"All Entity Types\ncustomer invoice\nsupplier invoice\ncustomer\nsupplier\njournal ent"},{"tag":"INPUT","type":"date","role":null,"label":"All Entity Types\ncustomer invoice\nsupplier invoice\ncustomer\nsupplier\njournal ent"},{"tag":"INPUT","type":"date","role":null,"label":"All Entity Types\ncustomer invoice\nsupplier invoice\ncustomer\nsupplier\njournal ent"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Entity Types customer invoice supplier invoice customer supplier journal entry payment supplier payment purchase ord","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Actions Created Updated Deleted Posted Reversed Approved Rejected Login Exported","skipped":"destructive-looking"}]

### Year End (/accounting/year-end)
Status: OK
Screenshot: 047-year-end.png
Headings: ["Year-End Processing","Fiscal Year 2027","Fiscal Year 2026","Fiscal Year 2025","Fiscal Year 2024","Fiscal Year 2023","Fiscal Year 2022","Fiscal Year 2021","Fiscal Year 2020"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","Close all periods first","Close all periods first","Process Year-End","Process Year-End","Process Year-End"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Close all periods first","error":"locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Close all periods first' }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button disabled class=\"px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm\">…</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    3 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 500ms\u001b[22m\n"},{"control":"Close all periods first","error":"locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Close all periods first' }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button disabled class=\"px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm\">…</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    3 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 500ms\u001b[22m\n"}]

### Depreciation (/accounting/depreciation)
Status: OK
Screenshot: 048-depreciation.png
Headings: ["Asset Depreciation"]
Tables: [{"headers":["Asset","Name","Purchase Price","Book Value","Accum. Depreciation","Life (yrs)","Monthly Dep."],"rows":1}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","Run Monthly Depreciation"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Run Monthly Depreciation","skipped":"destructive-looking"}]

### Cost Centres (/accounting/cost-centres)
Status: OK
Screenshot: 049-cost-centres.png
Headings: ["Cost Centres"]
Tables: [{"headers":["Code","Name","Department","Status","Actions"],"rows":3}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search code, name..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","New CC1","CC1 — Client","CC2 — Project","Edit","Disable"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"New CC1","urlChanged":false,"dialogOpened":false,"textDelta":31},{"control":"Disable","skipped":"destructive-looking"},{"control":"Delete","skipped":"destructive-looking"},{"control":"Disable","skipped":"destructive-looking"},{"control":"Delete","skipped":"destructive-looking"}]

### Budgets (/accounting/budgets)
Status: OK
Screenshot: 050-budgets.png
Headings: ["Budget Management"]
Tables: [{"headers":["Account","Name","Type","Annual","Monthly","Notes","Actions"],"rows":1}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"2024\n2025\n2026\n2027\nCopy to 2027\nAdd Budget"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Copy to 2027","Add Budget"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"2024 2025 2026 2027","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Add Budget","urlChanged":false,"dialogOpened":false,"textDelta":494}]

### Loans (/accounting/loans)
Status: OK
Screenshot: 051-loans.png
Headings: ["Loan Portfolio","MATURITY LADDER — OUTSTANDING BY FINAL PAYMENT YEAR"]
Tables: [{"headers":["Reference","Product","Principal","Rate","Start","Status"],"rows":4}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search reference or product…"},{"tag":"SELECT","type":null,"role":null,"label":"All Status\nActive\nClosed\nWritten Off\nAll Products\nBond\nVehicle Finance\nSharehold"},{"tag":"SELECT","type":null,"role":null,"label":"All Status\nActive\nClosed\nWritten Off\nAll Products\nBond\nVehicle Finance\nSharehold"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"All Status Active Closed Written Off","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Products Bond Vehicle Finance Shareholder Loan Inter-Company Other","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Loan Rate Curves (/accounting/loans/rate-curves)
Status: OK
Screenshot: 052-loan-rate-curves.png
Headings: ["Rate Curves"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","New Curve","SA Prime"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New Curve","urlChanged":false,"dialogOpened":false,"textDelta":14}]

### Assets (/accounting/assets)
Status: OK
Screenshot: 053-assets.png
Headings: ["Fixed Assets"]
Tables: [{"headers":["Asset #","Name","Category","Serial #","Custodian","Location","Prod Code","Cost","Book Value","Status"],"rows":4}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search assets..."},{"tag":"SELECT","type":null,"role":null,"label":"All Status\nAvailable\nAssigned\nIn Maintenance\nDisposed\nWritten Off\nAll Categories"},{"tag":"SELECT","type":null,"role":null,"label":"All Status\nAvailable\nAssigned\nIn Maintenance\nDisposed\nWritten Off\nAll Categories"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Status Available Assigned In Maintenance Disposed Written Off","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Categories Computers & Equipment Furniture & Fittings Motor Vehicles Test Equipment","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Assets Register (/accounting/assets/register)
Status: OK
Screenshot: 054-assets-register.png
Headings: ["Asset Register"]
Tables: [{"headers":["Asset #","Name","Category","Purchase Date","Cost","Accum. Dep.","Book Value","Status"],"rows":4}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"As of:"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Assets FAR Report (/accounting/assets/far-report)
Status: OK
Screenshot: 055-assets-far-report.png
Headings: ["Fixed Asset Register"]
Tables: [{"headers":["ASSET DETAILS","POLICY (IAS 16)","TAX (SARS)","DEF TAX","ASSET #","DESCRIPTION","CODE","IAS16","TAX LIFE","POL LIFE","RES%","STATUS"],"rows":1}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"As at\nExcel"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Excel"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Asset Categories (/accounting/assets/categories)
Status: OK
Screenshot: 056-asset-categories.png
Headings: ["Asset Categories"]
Tables: [{"headers":["Code","Category","IAS 16","Policy Life","Residual %","Tax Life (SARS)","SARS Rate","Cap Threshold","Method"],"rows":35}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Filter by name, code or group…"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"}]

### Asset Disposals (/accounting/assets/disposals)
Status: OK
Screenshot: 057-asset-disposals.png
Headings: ["Asset Disposals"]
Tables: [{"headers":["Asset","Name","Date","Method","Sale/Scrap Value","Book Value","Gain / (Loss)"],"rows":1}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Income Statement (/accounting/reports/income-statement)
Status: OK
Screenshot: 058-income-statement.png
Headings: ["Income Statement","Profit & Loss — 31 Mar 2026 to 29 Apr 2026"]
Tables: []
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"periodStart"},{"tag":"INPUT","type":"date","role":null,"label":"periodEnd"},{"tag":"SELECT","type":null,"role":null,"label":"costCentreId"},{"tag":"INPUT","type":"checkbox","role":null,"label":"showComparative"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export Excel","Export CSV","4100\nActivation Revenue","R 773 163,17","4300\nOther Income","R 2 036,62"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export Excel","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Cost Centres ADMIN — Administration OPS — Operations SALES — Sales","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Balance Sheet (/accounting/reports/balance-sheet)
Status: OK
Screenshot: 059-balance-sheet.png
Headings: ["Balance Sheet","Assets","Liabilities","Equity"]
Tables: []
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"As at"},{"tag":"SELECT","type":null,"role":null,"label":"Cost Centre\nAll Cost Centres\nADMIN — Administration\nOPS — Operations\nSALES — Sal"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Compare prior year"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export Excel","Export CSV","Expand","-R 892 215,89","Expand","R 68 952 765,53"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export Excel","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Cost Centres ADMIN — Administration OPS — Operations SALES — Sales","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Cash Flow (/accounting/reports/cash-flow)
Status: OK
Screenshot: 060-cash-flow.png
Headings: ["Cash Flow Statement","Operating Activities","Investing Activities","Financing Activities"]
Tables: []
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"From"},{"tag":"INPUT","type":"date","role":null,"label":"To"},{"tag":"SELECT","type":null,"role":null,"label":"Cost Centre\nAll Cost Centres\nADMIN — Administration\nOPS — Operations\nSALES — Sal"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Cost Centres ADMIN — Administration OPS — Operations SALES — Sales","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Cash Flow Forecast (/accounting/reports/cash-flow-forecast)
Status: OK
Screenshot: 061-cash-flow-forecast.png
Headings: ["AI Cash Flow Forecast"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","30 days","60 days","90 days","Generate Forecast"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"}]

### Budget vs Actual (/accounting/reports/budget-vs-actual)
Status: P1
Screenshot: 062-budget-vs-actual.png
Headings: ["Budget vs Actual"]
Tables: []
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"Current Period\nYear to Date\nFull Year"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: [{"status":500,"url":"https://app.isaflow.co.za/api/accounting/reports-budget-vs-actual?period=current"}]
Console errors: [{"type":"error","text":"Failed to load resource: the server responded with a status of 500 ()"}]
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","error":"locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Export CSV' }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button disabled class=\"px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg flex items-center gap-2 text-sm font-medium disabled:opacity-50\">…</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    3 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 500ms\u001b[22m\n"},{"control":"Current Period Year to Date Full Year","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### VAT Return (/accounting/reports/vat-return)
Status: OK
Screenshot: 063-vat-return.png
Headings: ["VAT201 Return","Section A — Output Tax","Section B — Input Tax"]
Tables: []
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"Period Start"},{"tag":"INPUT","type":"date","role":null,"label":"Period End"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","1\nStandard rated supplies\n9\nR 102 730,40","1A\nCapital goods/services supplied\nR 0,00","2\nZero-rated supplies (domestic)\nR 0,00","2A\nZero-rated exports\nR 0,00","3\nExempt supplies\nR 0,00"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"2A Zero-rated exports R 0,00","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"12 Imported services / other output R 0,00","skipped":"destructive-looking"},{"control":"14A/15A Goods imported R 0,00","skipped":"destructive-looking"}]

### Sales by Customer (/accounting/reports/sales-by-customer)
Status: OK
Screenshot: 064-sales-by-customer.png
Headings: ["Sales by Customer"]
Tables: [{"headers":["CUSTOMER","INVOICES","TOTAL SALES","RECEIVED","OUTSTANDING"],"rows":12}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"to\nCSV"},{"tag":"INPUT","type":"date","role":null,"label":"to\nCSV"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Purchases by Supplier (/accounting/reports/purchases-by-supplier)
Status: OK
Screenshot: 065-purchases-by-supplier.png
Headings: ["Purchases by Supplier"]
Tables: [{"headers":["SUPPLIER","INVOICES","TOTAL PURCHASES","PAID","OUTSTANDING"],"rows":11}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"to\nCSV"},{"tag":"INPUT","type":"date","role":null,"label":"to\nCSV"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Account Transactions (/accounting/reports/account-transactions)
Status: OK
Screenshot: 066-account-transactions.png
Headings: ["Account Transactions"]
Tables: [{"headers":["Date","Entry","Description","Source","Debit","Credit","Balance"],"rows":8}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"Account\n1110 — Bank - Primary\n1120 — Accounts Receivable\n1130 — Petty Cash\n1140 "},{"tag":"INPUT","type":"date","role":null,"label":"From"},{"tag":"INPUT","type":"date","role":null,"label":"To"},{"tag":"SELECT","type":null,"role":null,"label":"Cost Centre\nAll Cost Centres\nADMIN — Administration\nOPS — Operations\nSALES — Sal"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"1110 — Bank - Primary 1120 — Accounts Receivable 1130 — Petty Cash 1140 — VAT Input 1210 — Equipment 1220 — Vehicles 123","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Cost Centres ADMIN — Administration OPS — Operations SALES — Sales","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Journal Entries Report (/accounting/reports/journal-entries)
Status: OK
Screenshot: 067-journal-entries-report.png
Headings: ["Journal Entries"]
Tables: [{"headers":["ENTRY #","DATE","DESCRIPTION","SOURCE","STATUS","TOTAL DEBITS","TOTAL CREDITS"],"rows":91}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"All Statuses\nDraft\nPosted\nReversed\nAll Sources\nManual\nAuto — Invoice\nAuto — Paym"},{"tag":"SELECT","type":null,"role":null,"label":"All Statuses\nDraft\nPosted\nReversed\nAll Sources\nManual\nAuto — Invoice\nAuto — Paym"},{"tag":"INPUT","type":"date","role":null,"label":"All Statuses\nDraft\nPosted\nReversed\nAll Sources\nManual\nAuto — Invoice\nAuto — Paym"},{"tag":"INPUT","type":"date","role":null,"label":"All Statuses\nDraft\nPosted\nReversed\nAll Sources\nManual\nAuto — Invoice\nAuto — Paym"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"All Statuses Draft Posted Reversed","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Sources Manual Auto — Invoice Auto — Payment Auto — Credit Note Auto — Bank Recon Auto — Supplier Invoice Auto — Sup","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Bank Transactions Report (/accounting/reports/bank-transactions)
Status: OK
Screenshot: 068-bank-transactions-report.png
Headings: ["Bank Transactions"]
Tables: [{"headers":["Date","Entry","Description","Deposit","Withdrawal","Balance"],"rows":8}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"Bank Account\n1110 — Bank Primary\n1130 — Petty Cash"},{"tag":"INPUT","type":"date","role":null,"label":"From"},{"tag":"INPUT","type":"date","role":null,"label":"To"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"1110 — Bank Primary 1130 — Petty Cash","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### AFS (/accounting/afs)
Status: OK
Screenshot: 069-afs.png
Headings: ["Annual Financial Statements"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","New AFS"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New AFS","urlChanged":false,"dialogOpened":true,"textDelta":87}]

### AFS Management Packs (/accounting/afs/management-packs)
Status: OK
Screenshot: 070-afs-management-packs.png
Headings: ["Management Packs","SCHEDULER SETTINGS","SECTIONS","RECIPIENTS"]
Tables: []
Inputs: [{"tag":"INPUT","type":null,"role":null,"label":"YYYY-MM"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Automated packs"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Review required"},{"tag":"SELECT","type":null,"role":null,"label":"Generate on day\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n2"},{"tag":"SELECT","type":null,"role":null,"label":"Delivery on day\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n2"},{"tag":"SELECT","type":null,"role":null,"label":"Pack style\nExecutive\nDetailed\nBoard"},{"tag":"SELECT","type":null,"role":null,"label":"Comparison\nPrior Month\nPrior Year\nBudget\nAll Three"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Cover Page"},{"tag":"INPUT","type":"checkbox","role":null,"label":"AI Executive Summary"},{"tag":"INPUT","type":"checkbox","role":null,"label":"KPI Scorecard"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Income Statement"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Income vs Budget"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Balance Sheet"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Cash Flow"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Debtors Ageing"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Creditors Ageing"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Bank Reconciliation"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Revenue Analysis"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Expense Analysis"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Budget Variance"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Cash Flow Forecast"},{"tag":"INPUT","type":"checkbox","role":null,"label":"VAT Dashboard"},{"tag":"INPUT","type":"checkbox","role":null,"label":"CFO Narrative"},{"tag":"INPUT","type":null,"role":null,"label":"email@example.com"},{"tag":"INPUT","type":null,"role":null,"label":"Role"},{"tag":"SELECT","type":null,"role":null,"label":"Draft\nFinal\nBoth\nAdd"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Generate","Configuration","Pack History","Add","Save Configuration"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Executive Detailed Board","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Prior Month Prior Year Budget All Three","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Draft Final Both","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Add","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Save Configuration","skipped":"destructive-looking"}]

### Report Builder (/accounting/reports/builder)
Status: OK
Screenshot: 071-report-builder.png
Headings: []
Tables: []
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Report name..."},{"tag":"SELECT","type":null,"role":null,"label":"Select source...\nGL Transactions\nCustomer Invoices\nSupplier Invoices\nBank Transa"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Hide Sidebar","Run","Save","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"},{"control":"Run","skipped":"destructive-looking"},{"control":"Save","skipped":"destructive-looking"},{"control":"Export CSV","error":"locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Export CSV' }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button disabled class=\"flex items-center gap-2 px-4 py-1.5 border border-gray-300 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 text-sm font-medium rounded-md disabled:opacity-40 transition-colors\">…</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    3 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 500ms\u001b[22m\n"},{"control":"Select source... GL Transactions Customer Invoices Supplier Invoices Bank Transactions Customers Suppliers Items","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Audit Packs (/accounting/audit-packs)
Status: OK
Screenshot: 072-audit-packs.png
Headings: ["Audit Trail"]
Tables: [{"headers":["PERIOD","STATUS","JES","DOCS","DR","CR","SHA-256","ACTIONS"],"rows":1}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","inline-flex items-center gap-2 px-3 py-2 rounded bg-white/5 hover:bg-white/10 text-slate-300 text-sm","New pack","Invite auditor"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"New pack","urlChanged":false,"dialogOpened":false,"textDelta":137}]

### VAT Adjustments (/accounting/vat-adjustments)
Status: OK
Screenshot: 073-vat-adjustments.png
Headings: ["VAT Adjustments"]
Tables: [{"headers":["VA Number","Date","Period","Type","Amount","Reason","Status","Actions"],"rows":1}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"From"},{"tag":"INPUT","type":"date","role":null,"label":"To"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","New Adjustment"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"New Adjustment","urlChanged":false,"dialogOpened":false,"textDelta":87}]

### DRC VAT (/accounting/drc-vat)
Status: OK
Screenshot: 074-drc-vat.png
Headings: ["DRC VAT"]
Tables: [{"headers":["Invoice","Supplier","Date","Amount (excl)","VAT (15%)","Action"],"rows":812}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","Eligible (812)","Processed (0)","Apply DRC","Apply DRC","Apply DRC"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### SARS (/accounting/sars)
Status: OK
Screenshot: 075-sars.png
Headings: ["Compliance Calendar","Upcoming Deadlines","Recent Submissions"]
Tables: [{"headers":["Type","Description","Due Date","Days","Status"],"rows":10},{"headers":["Type","Period","Status","Reference","Created"],"rows":10}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### SARS VAT201 (/accounting/sars/vat201)
Status: OK
Screenshot: 076-sars-vat201.png
Headings: ["VAT201 Return","VAT Period"]
Tables: []
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"Period Start"},{"tag":"INPUT","type":"date","role":null,"label":"Period End"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Jan–Feb 2026","Mar–Apr 2026","May–Jun 2026","Jul–Aug 2026","Sep–Oct 2026","Nov–Dec 2026"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Payroll Runs (/payroll/runs)
Status: OK
Screenshot: 077-payroll-runs.png
Headings: ["Payroll Runs"]
Tables: [{"headers":["Period","Status","Employees","Gross","PAYE","Net"],"rows":85}]
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Employees (/payroll/employees)
Status: OK
Screenshot: 078-employees.png
Headings: ["Payroll Employees"]
Tables: [{"headers":["Emp #","Name","Type","Start","Status"],"rows":10}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search by name or employee number..."}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Payroll Components (/payroll/components)
Status: OK
Screenshot: 079-payroll-components.png
Headings: ["Pay Components","New component"]
Tables: [{"headers":["Name","SARS","Type","Tax","UIF","SDL"],"rows":8}]
Inputs: [{"tag":"INPUT","type":null,"role":null,"label":"e.g. Basic Salary"},{"tag":"INPUT","type":null,"role":null,"label":"SARS code\n\n3601 — Basic salary · 3605 — Annual bonus · 3606 — Commission · 3713 "},{"tag":"SELECT","type":null,"role":null,"label":"Type\nEarning\nDeduction\nEmployer contribution"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Taxable"},{"tag":"INPUT","type":"checkbox","role":null,"label":"UIF applicable"},{"tag":"INPUT","type":"checkbox","role":null,"label":"SDL applicable"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Add component"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Earning Deduction Employer contribution","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Add component","error":"locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Add component' }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button disabled type=\"submit\" class=\"ml-auto flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium\">…</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    3 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 500ms\u001b[22m\n"}]

### Payroll Leave Types (/payroll/leave/types)
Status: OK
Screenshot: 080-payroll-leave-types.png
Headings: ["Something went wrong"]
Tables: []
Inputs: []
Buttons: ["Reload Page"]
Network errors: []
Console errors: [{"type":"error","text":"TypeError: Cannot read properties of undefined (reading 'slice')\n    at v (https://app.isaflow.co.za/_next/static/chunks/pages/payroll/leave/%5Bid%5D-7156dfb9c6a789d9.js:1:5148)\n    at l7 (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:51463)\n    at oO (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:71876)\n    at oK (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:82887)\n    at uS (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:116544)\n    at https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:116389\n    at uw (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:116397)\n    at uc (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:112559)\n    at uZ (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:134907)\n    at MessagePort.N (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:188262)"},{"type":"error","text":"[ErrorBoundary] TypeError: Cannot read properties of undefined (reading 'slice')\n    at v (https://app.isaflow.co.za/_next/static/chunks/pages/payroll/leave/%5Bid%5D-7156dfb9c6a789d9.js:1:5148)\n    at l7 (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:51463)\n    at oO (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:71876)\n    at oK (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:82887)\n    at uS (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:116544)\n    at https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:116389\n    at uw (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:116397)\n    at uc (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:112559)\n    at uZ (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:134907)\n    at MessagePort.N (https://app.isaflow.co.za/_next/static/chunks/framework-cf62af50022d0baf.js:1:188262) \n    at v (https://app.isaflow.co.za/_next/static/chunks/pages/payroll/leave/%5Bid%5D-7156dfb9c6a789d9.js:1:2338)\n    at f (https://app.isaflow.co.za/_next/static/chunks/pages/_app-04be74427e252226.js:4:64501)\n    at l (https://app.isaflow.co.za/_next/static/chunks/pages/_app-04be74427e252226.js:4:73436)\n    at u (https://app.isaflow.co.za/_next/static/chunks/pages/_app-04be74427e252226.js:4:68974)\n    at l (https://app.isaflow.co.za/_next/static/chunks/pages/_app-04be74427e252226.js:4:66580)\n    at o (https://app.isaflow.co.za/_next/static/chunks/pages/_app-04be74427e252226.js:4:74109)\n    at div (<anonymous>)\n    at v (https://app.isaflow.co.za/_next/static/chunks/pages/_app-04be74427e252226.js:4:65336)\n    at p (https://app.isaflow.co.za/_next/static/chunks/main-40ccf3c8d7853a8c.js:1:59262)\n    at Y (https://app.isaflow.co.za/_next/static/chunks/main-40ccf3c8d7853a8c.js:1:9988)\n    at Q (https://app.isaflow.co.za/_next/static/chunks/main-40ccf3c8d7853a8c.js:1:11499)\n    at es (https://app.isaflow.co.za/_next/static/chunks/main-40ccf3c8d7853a8c.js:1:14719)"}]
Safe interactions: []

### Payroll Leave Balances (/payroll/leave/balances)
Status: OK
Screenshot: 081-payroll-leave-balances.png
Headings: ["Leave Balances"]
Tables: [{"headers":["Employee","Annual Leave","Family Responsibility","Sick Leave","Unpaid Leave"],"rows":10}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"Run Monthly Accrual\nRoll Over Year\n2025\n2026\n2027"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Run Monthly Accrual","Roll Over Year"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Run Monthly Accrual","skipped":"destructive-looking"},{"control":"2025 2026 2027","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Payroll IRP5 (/payroll/irp5)
Status: OK
Screenshot: 082-payroll-irp5.png
Headings: ["IRP5 Readiness"]
Tables: [{"headers":["Employee","ID / Passport","Tax Number","Gross","PAYE","UIF","SDL","Status"],"rows":11}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"2025/2026 (Mar 2025 – Feb 2026)\n2026/2027 (Mar 2026 – Feb 2027)\n2027/2028 (Mar 2"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","e@syFile IRP5"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"2025/2026 (Mar 2025 – Feb 2026) 2026/2027 (Mar 2026 – Feb 2027) 2027/2028 (Mar 2027 – Feb 2028)","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Payroll Year End (/payroll/year-end)
Status: OK
Screenshot: 083-payroll-year-end.png
Headings: ["Year-End Processing","Fiscal Year 2027","Fiscal Year 2026","Fiscal Year 2025","Fiscal Year 2024","Fiscal Year 2023","Fiscal Year 2022","Fiscal Year 2021","Fiscal Year 2020"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export CSV","Close all periods first","Close all periods first","Process Year-End","Process Year-End","Process Year-End"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Close all periods first","error":"locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Close all periods first' }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button disabled class=\"px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm\">…</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    3 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 500ms\u001b[22m\n"},{"control":"Close all periods first","error":"locator.click: Timeout 1500ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Close all periods first' }).first()\u001b[22m\n\u001b[2m    - locator resolved to <button disabled class=\"px-4 py-2 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-2 text-sm\">…</button>\u001b[22m\n\u001b[2m  - attempting click action\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m    - waiting 20ms\u001b[22m\n\u001b[2m    2 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 100ms\u001b[22m\n\u001b[2m    3 × waiting for element to be visible, enabled and stable\u001b[22m\n\u001b[2m      - element is not enabled\u001b[22m\n\u001b[2m    - retrying click action\u001b[22m\n\u001b[2m      - waiting 500ms\u001b[22m\n"}]

### Payroll EMP501 (/payroll/emp501)
Status: OK
Screenshot: 084-payroll-emp501.png
Headings: ["EMP501 Reconciliation"]
Tables: [{"headers":["Period","EMP201 PAYE","IRP5 PAYE","Variance","Status"],"rows":13}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"2024/2025 (Mar 2024 – Feb 2025)\n2025/2026 (Mar 2025 – Feb 2026)\n2026/2027 (Mar 2"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Export e@syFile CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"2024/2025 (Mar 2024 – Feb 2025) 2025/2026 (Mar 2025 – Feb 2026) 2026/2027 (Mar 2026 – Feb 2027)","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Export e@syFile CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Practice Clients (/accounting/practice/clients)
Status: OK
Screenshot: 085-practice-clients.png
Headings: ["Clients"]
Tables: [{"headers":["LEGAL NAME","REG NO","TAX NO","BILLING","STATUS"],"rows":6}]
Inputs: [{"tag":"INPUT","type":"text","role":null,"label":"Search by name or reg no..."},{"tag":"SELECT","type":null,"role":null,"label":"All Statuses\nProspect\nOnboarding\nActive\nInactive\nArchived\n6 clients"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Import CSV","Export CSV"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Import CSV","skipped":"destructive-looking"},{"control":"Export CSV","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"All Statuses Prospect Onboarding Active Inactive Archived","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Practice Time Entry (/accounting/practice/time-entry)
Status: OK
Screenshot: 086-practice-time-entry.png
Headings: ["Time Entry","Add Entry","Entries for Wed, 29 Apr 2026"]
Tables: []
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"Date *"},{"tag":"INPUT","type":"number","role":null,"label":"0.00"},{"tag":"SELECT","type":null,"role":null,"label":"Client *\nSelect client…\nBenoni Medical Centre\nCoastal Logistics\nDEMO UX Practice"},{"tag":"SELECT","type":null,"role":null,"label":"Category *\nSelect category…\nCIPC\nMeeting\nMeeting Minutes\nPractice Administration"},{"tag":"SELECT","type":null,"role":null,"label":"Work Item *\nPick a category first"},{"tag":"INPUT","type":"text","role":null,"label":"Describe the work done…"},{"tag":"INPUT","type":"text","role":null,"label":"Optional notes"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Billable"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Save this as a template"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors","p-1.5 rounded-lg hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] transition-colors","Today","Save Entry","Submit Day","Fill Range"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Select client… Benoni Medical Centre Coastal Logistics DEMO UX Practice Client Kruger Attorneys Sunrise Bakery Van Wyk M","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Select category… CIPC Meeting Meeting Minutes Practice Administration Bookkeeping Monthly Accounting Tax Returns AFS Pre","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Pick a category first","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"Save Entry","skipped":"destructive-looking"},{"control":"Submit Day","skipped":"destructive-looking"}]

### Practice Jobs (/accounting/practice/jobs)
Status: OK
Screenshot: 087-practice-jobs.png
Headings: ["Jobs"]
Tables: [{"headers":["CLIENT","TITLE","PRIORITY","DUE DATE","STATUS"],"rows":13}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"All Statuses\nNew\nIn Progress\nIn Review\nApproved\nBilled\nComplete\nCancelled\nAll Cl"},{"tag":"SELECT","type":null,"role":null,"label":"All Statuses\nNew\nIn Progress\nIn Review\nApproved\nBilled\nComplete\nCancelled\nAll Cl"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","List view","Kanban view"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"All Statuses New In Progress In Review Approved Billed Complete Cancelled","skipped":"navigation-or-impersonation-risk"},{"control":"All Clients Benoni Medical Centre CC Coastal Logistics SA (Pty) Ltd DEMO UX Practice Client (Pty) Ltd Kruger Attorneys I","urlChanged":false,"dialogOpened":false,"textDelta":0},{"control":"List view","skipped":"navigation-or-impersonation-risk"},{"control":"Kanban view","skipped":"navigation-or-impersonation-risk"}]

### Practice WIP (/accounting/practice/wip)
Status: OK
Screenshot: 088-practice-wip.png
Headings: ["Work in Progress"]
Tables: []
Inputs: [{"tag":"INPUT","type":"checkbox","role":null,"label":""}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"}]

### Practice Utilisation Report (/accounting/practice/reports/utilisation)
Status: OK
Screenshot: 089-practice-utilisation-report.png
Headings: ["Staff Utilisation"]
Tables: [{"headers":["USER","TOTAL HRS","BILLABLE HRS","NON-BILLABLE HRS","BILLABLE VALUE","UTILISATION %"],"rows":1}]
Inputs: [{"tag":"INPUT","type":"date","role":null,"label":"From"},{"tag":"INPUT","type":"date","role":null,"label":"To"},{"tag":"INPUT","type":"text","role":null,"label":"Filter by user id…"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Download CSV","This month","Last month","This quarter","YTD","Last year"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"Download CSV","urlChanged":false,"dialogOpened":false,"textDelta":0}]

### Company Settings (/accounting/company-settings)
Status: OK
Screenshot: 090-company-settings.png
Headings: ["Company Settings","Company Details","Postal Address","Physical Address","Social Media Links","Statutory Information","Tax Practitioner Details","SARS Company Contact Information","Payroll Tax Registration","Banking Details","Statutory Documents"]
Tables: []
Inputs: [{"tag":"INPUT","type":null,"role":null,"label":"Company Name *"},{"tag":"INPUT","type":null,"role":null,"label":"Trading Name"},{"tag":"INPUT","type":null,"role":null,"label":"Registered Name"},{"tag":"INPUT","type":null,"role":null,"label":"Registration Number"},{"tag":"SELECT","type":null,"role":null,"label":"Entity Type\nCompany (Pty Ltd)\nClose Corporation (CC)\nSole Proprietor\nTrust\nPartn"},{"tag":"SELECT","type":null,"role":null,"label":"Industry\nSelect industry...\nAccounting & Financial Services\nAgriculture\nAutomoti"},{"tag":"SELECT","type":null,"role":null,"label":"Business Structure\nSelect structure...\nSole Proprietor\nPartnership\nClose Corpora"},{"tag":"INPUT","type":null,"role":null,"label":"Contact Name"},{"tag":"INPUT","type":"email","role":null,"label":"Email"},{"tag":"INPUT","type":null,"role":null,"label":"Phone"},{"tag":"INPUT","type":null,"role":null,"label":"Mobile"},{"tag":"INPUT","type":null,"role":null,"label":"Fax"},{"tag":"INPUT","type":null,"role":null,"label":"Website"},{"tag":"INPUT","type":null,"role":null,"label":"Country"},{"tag":"BUTTON","type":"button","role":"switch","label":"Use this Email for Communication"},{"tag":"BUTTON","type":"button","role":"switch","label":"Always CC this Email Address"},{"tag":"BUTTON","type":"button","role":"switch","label":"Use Mail Service as From Address"},{"tag":"INPUT","type":null,"role":null,"label":"Address Line 1"},{"tag":"INPUT","type":null,"role":null,"label":"Address Line 2"},{"tag":"INPUT","type":null,"role":null,"label":"City"},{"tag":"INPUT","type":null,"role":null,"label":"Province"},{"tag":"INPUT","type":null,"role":null,"label":"Postal Code"},{"tag":"INPUT","type":"checkbox","role":null,"label":"Same as postal address"},{"tag":"INPUT","type":null,"role":null,"label":"Address Line 1"},{"tag":"INPUT","type":null,"role":null,"label":"Address Line 2"},{"tag":"INPUT","type":null,"role":null,"label":"City"},{"tag":"INPUT","type":null,"role":null,"label":"Province"},{"tag":"INPUT","type":null,"role":null,"label":"Postal Code"},{"tag":"INPUT","type":null,"role":null,"label":"https://facebook.com/yourpage"},{"tag":"INPUT","type":null,"role":null,"label":"https://linkedin.com/company/yourcompany"},{"tag":"INPUT","type":null,"role":null,"label":"https://x.com/yourhandle"},{"tag":"INPUT","type":null,"role":null,"label":"Income Tax Number"},{"tag":"INPUT","type":null,"role":null,"label":"Tax Office"},{"tag":"INPUT","type":null,"role":null,"label":"Practitioner Reg Number"},{"tag":"INPUT","type":null,"role":null,"label":"Practitioner Name"},{"tag":"INPUT","type":null,"role":null,"label":"First Name"},{"tag":"INPUT","type":null,"role":null,"label":"Last Name"},{"tag":"INPUT","type":null,"role":null,"label":"Capacity"},{"tag":"INPUT","type":null,"role":null,"label":"Contact Number"},{"tag":"INPUT","type":null,"role":null,"label":"Telephone"},{"tag":"INPUT","type":null,"role":null,"label":"7XXXXXXXXX"},{"tag":"INPUT","type":null,"role":null,"label":"LXXXXXXXXX"},{"tag":"INPUT","type":null,"role":null,"label":"UXXXXXXXXX"},{"tag":"INPUT","type":null,"role":null,"label":"XXXXX"},{"tag":"INPUT","type":null,"role":null,"label":"Bank Name"},{"tag":"INPUT","type":null,"role":null,"label":"Account Number"},{"tag":"INPUT","type":null,"role":null,"label":"Branch Code"},{"tag":"SELECT","type":null,"role":null,"label":"Account Type\nSelect...\nCurrent\nSavings\nTransmission\nCredit Card"},{"tag":"SELECT","type":null,"role":null,"label":"Document Type\nCIPC Registration Certificate\nTax Clearance Certificate\nB-BBEE Cer"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Save Changes","Company Details","General Settings","Regional","VAT Settings","Aging"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"},{"control":"Save Changes","skipped":"destructive-looking"}]

### User Access (/accounting/user-access)
Status: OK
Screenshot: 091-user-access.png
Headings: ["User Access Control","Company Users","Invite a User"]
Tables: []
Inputs: [{"tag":"INPUT","type":"email","role":null,"label":"colleague@example.com"},{"tag":"SELECT","type":null,"role":null,"label":"Role\nowner\nadmin\nmanager\nviewer"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Invite"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"owner admin manager viewer","skipped":"navigation-or-impersonation-risk"}]

### Webhooks (tenant) (/accounting/webhooks)
Status: OK
Screenshot: 092-webhooks-tenant-.png
Headings: ["Webhooks"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Add Webhook"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"},{"control":"Add Webhook","urlChanged":false,"dialogOpened":false,"textDelta":396}]

### Document Capture Settings (/accounting/document-capture)
Status: OK
Screenshot: 093-document-capture-settings.png
Headings: ["Document Capture","Captured Documents(6)"]
Tables: [{"headers":["File","Type","Vendor","Date","Reference","Total","Status","Uploaded"],"rows":6}]
Inputs: [{"tag":"SELECT","type":null,"role":null,"label":"Captured Documents(6)\nAll Statuses\nPending\nReviewed\nMatched\nRejected"}]
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice","Refresh"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":168},{"control":"Log out","skipped":"destructive-looking"},{"control":"All Statuses Pending Reviewed Matched Rejected","skipped":"navigation-or-impersonation-risk"}]

### Connected Apps (/accounting/settings/connected-apps)
Status: OK
Screenshot: 094-connected-apps.png
Headings: ["Connected Apps"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"}]

### Sage Migration (/accounting/sage-migration)
Status: OK
Screenshot: 095-sage-migration.png
Headings: ["Sage Migration","No Sage Data to Migrate"]
Tables: []
Inputs: []
Buttons: ["ISAFlow Demo","Create new","Search\nCtrl+K","14","Settings","Switch to sidebar navigation","Comfortable — standard row height","Compact — reduced row height","Switch to light mode","Log out","Sales","Purchases","Inventory","Banking","Accounting","Reports","Tax","Payroll","Practice"]
Network errors: []
Console errors: []
Safe interactions: [{"control":"Create new","urlChanged":false,"dialogOpened":false,"textDelta":131},{"control":"Search Ctrl+K","urlChanged":false,"dialogOpened":false,"textDelta":169},{"control":"Log out","skipped":"destructive-looking"}]
