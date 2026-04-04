# /audit — ISAFlow Zero-Tolerance Full-Stack Audit

Run a comprehensive, zero-tolerance audit across **every layer** of ISAFlow: code quality, API correctness, UI/UX, workflows, document generation, data integrity, security, and accessibility. This is an **accounting application** — there is no margin for error.

## Usage

```
/audit                    # Full audit (all layers, all modules)
/audit accounting         # Accounting module only
/audit admin              # Admin module only
/audit code               # Code-only audit (no browser)
/audit ui                 # UI/UX-only audit (browser-based)
/audit workflow           # End-to-end workflow audit
/audit security           # Security-focused audit
/audit [page-name]        # Audit a specific page (e.g., /audit customer-invoices)
```

## Architecture

The audit uses a **manifest-driven** approach. The manifest at `.claude/audit-manifest.json` is the single source of truth for what exists in the app. When `/kb` runs, it regenerates the manifest. The audit checks **everything in the manifest** — so new features are automatically covered.

---

## PHASE 1: MANIFEST SYNC (Always runs first)

Before auditing, regenerate the manifest to catch any new features:

```bash
# Count current state
MODULES=$(ls -d src/modules/*/ 2>/dev/null | wc -l)
SERVICES=$(find src/modules -name "*Service.ts" -o -name "*service.ts" 2>/dev/null | wc -l)
API_ROUTES=$(find pages/api/accounting pages/api/admin -name "*.ts" 2>/dev/null | wc -l)
PAGES_ACCT=$(find pages/accounting -name "*.tsx" 2>/dev/null | wc -l)
PAGES_ADMIN=$(find pages/admin -name "*.tsx" 2>/dev/null | wc -l)
MIGRATIONS=$(ls scripts/migrations/sql/*.sql 2>/dev/null | wc -l)
```

Compare against `.claude/audit-manifest.json`. If counts differ, **regenerate the manifest** before proceeding.

List every:
- Page file (path + export name)
- API route (path + HTTP methods)
- Service file (path + exported functions)
- Migration file (number + name)
- Navigation item (from nav config)

---

## PHASE 2: CODE AUDIT — Zero Tolerance

### 2A. TypeScript Strictness
For **every** service and API file, check:

- [ ] **No `any` types** on public interfaces, function params, or return types
- [ ] **No `@ts-ignore` or `@ts-expect-error`** without a linked issue comment
- [ ] **No implicit `any`** from missing type annotations
- [ ] **No `as` type assertions** that bypass safety (e.g., `as any`, `as unknown as X`)
- [ ] **All function return types** are explicitly annotated
- [ ] **All API response shapes** use typed interfaces (not inline objects)

```bash
# Scan for violations
grep -rn "as any" src/modules/ pages/api/ --include="*.ts" --include="*.tsx"
grep -rn "@ts-ignore\|@ts-expect-error" src/modules/ pages/api/ --include="*.ts"
grep -rn ": any" src/modules/ pages/api/ --include="*.ts" | grep -v "node_modules"
```

### 2B. SQL & Database Safety
For **every** SQL query in services and API routes:

- [ ] **All queries use `sql` tagged templates** — no string concatenation
- [ ] **All queries include `company_id` scoping** (multi-tenant safety)
- [ ] **No raw SQL string building** (`"SELECT " + ...` or template literals without `sql`)
- [ ] **Parameterized inputs** — no user input injected into queries
- [ ] **Proper NULL handling** — `COALESCE` where needed, no silent NULL arithmetic
- [ ] **Decimal precision** — all monetary values use `NUMERIC(15,2)` or `money_amount` type
- [ ] **No floating point** for money — check for `REAL`, `FLOAT`, `DOUBLE PRECISION` in migrations
- [ ] **Transaction boundaries** — multi-step mutations wrapped in `BEGIN/COMMIT`
- [ ] **Index coverage** — frequently queried columns (company_id, date ranges, foreign keys) indexed

```bash
# Check for unsafe SQL patterns
grep -rn 'SELECT.*\+\|INSERT.*\+\|UPDATE.*\+\|DELETE.*\+' src/modules/ --include="*.ts" | grep -v "sql\`"
grep -rn "FLOAT\|REAL\|DOUBLE PRECISION" scripts/migrations/sql/
```

### 2C. API Route Correctness
For **every** API route in `pages/api/`:

- [ ] **Uses `withCompany` middleware** (or `withAdmin` for admin routes)
- [ ] **Uses `withErrorHandler`** wrapper
- [ ] **Returns via `apiResponse` helpers** (not raw `res.json()`)
- [ ] **HTTP method validation** — rejects unsupported methods with 405
- [ ] **Input validation** — all POST/PUT/PATCH bodies validated before use
- [ ] **No empty catch blocks** — errors logged or re-thrown
- [ ] **Rate limiting** on sensitive endpoints (login, password reset, API keys)
- [ ] **File upload routes** use `formidable` with size limits and type validation
- [ ] **Pagination** — list endpoints have `limit`/`offset` with max cap
- [ ] **Date handling** — all dates stored as UTC, displayed in user timezone

```bash
# Check for missing middleware
for f in $(find pages/api/accounting -name "*.ts"); do
  if ! grep -q "withCompany\|withAdmin\|withPublic" "$f"; then
    echo "MISSING MIDDLEWARE: $f"
  fi
done
```

### 2D. Error Handling
- [ ] **No `console.log`** — use proper logger (per Zero Tolerance protocol)
- [ ] **No empty catch blocks** — `catch(e) {}` or `catch(_) {}`
- [ ] **No swallowed errors** — every catch either logs, re-throws, or returns error response
- [ ] **API errors return structured JSON** — `{ success: false, error: "message" }`
- [ ] **Client-side errors show user-friendly messages** — no raw stack traces
- [ ] **Network errors handled** — `apiFetch` calls have error handling

```bash
grep -rn "console\.log\|console\.warn\|console\.error" src/modules/ pages/ --include="*.ts" --include="*.tsx" | grep -v "node_modules" | grep -v ".next"
grep -rn "catch.*{[[:space:]]*}" src/modules/ pages/ --include="*.ts"
```

### 2E. Service Layer Patterns
For **every** service file:

- [ ] **Single responsibility** — max 300 lines per file
- [ ] **Company ID as first parameter** — `(companyId: string, ...)`
- [ ] **No direct DB access from pages** — all DB queries go through services
- [ ] **Consistent naming** — `listX`, `getX`, `createX`, `updateX`, `deleteX`
- [ ] **No circular dependencies** between services

```bash
# Check file sizes
find src/modules -name "*.ts" -exec wc -l {} + | sort -rn | head -20
```

### 2F. Security Audit
- [ ] **No hardcoded secrets** — no API keys, passwords, or tokens in source
- [ ] **No sensitive data in URLs** — passwords, tokens not in query strings
- [ ] **CSRF protection** — state-changing operations require POST/PUT/DELETE
- [ ] **XSS prevention** — no `dangerouslySetInnerHTML` without sanitization
- [ ] **SQL injection prevention** — all queries parameterized (covered in 2B)
- [ ] **Auth checks** — every protected route validates session
- [ ] **Company isolation** — no cross-tenant data leakage possible
- [ ] **File upload safety** — type validation, size limits, no path traversal
- [ ] **Sensitive fields masked** — passwords, tokens, API keys never returned in responses
- [ ] **Audit logging** — all create/update/delete operations logged

```bash
grep -rn "dangerouslySetInnerHTML" pages/ --include="*.tsx"
grep -rn "password\|secret\|api_key\|token" pages/api/ --include="*.ts" | grep -v "password_hash\|token_type\|csrf"
```

---

## PHASE 3: UI/UX AUDIT — Browser-Based

Use `boss-ghost-mcp` or `claude-in-chrome` tools for browser automation. Test on production (`https://app.isaflow.co.za`) unless told otherwise.

### 3A. Page Load Audit
For **every page** listed in the manifest:

- [ ] **Page loads without JS errors** — check console for errors
- [ ] **No blank/white screens** — content renders
- [ ] **Loading states shown** — spinners/skeletons during data fetch
- [ ] **Empty states handled** — "No data" message when lists are empty
- [ ] **Page title set correctly** — browser tab shows meaningful title
- [ ] **Breadcrumbs correct** — navigation trail matches location
- [ ] **Responsive layout** — no horizontal overflow at 1024px, 768px
- [ ] **Dark mode** — if supported, no broken colors or invisible text

### 3B. Navigation Audit
- [ ] **Every nav item links to a working page** — no 404s
- [ ] **Active nav item highlighted** — current page shown in sidebar
- [ ] **Back button works** — browser back navigates correctly
- [ ] **Deep links work** — direct URL to any page loads correctly
- [ ] **Sidebar collapse/expand** — functions correctly
- [ ] **Mobile menu** — hamburger menu works on small screens

### 3C. Form Audit
For **every form** in the app:

- [ ] **All required fields marked** — asterisk or "required" label
- [ ] **Validation fires on submit** — empty required fields show errors
- [ ] **Validation fires on blur** — immediate feedback for invalid input
- [ ] **Error messages are specific** — "Email is required" not just "Required"
- [ ] **Success feedback** — toast/alert on successful submission
- [ ] **Submit button disables during submit** — prevents double-submit
- [ ] **Cancel button works** — navigates back or closes modal
- [ ] **Form retains data on error** — failed submit doesn't clear the form
- [ ] **Date pickers** — correct format (YYYY-MM-DD), valid range
- [ ] **Dropdowns** — load options, searchable for long lists
- [ ] **Number inputs** — accept decimals for money, reject negative where inappropriate
- [ ] **Currency fields** — 2 decimal places, proper formatting
- [ ] **Percentage fields** — 0-100 range, proper formatting

### 3D. Table/List Audit
For **every data table**:

- [ ] **Column headers present and labeled** — no blank columns
- [ ] **Sorting works** — click header to sort, indicator shown
- [ ] **Pagination works** — next/prev, page numbers, items per page
- [ ] **Search/filter works** — results update, clear filter resets
- [ ] **Empty state** — "No records found" when no data
- [ ] **Row actions work** — edit, delete, view buttons function
- [ ] **Bulk actions** — select all, deselect, bulk delete confirmation
- [ ] **Export functions** — CSV/PDF export generates valid file
- [ ] **Money columns right-aligned** — currency values formatted consistently
- [ ] **Date columns formatted** — consistent date format throughout

### 3E. Modal/Dialog Audit
- [ ] **Opens correctly** — content renders, no flash
- [ ] **Closes on X button** — modal dismissed
- [ ] **Closes on overlay click** — if designed to
- [ ] **Closes on Escape key** — keyboard accessible
- [ ] **Delete confirmations** — destructive actions require confirmation
- [ ] **Focus trapped** — tab stays within modal
- [ ] **Scroll behavior** — long modals scroll correctly, page doesn't scroll behind

### 3F. Document Generation Audit
For **every document type** (invoices, statements, credit notes, quotes, POs, etc.):

- [ ] **PDF generates without error** — download works
- [ ] **PDF contains correct data** — amounts, dates, line items match
- [ ] **PDF formatting** — proper layout, no overlapping text
- [ ] **Company details on document** — logo, name, address, VAT number
- [ ] **Customer/supplier details correct** — name, address, contact
- [ ] **Line items** — description, qty, unit price, tax, total
- [ ] **Totals** — subtotal, VAT, total calculate correctly
- [ ] **Currency formatting** — consistent, correct symbol
- [ ] **Email send** — document can be emailed, correct recipient

---

## PHASE 4: ACCOUNTING WORKFLOW AUDIT — End-to-End

### 4A. Customer Invoice Lifecycle
1. Create customer → verify in customer list
2. Create invoice → verify line items, tax calculation, total
3. View invoice → verify PDF generation
4. Email invoice → verify delivery
5. Record payment → verify allocation
6. Partial payment → verify outstanding balance
7. Full payment → verify invoice status = "Paid"
8. Credit note → verify balance adjustment
9. Statement → verify all transactions appear
10. Age analysis → verify aging buckets correct

### 4B. Supplier Invoice Lifecycle
1. Create supplier → verify in supplier list
2. Capture supplier invoice → verify line items, tax
3. Approve invoice (if approval workflow active)
4. Record payment → verify allocation
5. Supplier statement → verify reconciliation
6. AP aging → verify aging buckets

### 4C. Bank Reconciliation Workflow
1. Import bank transactions (CSV or feed)
2. Auto-categorize → verify AI suggestions
3. Match transactions → verify find & match
4. Create rules → verify auto-apply
5. Reconcile → verify reconciled status
6. Bank reconciliation report → verify totals match

### 4D. VAT Return Workflow
1. Run VAT201 report for period
2. Verify category totals (standard, zero-rated, exempt)
3. Verify input VAT vs output VAT
4. Verify VAT adjustments applied
5. Submit/finalize → verify period locked
6. Export for SARS submission

### 4E. Journal Entry Workflow
1. Create manual journal → verify debits = credits
2. Recurring journal → verify auto-posting schedule
3. GL import → verify template download, upload, processing
4. Trial balance → verify all accounts balance
5. Balance sheet → verify assets = liabilities + equity

### 4F. Year-End Workflow
1. Year-end close → verify retained earnings
2. Opening balances carry forward
3. New fiscal year periods created
4. Previous year locked for editing

### 4G. Chart of Accounts
1. Create account → verify in CoA list
2. Edit account → verify changes saved
3. Delete account → verify blocked if has transactions
4. Account categories → verify grouping correct
5. Default accounts → verify mappings

### 4H. Items & Inventory
1. Create item → verify in item list
2. Set pricing → verify price levels
3. Item adjustments → verify stock level changes
4. Opening balances → verify cost values
5. Stock levels report → verify accuracy

### 4I. Quotes & Sales Orders
1. Create quote → verify PDF generation
2. Convert quote to invoice → verify data carries over
3. Create sales order → verify PDF
4. Convert SO to invoice → verify line items

### 4J. Purchase Orders & GRV
1. Create PO → verify PDF generation
2. Receive goods (GRV) → verify against PO quantities
3. Convert to supplier invoice → verify data carries over

### 4K. Multi-Currency
1. Set exchange rates → verify rates saved
2. Create foreign currency invoice → verify conversion
3. Verify realized/unrealized gains/losses
4. Reports in base currency → verify conversion

### 4L. Dunning & Collections
1. Configure dunning rules → verify levels
2. Run dunning → verify letters generated
3. Verify escalation at each level

### 4M. Recurring Transactions
1. Set up recurring invoice → verify schedule
2. Verify auto-generation on due date
3. Edit recurrence → verify changes apply
4. Cancel recurrence → verify stops

### 4N. Bank Transfers
1. Create bank transfer → verify both accounts affected
2. Verify reconciliation on both sides

### 4O. Batch Payments
1. Select invoices for batch → verify selection
2. Generate batch file → verify format
3. Mark as paid → verify allocations

### 4P. Cost Centres & Business Units
1. Create cost centre → verify in list
2. Assign to transactions → verify tagging
3. Reports by cost centre → verify filtering
4. Business unit dimensions → verify drilling

### 4Q. Data Archiving
1. Archive old data → verify moved
2. Verify archived data accessible in read-only mode
3. Verify active reports exclude archived data

### 4R. Budgets
1. Create budget → verify periods
2. Enter budget amounts → verify saved
3. Budget vs actual report → verify variances

---

## PHASE 5: ADMIN MODULE AUDIT

### 5A. Company Management
- [ ] **List all companies** — table loads, pagination works
- [ ] **View company detail** — all fields populated
- [ ] **Edit company** — changes save correctly
- [ ] **Company features** — toggle features on/off, verify effect
- [ ] **Company users** — list users, roles correct

### 5B. User Management
- [ ] **List users** — table loads, search works
- [ ] **View user detail** — companies, roles, last login
- [ ] **Edit user** — role changes take effect
- [ ] **Invite user** — email sent, registration flow works
- [ ] **Deactivate user** — user cannot login

### 5C. Billing & Subscriptions
- [ ] **Plans page** — list all plans, create/edit/delete
- [ ] **Subscriptions** — list active, trial, expired
- [ ] **Invoices** — billing invoices generated, PDF correct
- [ ] **Payment processing** — status updates reflect correctly

### 5D. Feature Flags
- [ ] **List features** — all features shown
- [ ] **Toggle feature** — enable/disable per company
- [ ] **Feature effects** — disabled feature hides UI elements

### 5E. Audit Log (Admin)
- [ ] **All admin actions logged** — create, update, delete
- [ ] **Filter by action, user, entity** — works correctly
- [ ] **Export audit log** — CSV download

### 5F. Analytics Dashboard
- [ ] **Company stats** — active, trial, expired counts
- [ ] **User stats** — total, active, invited
- [ ] **Revenue metrics** — MRR, ARR calculations
- [ ] **Charts render** — no blank chart areas

### 5G. Tools
- [ ] **Announcements** — create, edit, delete, publish
- [ ] **System settings** — save correctly

---

## PHASE 6: CROSS-CUTTING CONCERNS

### 6A. Performance
- [ ] **Page load < 3s** — all pages
- [ ] **API response < 500ms** — all list endpoints
- [ ] **No N+1 queries** — check service layer
- [ ] **Pagination implemented** — no unbounded queries
- [ ] **Client-side caching** — SWR/React Query where appropriate

### 6B. Accessibility
- [ ] **All inputs have labels** — visible or aria-label
- [ ] **Tab order logical** — forms navigable by keyboard
- [ ] **Color contrast** — text readable on all backgrounds
- [ ] **Screen reader landmarks** — main, nav, header regions
- [ ] **Focus indicators** — visible focus rings on interactive elements

### 6C. Error Recovery
- [ ] **Network failure** — retry or error message shown
- [ ] **Session expiry** — redirect to login
- [ ] **404 pages** — custom not-found page
- [ ] **500 errors** — graceful error boundary, not white screen
- [ ] **Concurrent edits** — optimistic locking or last-write-wins

### 6D. Data Integrity
- [ ] **Rounding consistency** — all calculations use banker's rounding
- [ ] **Decimal precision** — 2 decimal places for currency, 4 for rates
- [ ] **Zero-sum journals** — debits always equal credits
- [ ] **Trial balance always balances** — sum of debits = sum of credits
- [ ] **Aging totals** — sum of aging buckets = total outstanding
- [ ] **VAT calculations** — line-level tax matches header totals
- [ ] **Foreign currency** — round after conversion, not before
- [ ] **Negative amounts** — only allowed where valid (credit notes, refunds)

### 6E. Multi-Tenant Isolation
- [ ] **Every query scoped to company_id** — no cross-tenant data
- [ ] **API cannot access other company's data** — test with wrong company_id
- [ ] **File uploads scoped** — documents belong to company
- [ ] **Audit log scoped** — shows only current company's activity

---

## PHASE 7: REGRESSION CHECKLIST

Items from previously fixed bugs (from memory `project_known_bugs.md`):

- [ ] Customer invoice PDF generates correctly
- [ ] Bank rule auto-apply works on create
- [ ] AI categorize respects 15s timeout
- [ ] Invite flow goes to register, not login
- [ ] Bank match confirmation includes company_id
- [ ] Sage auto-import unwraps `json.data.session` correctly
- [ ] Find & match filters by direction
- [ ] Smart entity filtering works in bank matching
- [ ] Cost centre / business unit dimensions save correctly

---

## REPORT FORMAT

```
╔════════════════════════════════════════════════════════════════════╗
║              ISAFLOW FULL-STACK AUDIT REPORT                      ║
║              Date: YYYY-MM-DD                                     ║
║              Scope: [full | accounting | admin | code | ui]       ║
╠════════════════════════════════════════════════════════════════════╣
║                                                                    ║
║  MANIFEST:                                                        ║
║    Modules: N | Services: N | APIs: N | Pages: N | Migrations: N  ║
║                                                                    ║
╠══════════════════════════════════════════════════════════════════╣
║  PHASE 1 — Manifest Sync           ✅ PASS / ❌ N issues         ║
║  PHASE 2 — Code Audit              ✅ PASS / ❌ N issues         ║
║    2A TypeScript Strictness         N violations                   ║
║    2B SQL & Database Safety         N violations                   ║
║    2C API Route Correctness         N violations                   ║
║    2D Error Handling                N violations                   ║
║    2E Service Layer Patterns        N violations                   ║
║    2F Security                      N violations                   ║
║  PHASE 3 — UI/UX Audit             ✅ PASS / ❌ N issues         ║
║    3A Page Loads                    N/N pages OK                   ║
║    3B Navigation                    N/N links OK                   ║
║    3C Forms                         N/N forms OK                   ║
║    3D Tables                        N/N tables OK                  ║
║    3E Modals                        N/N modals OK                  ║
║    3F Documents                     N/N documents OK               ║
║  PHASE 4 — Workflow Audit           ✅ PASS / ❌ N issues         ║
║    4A-4R Workflow coverage           N/18 workflows tested         ║
║  PHASE 5 — Admin Audit             ✅ PASS / ❌ N issues         ║
║    5A-5G Admin coverage              N/7 areas tested              ║
║  PHASE 6 — Cross-Cutting           ✅ PASS / ❌ N issues         ║
║    6A Performance                   N issues                       ║
║    6B Accessibility                 N issues                       ║
║    6C Error Recovery                N issues                       ║
║    6D Data Integrity                N issues                       ║
║    6E Multi-Tenant Isolation        N issues                       ║
║  PHASE 7 — Regression              ✅ PASS / ❌ N issues         ║
║                                                                    ║
╠════════════════════════════════════════════════════════════════════╣
║  OVERALL SCORE: XX/100                                            ║
║  CRITICAL ISSUES: N (must fix before deploy)                      ║
║  WARNINGS: N (should fix soon)                                    ║
║  INFO: N (nice to have)                                           ║
╚════════════════════════════════════════════════════════════════════╝

## Critical Issues (Severity: CRITICAL)
| # | Phase | File/Page | Issue | Fix Required |
|---|-------|-----------|-------|--------------|
| 1 | 2B | path/file.ts:42 | Raw SQL concatenation | Use sql tagged template |

## Warnings (Severity: WARNING)
| # | Phase | File/Page | Issue | Recommendation |
|---|-------|-----------|-------|----------------|

## Info (Severity: INFO)
| # | Phase | File/Page | Issue | Note |
|---|-------|-----------|-------|------|
```

---

## EXECUTION STRATEGY

### For `/audit` or `/audit full`:
1. Run Phase 1 (manifest sync)
2. Launch **parallel agents**:
   - `code-audit` agent → Phases 2 + 6E (code-only, no browser)
   - `ui-audit` agent → Phases 3 + 5 (browser-based)
   - `workflow-audit` agent → Phase 4 (browser-based, sequential)
3. Collect results from all agents
4. Run Phase 6 cross-cutting analysis
5. Run Phase 7 regression checklist
6. Generate consolidated report

### For `/audit code`:
Run Phases 1, 2, 6D, 6E only (no browser needed).

### For `/audit ui`:
Run Phases 1, 3, 5 only (browser-based).

### For `/audit workflow`:
Run Phases 1, 4 only (browser-based, sequential).

### For `/audit security`:
Run Phases 1, 2B, 2F, 6E only.

### For `/audit [page-name]`:
1. Find the page in the manifest
2. Run code audit on its API route + service
3. Run UI audit on the page in browser
4. Run any related workflow steps

### Delegation Model
- Use `haiku` for manifest counting and simple grep checks
- Use `sonnet` for code analysis, UI testing, pattern matching
- Use `opus` for cross-cutting analysis, report generation, and judgment calls

---

## SCORING

| Score | Rating | Meaning |
|-------|--------|---------|
| 95-100 | PRISTINE | Zero tolerance met — production ready |
| 85-94 | SOLID | Minor issues, safe to deploy with plan |
| 70-84 | NEEDS WORK | Significant issues, fix before next deploy |
| 50-69 | AT RISK | Major gaps, sprint-level remediation needed |
| < 50 | CRITICAL | Stop feature work, focus on remediation |

Scoring weights:
- Security violations: -10 per critical
- Data integrity issues: -10 per critical
- SQL injection/XSS: -15 per finding
- Missing company_id scoping: -10 per finding
- Empty catch blocks: -3 per finding
- `any` types on public APIs: -2 per finding
- UI errors: -5 per broken page
- Missing validation: -3 per form
- Missing error handling: -2 per endpoint
- Console.log usage: -1 per instance

---

## SELF-UPDATING

This audit automatically stays current because:

1. **Manifest-driven** — `/kb` regenerates `.claude/audit-manifest.json` with every new page, API, service, or migration
2. **Pattern-based checks** — code audit uses `grep`/`find` patterns that catch all files matching conventions
3. **Workflow registry** — Phase 4 workflows map to manifest entries; new transaction types get new workflow tests
4. **Regression list** — Phase 7 pulls from `project_known_bugs.md` memory which is updated when bugs are fixed

When running `/kb`, it will:
- Count new pages/APIs/services
- Update the manifest
- Flag any new items that need audit coverage
- Report `AUDIT COVERAGE: N/N items covered`

---

## CRITICAL RULES FOR AUDITORS

1. **Never skip a check** — every checkbox must be explicitly PASS or FAIL
2. **Never assume** — verify by reading code or testing in browser
3. **File + line number** — every finding must reference exact location
4. **Severity matters** — CRITICAL = data loss/corruption/security breach possible
5. **Accounting precision** — 1 cent off is a CRITICAL finding
6. **Multi-tenant** — 1 cross-tenant leak is a CRITICAL finding
7. **No hand-waving** — "looks fine" is not acceptable; show evidence
8. **Reproducible** — every UI finding must include steps to reproduce
