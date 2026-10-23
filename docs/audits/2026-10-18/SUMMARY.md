# IsaFlow audit — 2026-10-18 (master 6ee5e9108)

8 auditors: 7 static (GL/reporting, AR, AP, banking, VAT/FX/rounding, payroll/assets/inventory, security/tenancy) + 1 browser run on dev (:3291, isaflow_dev, QA user; 6 workflows + 224-page nav sweep). Prod not touched. Detail per area in the sibling files.

| Area | CRIT | HIGH | MED | LOW |
|---|---|---|---|---|
| GL core & reporting | 1 | 2 | 8 | 10 |
| AR | 0 | 6 | 16 | 27 |
| AP | 0 | 9 | 19 | 17 |
| Banking | 0 | 3 | 12 | 13 |
| VAT / FX / rounding | 0 | 3 | 11 | 12 |
| Payroll / assets / inventory | 0 | 13 | 21 | 15 |
| Security / tenancy / API | 0 | 3 | 5 | 5 |
| Browser workflows | 0 | 2 | 6 | 7 |
| **Total** | **1** | **41** | **98** | **106** |

No cross-tenant leak or unauthenticated access found.
Lead-verified in code: G-01, S-01, AP eft-generate header.

## Fix first (wrong money / wrong filings)

1. **G-01 CRITICAL** — posted year-end closing journal is included in every P&L (incomeStatementService.ts:45, financialFiguresService.ts:73, AFS _helpers.ts:117, changesInEquityService.ts:94). Closed year shows zero profit; SOCE books profit as dividends.
2. **P1** — 2026/27 PAYE tables not registered (payroll/taxTables.ts:59-80); current runs use 2025/26. Confirm figures with SARS.
3. **P8** — e@syFile codes wrong (4142 for UIF, 4150 for SDL; missing 4149 / 3696-3699) — easyFileExportService.ts:250.
4. **P2** — ETI age 18–35, Act says 18–29 (etiEngine.ts:71): over-claimed ETI.
5. **P3/P4** — lump sums annualised ×12; terminated employees drop out of the final run.
6. **VAT201 page box numbering** differs from SARS form (VAT201SummaryForm.tsx:43-67); payment-basis option ignored; supplier CNs always 15% VAT (supplier-credit-notes.ts:106).
7. **Netcash submit** can pay a batch twice (netcash/submit.ts:55-151); **EFT file header** reads non-existent batch columns → blank originator account (eft-generate.ts:92).
8. **AR double-payment races** — draft receipt confirm, concurrent receipts/contra, write-off approval: none re-check/lock the balance; no DB constraint amount_paid ≤ total (B1, B2, C1).
9. **Banking** — reversing a bank-allocation journal from Journal Entries leaves subledger paid (B-01); overlapping bulk imports duplicate + double auto-post (B-02); reversing a *matched* line contra's an unrelated journal (B-21).
10. **Recurring invoices** dated 29th–31st skip February (recurringInvoiceRun.ts:186).
11. **Dashboard cash** sums bank_transactions not GL (kpiDashboardService.ts:88): R36.1M shown vs R(666K) GL on dev; Bank Tx page labels statement sum as "GL Balance".
12. **AI pipeline** auto-approves bills against a supplier whose name merely contains/is contained ("Sun" ← "Sunrise Catering").
13. **3-way match** queries `company_id` on po_items/grn_items (column missing) — fails for every PO bill.

## Security (HIGH)

- **S-01** viewer mints a PAT with write:post and posts/closes periods via MCP; only payroll tools check role (registry.ts:107, personal-tokens/index.ts:33).
- **S-02** viewer adds an external portal contact and emails management packs to it.
- **S-03** viewer can sign off AFS; 20+ AFS mutating routes lack a write-role check.
- Suspicion to confirm: login rate-limit keyed on last X-Forwarded-For — behind the tunnel all clients may share one bucket.
- Side note: cloudflared unit has its tunnel token on the command line (readable by local users).

## Also notable

Inventory not perpetual (no COGS / movements on sales); deferred tax sign inverted (A1); below-threshold asset expensing credits bank twice (A2); cash-flow statement doesn't reconcile (G-02); migration import re-posts opening TB (G-03); closed-period invoice approve → 500 instead of 400; supplier-payments page can't pay a partly-paid bill; VAT reconciliation counts drafts.

## Housekeeping

- Dev DB is missing migrations 618 and 532 (two pages 500 on dev) — check prod parity.
- Browser run left AUDIT1018-prefixed records in isaflow_dev (Demo company).
- K-069 fix sits on unmerged branch `fix/audit-k065-k069-payment-process-transfer-reversal`.
- Mechanical: 26 `as any`, 16 ts-ignore, 113 files >300 lines, 1 console.*, 0 empty catches.
