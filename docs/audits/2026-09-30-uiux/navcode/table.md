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
