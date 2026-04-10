# QuickBooks Online South Africa -- Competitive Feature Analysis

**Date:** 2026-04-05
**Purpose:** Comprehensive feature inventory for competitive comparison with IsaFlow
**QBO Region:** South Africa (ZA) -- quickbooks.intuit.com/za/

---

## Plan Tiers & Pricing (ZA)

| Plan | Users | Approx. ZAR/month | Key Differentiator |
|------|-------|--------------------|--------------------|
| **Simple Start** | 1 + accountant | ~R250-350* | Basic invoicing, expenses, 1 user |
| **Essentials** | 3 + accountant | ~R450-550* | + Bills, time tracking, multi-currency |
| **Plus** | 5 + accountant | ~R650-800* | + Inventory, projects, budgeting, classes/locations |
| **Advanced** | 25 + accountant | ~R1,200-1,500* | + Custom roles, batch operations, fixed assets, workflows |

*Retail pricing is dynamically loaded on the QBO site; wholesale/accountant pricing confirmed: Simple Start R60/mo (bundle), Plus R23/mo (bundle), Advanced R450/mo (bundle) -- all promotional 12-month accountant rates.*

---

## 1. Dashboard & Overview

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Home dashboard | Yes | All | Widgets: Shortcuts, Bank Accounts, Invoices, Tasks, Sales |
| Cash flow tab | Yes | All | Money in/out overview, open/overdue invoices and bills |
| Profit & Loss snapshot | Yes | All | Last month P&L on dashboard |
| AR/AP balances widget | Yes | All | Quick view of receivables/payables |
| Customizable widget layout | Yes | All | Drag-and-drop, resize, add/remove widgets |
| Custom KPI dashboards | No (native) | -- | Requires third-party (Databox, Geckoboard, Plecto, Klipfolio) |
| Revenue/expense trend charts | Partial | All | Basic charts; advanced analytics via third-party |

---

## 2. Chart of Accounts / General Ledger

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Pre-built ZA chart of accounts | Yes | All | Localized for South Africa |
| Custom account creation | Yes | All | Up to 250 accounts (SS/Ess/Plus); unlimited (Advanced) |
| Account types | Yes | All | Assets, Liabilities, Equity, Income, Expenses, COGS |
| Sub-accounts | Yes | All | Hierarchical account structure |
| Journal entries | Yes | All | Manual journal entries supported |
| Recurring journal entries | Yes | All | Via recurring transactions feature |
| Opening balances | Yes | All | Via Opening Balance Equity account; can use journal entries |
| General Ledger report | Yes | All | Full GL detail report |
| Trial Balance report | Yes | All | Standard trial balance |
| Account number support | Yes | All | Optional account numbering |
| Import chart of accounts | Yes | All | CSV/Excel import |
| Inactive/archive accounts | Yes | All | Can mark accounts inactive |

**Limitations:** Non-Advanced plans capped at 250 accounts. No account grouping/categories beyond sub-accounts.

---

## 3. Customers / Accounts Receivable

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Customer list management | Yes | All | Contacts with details, notes, tax info |
| Invoices (unlimited) | Yes | All | Custom branded invoices with logo/colors |
| Estimates/Quotes | Yes | All | Convert to invoice |
| Credit notes/memos | Yes | All | Cannot create recurring credit memos |
| Sales receipts | Yes | All | For immediate payment transactions |
| Recurring invoices | Yes | All | Daily, weekly, monthly, yearly schedules |
| Progress invoicing | Yes | Plus, Advanced | Split estimates into milestone invoices |
| Customer statements | Yes | All | Generate and send statements |
| AR Aging Summary | Yes | All | Current, 1-30, 31-60, 61-90, 90+ day buckets |
| AR Aging Detail | Yes | All | Transaction-level aging detail |
| Payment recording | Yes | All | Record payments against invoices |
| Online payment acceptance | Partial | All | Limited SA gateways; no native Paystack/SnapScan |
| Automated payment reminders | Yes | All | Email reminders for overdue invoices |
| Invoice delivery tracking | Yes | All | Know when invoice is viewed |
| Customer portal | Partial | All | Invoice view/pay only; not a full portal |
| Deposit/retainer invoices | Yes | All | Receive deposits on invoices |
| Sales tax / VAT on invoices | Yes | All | Pre-filled 15% SA VAT |
| Batch invoicing | Yes | Advanced | Bulk create/send invoices |
| Custom invoice templates | Yes | All | Multiple template designs |
| Invoice attachments | Yes | All | Attach files to invoices |
| Sub-customers | Yes | All | Customer hierarchy |

**Limitations:** No native SA payment gateways (no Paystack, SnapScan, PayFast). Credit memo cannot be set as recurring. Customer portal is invoice-only, not a full self-service portal.

---

## 4. Suppliers / Accounts Payable

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Supplier/vendor management | Yes | Essentials+ | Simple Start has limited supplier features |
| Bill entry & tracking | Yes | Essentials+ | Not in Simple Start |
| Purchase orders | Yes | Plus, Advanced | Create POs, convert to bills |
| Bill payments | Yes | Essentials+ | Pay individual bills |
| Batch bill payments | Yes | Advanced | Pay multiple bills at once |
| AP Aging Summary | Yes | Essentials+ | Standard aging buckets |
| AP Aging Detail | Yes | Essentials+ | Transaction-level detail |
| Recurring bills | Yes | Essentials+ | Via recurring transactions |
| Supplier credits | Yes | Essentials+ | Apply credits to bills |
| 1099 tracking | No | -- | US-only feature; no SA equivalent |
| Expense tracking | Yes | All | Track expenses via bank feeds or manual entry |
| Receipt capture for expenses | Yes | All | OCR receipt scanning |

**Limitations:** Simple Start has no bill management (expenses only via direct spend). Purchase orders only in Plus+. Batch payments only in Advanced. No EFT/batch payment file generation for SA banks.

---

## 5. Banking & Reconciliation

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Bank feeds (auto-import) | Yes | All | ABSA, FNB, Nedbank, Standard Bank, Capitec, Investec |
| Manual bank statement import | Yes | All | CSV, QIF, OFX formats |
| Transaction matching | Yes | All | Auto-match and suggested matches |
| Bank rules | Yes | All | Auto-categorize based on rules |
| Bank reconciliation | Yes | All | Statement-based reconciliation |
| Reconciliation reports | Yes | All | Reconciliation summary and detail |
| Bank transfers | Yes | All | Record transfers between accounts |
| Multiple bank accounts | Yes | All | Unlimited bank/credit card accounts |
| Credit card feeds | Yes | All | Same as bank feeds |
| Auto-categorization (AI) | Yes | All | Intuit Assist learns categorization patterns |

**Limitations:** Standard Bank feed has known reliability issues. No Yodlee-style aggregation for smaller banks. Bank rules are basic pattern matching (not regex). No bank import batch management.

---

## 6. Reporting

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Profit & Loss | Yes | All | Standard and by period comparison |
| Balance Sheet | Yes | All | Standard and comparison |
| Cash Flow Statement | Yes | All | Statement of Cash Flows |
| Trial Balance | Yes | All | Standard trial balance |
| General Ledger | Yes | All | Full GL detail |
| AR Aging (Summary/Detail) | Yes | All | Standard aging reports |
| AP Aging (Summary/Detail) | Yes | Essentials+ | Requires bill tracking |
| Sales reports | Yes | All | By customer, product, date |
| Expense reports | Yes | All | By vendor, category, date |
| Tax reports (VAT) | Yes | All | VAT liability, transaction detail |
| Budget vs Actual | Yes | Plus, Advanced | P&L budget variance |
| P&L by Class | Yes | Plus, Advanced | Segment reporting |
| P&L by Location | Yes | Plus, Advanced | Location-based reporting |
| Project profitability | Yes | Plus, Advanced | Income/expense by project |
| Inventory reports | Yes | Plus, Advanced | Valuation, stock status |
| Custom reports | Partial | All | Filter/customize; Advanced has custom report builder |
| Report scheduling | Yes | Advanced | Auto-email reports on schedule |
| Report export | Yes | All | PDF and Excel; no native CSV |
| 50+ built-in reports | Yes | All | Comprehensive report library |
| Comparative periods | Yes | All | Prior period, prior year |

**Limitations:** No native CSV export (must export Excel then convert). Custom reporting limited in non-Advanced plans. No management pack/board pack builder. No consolidated multi-entity reports.

---

## 7. VAT / Tax

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| VAT tracking | Yes | All | Pre-filled 15% SA VAT rate |
| VAT on income | Yes | All | Auto-calculate on invoices |
| VAT on expenses | Yes | All | Auto-calculate on bills/expenses |
| Multiple VAT rates | Yes | All | Standard, zero-rated, exempt |
| VAT return preparation | Yes | All | Activity statement for SARS filing |
| VAT201 report | Partial | All | Prepares data; manual filing to SARS |
| SARS eFiling integration | No | -- | No direct API integration; manual submission |
| Tax category mapping | Yes | All | Organize expenses into tax categories |
| Withholding tax | No | -- | Not supported natively |
| Income tax preparation | Partial | All | Expense categorization; no IT14 generation |

**Limitations:** No direct SARS eFiling API integration. VAT return data must be manually transferred to SARS eFiling. No withholding tax support. No automatic IT14/ITR14 generation.

---

## 8. Payroll

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Native SA payroll | No | -- | QBO ZA has no built-in SA-compliant payroll |
| Pay runs | No (native) | -- | Requires third-party (SimplePay, Sage Payroll) |
| IRP5 generation | No (native) | -- | Via SimplePay integration |
| EMP201 monthly returns | No (native) | -- | Via third-party |
| EMP501 annual reconciliation | No (native) | -- | Via third-party |
| UIF calculations | No (native) | -- | Via third-party |
| SDL calculations | No (native) | -- | Via third-party |
| Leave management | No (native) | -- | Via third-party |
| Employee self-service | No (native) | -- | Via third-party |
| SimplePay integration | Yes (add-on) | All | Auto-post payroll journals to QBO |
| Payroll journal posting | Yes | All | Manual or via integration |

**Limitations:** QBO has NO native South African payroll. Businesses must use SimplePay (most common), PaySpace, or Sage Payroll as a separate subscription and integrate. This is a significant gap vs competitors like Sage that include payroll.

---

## 9. Fixed Assets

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Fixed asset register | Yes | Advanced only | Built-in asset management |
| Automatic depreciation | Yes | Advanced only | Monthly auto-posting of depreciation |
| Depreciation methods | Yes | Advanced only | Straight-line; limited methods |
| Bulk asset setup | Yes | Advanced only | Import multiple assets at once |
| Asset disposal | Partial | Advanced only | Manual journal entries for disposal |
| Asset categories | Yes | Advanced only | Group assets by type |
| Depreciation schedule report | Yes | Advanced only | View depreciation over time |
| Manual depreciation (other plans) | Partial | All | Manual journal entries required on non-Advanced plans |

**Limitations:** Fixed asset management is ONLY in Advanced plan. Non-Advanced users must track assets manually via journal entries. Limited depreciation methods (no reducing balance, no SA-specific wear-and-tear allowances per SARS schedules). No asset revaluation. No component depreciation.

---

## 10. Inventory / Items

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Products & services list | Yes | All | Non-inventory items on all plans |
| Inventory tracking (quantity) | Yes | Plus, Advanced | Real-time perpetual tracking |
| Inventory valuation (FIFO) | Yes | Plus, Advanced | FIFO costing method |
| Reorder points | Yes | Plus, Advanced | Low stock alerts |
| Stock status reports | Yes | Plus, Advanced | Current stock levels |
| Inventory valuation report | Yes | Plus, Advanced | Summary and detail |
| Barcode scanning | Yes | Plus, Advanced | Via mobile app |
| Purchase orders | Yes | Plus, Advanced | Create POs for restocking |
| Inventory adjustments | Yes | Plus, Advanced | Quantity and value adjustments |
| Bundle/kit items | Partial | Plus, Advanced | Product bundles (limited) |
| Multiple warehouses/locations | No | -- | Single location only |
| Serial/batch tracking | No | -- | Not supported natively |
| Manufacturing/BOM | No | -- | Requires third-party (Katana, inFlow) |
| Sales price lists | Partial | All | Single price per item; no multiple price lists |

**Limitations:** No multi-warehouse support. No serial/batch number tracking. No manufacturing/BOM. FIFO only (no weighted average). Single price per item. For complex inventory needs, third-party apps (Dear, Katana, inFlow) required.

---

## 11. Projects / Time Tracking

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Projects | Yes | Plus, Advanced | Track income/expenses per project |
| Project profitability report | Yes | Plus, Advanced | Revenue vs costs per project |
| Time tracking | Yes | Essentials+ | Log hours; billable/non-billable |
| Billable time to invoices | Yes | Essentials+ | Add tracked time to invoices |
| Time cost by employee | Yes | Plus, Advanced | Labor cost reporting |
| Unbilled time & expenses | Yes | Plus, Advanced | Report on uninvoiced work |
| QuickBooks Time (TSheets) | Add-on | All | Advanced time tracking add-on |
| Estimate vs Actual | Yes | Advanced | Compare quoted vs actual costs |
| Work-in-Progress reports | Yes | Advanced | WIP tracking |
| Progress invoicing | Yes | Plus, Advanced | Invoice by milestone/percentage |

**Limitations:** Projects only in Plus+. Basic time tracking in Essentials; advanced features need Plus/Advanced or QuickBooks Time add-on. No Gantt charts or project scheduling. No resource allocation.

---

## 12. Multi-Currency

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Multi-currency support | Yes | Essentials+ | Not in Simple Start |
| Automatic exchange rates | Yes | Essentials+ | Via IHS Markit; daily updates |
| Manual exchange rate override | Yes | Essentials+ | Set custom rates |
| Foreign currency invoices | Yes | Essentials+ | Invoice in customer's currency |
| Foreign currency bills | Yes | Essentials+ | Record bills in supplier currency |
| Foreign currency bank accounts | Yes | Essentials+ | Maintain accounts in different currencies |
| Realized gains/losses | Yes | Essentials+ | Auto-calculated on payment |
| Unrealized gains/losses | Yes | Essentials+ | Home currency adjustment |
| Currency list management | Yes | Essentials+ | Add/manage active currencies |

**Limitations:** Not available in Simple Start. Once enabled, multi-currency cannot be turned off. Cannot change home currency after setup. Exchange rate source (IHS Markit) may differ from SARB rates.

---

## 13. Document Management

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Receipt capture (OCR) | Yes | All | Snap photo, extract data automatically |
| Receipt email forwarding | Yes | All | Email receipts to custom QBO address |
| File attachments on transactions | Yes | All | Attach files to any transaction |
| Receipt matching to expenses | Yes | All | Match captured receipts to transactions |
| Document storage | Yes | All | Cloud storage for attachments |
| Bulk document upload | Partial | All | Upload multiple receipts at once |
| Third-party OCR integration | Yes | All | Dext, Hubdoc (now Intuit-owned), Veryfi |
| Supplier invoice scanning | Yes | All | Scan bills and auto-populate fields |

**Limitations:** OCR accuracy varies. No folder/filing system for documents. Limited document organization beyond transaction attachment. Hubdoc included free with QBO but as separate app.

---

## 14. AI Features

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Intuit Assist (AI platform) | Yes | All | Rolling out across all plans |
| Transaction auto-categorization | Yes | All | ML-based learning from user patterns |
| Accounting Agent | Yes | All | Auto-categorize, reconcile, detect anomalies |
| Payments Agent | Yes | All | Predict late payments, auto-reminders |
| Business Tax AI | Partial | All | Tax optimization suggestions (US-focused) |
| Customer AI (lead detection) | Partial | All | Email inbox scanning for leads |
| Anomaly detection | Yes | All | Flag unusual transactions |
| Smart matching (bank feeds) | Yes | All | AI-suggested bank transaction matches |
| Cash flow forecasting | Partial | All | Basic AI-driven projections |

**Limitations:** Many Intuit Assist features are US-first; South African rollout may lag. Business Tax AI is US-focused. Customer AI requires email integration. AI features became standard after September 2025; limited opt-out. No AI-driven commentary generation for reports. No AI document processing pipeline (beyond basic OCR).

---

## 15. Integrations

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| App marketplace | Yes | All | 750+ apps globally |
| SA bank feeds | Yes | All | ABSA, FNB, Nedbank, Standard Bank, Capitec, Investec |
| SimplePay (payroll) | Yes | All | Auto-post payroll journals |
| Shopify | Yes | All | E-commerce integration |
| PayPal | Yes | All | Payment processing |
| Stripe | Partial | All | Limited SA support |
| Square | Partial | All | Limited SA availability |
| Dext (Receipt Bank) | Yes | All | Document capture |
| Hubdoc | Yes | All | Included free; document fetching |
| Zapier | Yes | All | Workflow automation |
| CaseWare | Yes | All | Export via .cwq format |
| Microsoft Excel | Yes | All | Report export |
| PayFast/Paystack/SnapScan | No | -- | No native SA payment gateway integration |
| Sage integration | No | -- | No direct integration |
| SARS eFiling API | No | -- | No direct API connection |
| REST API (developer) | Yes | All | Full API for custom integrations |

**Limitations:** SA payment gateway ecosystem is poorly served. No native PayFast, Paystack, or SnapScan integration. App marketplace skews US/UK -- fewer SA-specific apps. No Sage data import/migration tool.

---

## 16. User Management

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Primary admin | Yes | All | Full access to everything |
| Company admin | Yes | All | Full access except removing primary admin |
| Standard users | Yes | Varies | 1 (SS), 3 (Ess), 5 (Plus), 25 (Adv) |
| Accountant user (free) | Yes | All | Free accountant invite; admin-level access |
| Custom user roles | Yes | Advanced only | Define granular permissions |
| View-only access | Yes | All | Reports-only users |
| Time tracking only users | Yes | Essentials+ | Limited to time entry |
| Two-factor authentication | Yes | All | MFA via Intuit account |
| SSO (Single Sign-On) | No | -- | Not supported |
| IP restrictions | No | -- | Not supported |

**Limitations:** Non-Advanced plans have fixed user limits and roles. No custom roles except on Advanced. No SSO or IP whitelisting. Accountant user has full admin access (no granular accountant permissions). No user activity monitoring beyond audit log.

---

## 17. Audit Trail

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Audit log | Yes | All | Tracks all user activity |
| Transaction history | Yes | All | Created, edited, deleted transactions |
| User identification | Yes | All | Who made each change |
| Timestamps | Yes | All | Date/time of every action |
| Login tracking | Yes | All | User login events |
| Retention period | Yes | All | 2 years of audit log data |
| Admin-only access | Yes | All | Only admins can view audit log |
| Export audit log | Partial | All | Can view but limited export options |
| Field-level change tracking | Yes | All | Shows before/after values |

**Limitations:** Only 2-year retention. Only admins can access. Limited export capabilities. No compliance-specific audit reports. No audit log API access. Cannot track report generation or data exports in log.

---

## 18. Data Export

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Report export to Excel | Yes | All | .xlsx format |
| Report export to PDF | Yes | All | All reports |
| CSV export | No (native) | -- | Must export Excel then convert |
| CaseWare export (.cwq) | Yes | All | Via QuickBooks Export Utility |
| Trial Balance export | Yes | All | For auditor use |
| General Ledger export | Yes | All | Full GL detail |
| Backup & restore | Yes | Advanced | Full company data backup |
| Data export (full) | Partial | All | Can export lists and reports; no single full-data dump |
| API data access | Yes | All | Programmatic data extraction |

**Limitations:** No native CSV export. CaseWare integration requires separate utility download. No one-click full data export. Backup/restore only in Advanced. No XBRL export. No iXBRL for CIPC filing.

---

## 19. Mobile / Portal

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| iOS mobile app | Yes | All | Full-featured mobile app |
| Android mobile app | Yes | All | Full-featured mobile app |
| Create invoices (mobile) | Yes | All | Create and send from phone |
| Receipt capture (mobile) | Yes | All | Camera-based receipt scanning |
| Bank feed review (mobile) | Yes | All | Categorize transactions on the go |
| Mileage tracking | Yes | All | GPS-based mileage logging |
| Client/customer portal | Partial | All | Invoice view and pay only |
| Accountant portal (QBOA) | Yes | N/A | Free QuickBooks Online Accountant platform |

**Limitations:** Customer portal is invoice-payment only, not a full self-service portal. No supplier portal. Mobile app feature parity lags behind web. No offline mode for mobile app.

---

## 20. Group / Multi-Entity

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Multiple companies | No (native) | -- | One company per subscription |
| Consolidated reporting | No (native) | -- | Requires third-party (LiveFlow, Joiin, Fathom) |
| Intercompany transactions | No | -- | Must be done manually across separate subscriptions |
| Group chart of accounts | No | -- | Each entity has independent COA |
| Multi-entity dashboard | No | -- | Via third-party only |
| Elimination entries | No | -- | Via third-party only |

**Limitations:** QBO has ZERO native multi-entity/group capability. Each company requires a separate subscription. No intercompany eliminations, no consolidated reporting, no group management. This is a major gap for accounting firms and groups. Third-party tools (LiveFlow, Joiin, Fathom, FinBoard) fill this gap at additional cost.

---

## 21. Budgeting

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| Budget creation | Yes | Plus, Advanced | Annual P&L budgets |
| Budget vs Actual report | Yes | Plus, Advanced | Variance analysis |
| Budget by class | Yes | Plus, Advanced | Segment budgets |
| Budget by location | Yes | Plus, Advanced | Location-based budgets |
| Multiple budgets | Yes | Plus, Advanced | Can create multiple budget scenarios |
| Budget import | Partial | Advanced | Import budget data |
| Cash flow budgeting | No | -- | P&L budgets only; no cash flow budget |
| Rolling forecasts | No | -- | Static annual budgets only |
| Driver-based budgeting | No | -- | Requires third-party (Jirav, Vena) |

**Limitations:** Not available in Simple Start or Essentials. P&L budgets only -- no balance sheet or cash flow budgets. No rolling/flexible budgets. No collaborative budgeting workflows. No scenario planning. Static annual budgets only.

---

## 22. Compliance (South Africa Specific)

| Feature | Available | Plan | Notes |
|---------|-----------|------|-------|
| VAT @ 15% (pre-configured) | Yes | All | SA VAT rate built in |
| VAT return preparation | Yes | All | Data for SARS VAT201 |
| SARS eFiling integration | No | -- | Manual transfer required |
| IRP5 generation | No | -- | Via third-party payroll |
| EMP201/EMP501 | No | -- | Via third-party payroll |
| B-BBEE reporting | No | -- | Not supported |
| CIPC annual returns | No | -- | Not supported |
| IFRS compliance | Partial | All | Produces IFRS-aligned reports but no explicit IFRS tagging |
| Companies Act reporting | No | -- | No statutory report templates |
| Dividend withholding tax | No | -- | Not supported |
| SDL/UIF calculations | No | -- | Via third-party payroll |
| PAYE tables | No | -- | Via third-party payroll |
| Tax year (March) | Yes | All | Can set financial year to March |

**Limitations:** QBO ZA is essentially the global product with ZA VAT bolted on. No deep SA compliance features. All payroll compliance requires third-party. No B-BBEE, no CIPC, no Companies Act, no dividend tax support. SARS integration is manual only.

---

## Summary: Key Competitive Gaps in QBO ZA

1. **No native SA payroll** -- Must use SimplePay/PaySpace as paid add-on
2. **No multi-entity/consolidation** -- Each company is siloed
3. **No SARS eFiling integration** -- Manual VAT/tax submission
4. **No SA payment gateways** -- No PayFast, Paystack, SnapScan
5. **Fixed assets only on Advanced** -- Most expensive plan required
6. **No B-BBEE compliance** -- No scorecard or reporting
7. **Limited inventory** -- No multi-warehouse, no serial/batch tracking
8. **Budgeting only on Plus+** -- Not available on entry plans
9. **No native CSV export** -- Excel only, then manual conversion
10. **User limits per plan** -- 1/3/5/25 user caps
11. **No custom user roles** except Advanced plan
12. **No SSO/IP restrictions** -- Limited enterprise security
13. **AI features US-first** -- SA rollout lags behind

---

## Sources

- [QuickBooks South Africa Pricing](https://quickbooks.intuit.com/za/pricing/)
- [QuickBooks ZA Features](https://quickbooks.intuit.com/za/accounting-software-features/)
- [QuickBooks ZA Invoicing](https://quickbooks.intuit.com/za/invoicing-software/)
- [QuickBooks ZA VAT Tracking](https://quickbooks.intuit.com/za/vat-tracking-software/)
- [QuickBooks ZA Bank Feeds](https://quickbooks.intuit.com/za/bank-feeds/)
- [QuickBooks ZA Mobile App](https://quickbooks.intuit.com/za/mobile-accounting-app/)
- [QuickBooks ZA App Store](https://quickbooks.intuit.com/za/app-store/)
- [QuickBooks Plan Comparison](https://quickbooks.intuit.com/sg/online-compare/)
- [QuickBooks AI / Intuit Assist](https://quickbooks.intuit.com/ai-accounting/)
- [Intuit Assist Agentic AI 2025](https://www.firmofthefuture.com/product-update/quickbooks-innovation-agentic-ai-2025/)
- [QuickBooks Audit Log](https://quickbooks.intuit.com/learn-support/en-us/help-article/audit-log/use-audit-log-quickbooks-online/L2WoVnW6I_US_en_US)
- [QuickBooks User Roles](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/user-roles-access-rights-quickbooks-online/L66POfRrI_US_en_US)
- [QuickBooks Fixed Assets (Advanced)](https://quickbooks.intuit.com/learn-support/en-us/help-article/fixed-assets/add-manage-fixed-assets-quickbooks-online-advanced/L19788yU0_US_en_US)
- [QuickBooks Multicurrency](https://quickbooks.intuit.com/learn-support/en-us/help-article/multicurrency/set-use-multicurrency/L3AqaWJ9i_US_en_US)
- [QuickBooks Projects & Job Costing](https://www.fourlane.com/blog/what-quickbooks-online-can-do-for-project-tracking-and-job-costing/)
- [QuickBooks Inventory Management Guide](https://www.inflowinventory.com/blog/quickbooks-inventory-management/)
- [QuickBooks Receipt Capture](https://quickbooks.intuit.com/learn-support/en-us/help-article/import-transactions/upload-receipts-bills-quickbooks-online/L862MmZHn_US_en_US)
- [CaseWare QuickBooks Import](https://documentation.caseware.com/2023/WorkingPapers/en/Content/Engagements/File-Preparation/Imports/Import-QuickBooks.htm)
- [SimplePay QuickBooks Integration](https://www.simplepay.co.za/quickbooks)
- [QBO Plan Comparison Guide (FitSmallBusiness)](https://fitsmallbusiness.com/quickbooks-online-comparison/)
- [QBO Subscription Levels (Intuit)](https://quickbooks.intuit.com/subscription/)
- [GetApp QBO South Africa Reviews](https://www.getapp.za.com/software/20428/quickbooks-online-edition)
- [Capterra QBO South Africa](https://www.capterra.co.za/software/141374/quickbooks-online)
