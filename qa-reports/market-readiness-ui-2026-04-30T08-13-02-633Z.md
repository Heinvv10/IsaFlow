# Market Readiness UI Audit

Target: http://localhost:3200
Tenant: 00000000-0000-0000-0000-0000000d4e02
Generated: 2026-04-30T08:19:39.055Z

Summary: 30 pages, 0 with problems; 6 workflow forms, 0 with problems.

## Page Findings
- PASS /accounting -> 200 http://localhost:3200/accounting
- PASS /accounting/customers -> 200 http://localhost:3200/accounting/customers
- PASS /accounting/customers/new -> 200 http://localhost:3200/accounting/customers/new
- PASS /accounting/customer-invoices -> 200 http://localhost:3200/accounting/customer-invoices
- PASS /accounting/customer-invoices/new -> 200 http://localhost:3200/accounting/customer-invoices/new
- PASS /accounting/customer-payments -> 200 http://localhost:3200/accounting/customer-payments
- PASS /accounting/customer-payments/new -> 200 http://localhost:3200/accounting/customer-payments/new
- PASS /accounting/suppliers -> 200 http://localhost:3200/accounting/suppliers
- PASS /accounting/suppliers/new -> 200 http://localhost:3200/accounting/suppliers/new
- PASS /accounting/supplier-invoices -> 200 http://localhost:3200/accounting/supplier-invoices
- PASS /accounting/supplier-invoices/new -> 200 http://localhost:3200/accounting/supplier-invoices/new
- PASS /accounting/bank-accounts -> 200 http://localhost:3200/accounting/bank-accounts
- PASS /accounting/bank-transactions -> 200 http://localhost:3200/accounting/bank-transactions
- PASS /accounting/bank-reconciliation -> 200 http://localhost:3200/accounting/bank-reconciliation
- PASS /accounting/bank-reconciliation/rules -> 200 http://localhost:3200/accounting/bank-reconciliation/rules
- PASS /accounting/chart-of-accounts -> 200 http://localhost:3200/accounting/chart-of-accounts
- PASS /accounting/journal-entries -> 200 http://localhost:3200/accounting?tab=journal-entries
- PASS /accounting/journal-entries/new -> 200 http://localhost:3200/accounting/journal-entries/new
- PASS /accounting/reports/trial-balance -> 200 http://localhost:3200/accounting/trial-balance
- PASS /accounting/reports/vat-return -> 200 http://localhost:3200/accounting/reports/vat-return
- PASS /accounting/reports/income-statement -> 200 http://localhost:3200/accounting/reports/income-statement
- PASS /accounting/reports/balance-sheet -> 200 http://localhost:3200/accounting/reports/balance-sheet
- PASS /accounting/company-settings -> 200 http://localhost:3200/accounting/company-settings
- PASS /accounting/accounting-settings -> 200 http://localhost:3200/accounting/accounting-settings
- PASS /accounting/practice/clients -> 200 http://localhost:3200/accounting/practice/clients
- PASS /accounting/practice/time-entry -> 200 http://localhost:3200/accounting/practice/time-entry
- PASS /accounting/practice/approvals -> 200 http://localhost:3200/accounting/practice/approvals
- PASS /accounting/practice/wip -> 200 http://localhost:3200/accounting/practice/wip
- PASS /payroll/employees -> 200 http://localhost:3200/payroll/employees
- PASS /payroll/runs -> 200 http://localhost:3200/payroll/runs

## Workflow Findings
- PASS customer invoice creation form (/accounting/customer-invoices/new)
- PASS customer payment form (/accounting/customer-payments/new)
- PASS supplier invoice capture form (/accounting/supplier-invoices/new)
- PASS bank rules (/accounting/bank-reconciliation/rules)
- PASS company settings (/accounting/company-settings)
- PASS practice time entry (/accounting/practice/time-entry)

Screenshots: qa-reports/market-ui-2026-04-30T08-13-02-633Z
JSON: qa-reports/market-readiness-ui-2026-04-30T08-13-02-633Z.json
