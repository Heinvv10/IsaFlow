# Phase 5 — Wave 2 Stream 2B: IDOR Surface Sweep

**Date:** 2026-04-15
**Stream:** 2B — IDOR surface
**Auditor:** Claude Sonnet 4.6 (autonomous)
**Scope:** `pages/api/accounting/` — all handlers accepting an ID from `req.query` or `req.body`

---

## Summary

| Metric | Count |
|--------|-------|
| Total API route files audited | 317 |
| Routes accepting an ID param (query or body) | 21 |
| P0 findings | 0 |
| P1 findings | 3 |
| P2 findings | 1 |
| P3 findings | 0 |
| Client-supplied company_id hits | 5 (all legitimate — see below) |
| State-changing routes missing withCompany | 0 |

---

## Per-route findings

| # | Route | Method(s) | ID param | withCompany | withCsrf | Scoped service | Severity | Notes |
|---|-------|-----------|----------|-------------|----------|----------------|----------|-------|
| 1 | `account-reporting-groups/[id]/members` | GET, POST | `req.query.id` | ✅ | — | `getAccountReportingGroup(companyId, groupId)` | Clean | companyId threaded through all calls |
| 2 | `account-reporting-groups` | GET, POST, PATCH, DELETE | `req.query.id` | ✅ | — | `updateAccountReportingGroup(companyId, id)` | Clean | All service calls include companyId |
| 3 | `approval-rules` | GET, POST, PUT, DELETE | `req.body.id` / `req.query.id` | ✅ | — | `updateRule(companyId, id, ...)` / `deleteRule(companyId, id)` | Clean | companyId scoped at service layer |
| 4 | `asset-locations` | GET, POST, PATCH, DELETE | `req.query.id` | ✅ | — | Raw `sql` with `AND company_id = ${companyId}` | Clean | Direct SQL guard present |
| 5 | `bank-feeds/[id]` | DELETE | `req.query.id` | ✅ | — | `deleteBankFeedConnection(companyId, connectionId)` | Clean | companyId first param |
| 6 | `bank-feeds/[id]/logs` | GET | `req.query.id` | ✅ | — | `getBankFeedSyncLogs(companyId, connectionId, ...)` | Clean | companyId first param |
| 7 | `bank-feeds/[id]/sync` | POST | `req.query.id` | ✅ | — | `syncBankFeed(companyId, connectionId, userId)` | Clean | companyId first param |
| 8 | `chart-of-accounts-detail` | GET, PUT, DELETE | `req.query.id` / `req.body.id` | ✅ | — | `getAccountById(companyId, id)` / `updateAccount(companyId, id, ...)` / `deleteAccount(companyId, id)` | Clean | All service calls gated by companyId |
| 9 | `companies` | GET, POST, PUT | `req.query.id` / `req.body.companyId` | withAuth | — | `getUserCompanies(userId)` membership check before access | **P2** | `req.body.companyId` used for set-default but guarded by membership check; GET ?id= guarded by membership check or super_admin role; defense-in-depth gap: no second ownership check at service layer when super_admin accesses arbitrary companies |
| 10 | `company-documents` | GET, POST, DELETE | `req.query.id` / `req.query.companyId` / `req.body.companyId` | withAuth | — | `validateMembership(companyId)` before all reads/writes | Clean | Uses withAuth by design (cross-company). validateMembership() guards every branch. |
| 11 | `consolidated-reports` | GET, POST | `req.query.group_id` / `req.body.adjustmentId` | withAuth | — | `verifyGroupAccess(gId)` before all reads, but `postEliminationAdjustment(adjustmentId)` and `reverseEliminationAdjustment(adjustmentId)` do NOT verify the adjustmentId belongs to the verified gId | **P1** | See Finding F-001 |
| 12 | `custom-reports` | GET, POST, DELETE | `req.query.id` | ✅ | — | `getTemplateById(companyId, id)` / `deleteTemplate(companyId, userId, id)` | Clean | Delete verifies ownership by companyId AND userId |
| 13 | `description-templates` | GET, POST, DELETE | `req.query.id` | ✅ | — | `deleteTemplate(companyId, id)` → `WHERE id=... AND company_id=...` | Clean | SQL delete requires both id and company_id |
| 14 | `disclosure-notes-manual` | POST, DELETE | `req.query.id` | ✅ | — | `deleteManualNote(companyId, noteId)` | Clean | companyId scoped at service layer |
| 15 | `documents` | GET, POST, DELETE | `req.query.entity_id` / `req.query.id` | ✅ | — | GET+DELETE: `verifyEntityOwnership(entityId, companyId)` before action; POST: NO ownership check | **P1** | See Finding F-002 |
| 16 | `intercompany-transactions` | GET, POST | `req.query.group_id` / `req.body.sourceId` / `req.body.targetId` | withAuth | — | `verifyGroupAccess(groupId, userId)` guards GET and create; `matchIntercompanyTransactions(sourceId, targetId)` does NOT verify sourceId/targetId belong to verified group | **P1** | See Finding F-003 |
| 17 | `journal-entries-detail` | GET | `req.query.id` | ✅ | — | `getJournalEntryById(companyId, id)` | Clean | Read-only; companyId scoped |
| 18 | `purchase-orders/[id]` | GET, PUT, DELETE | `req.query.id` | ✅ | — | Raw `sql` with `AND company_id = ${companyId}::UUID` | Clean | Direct SQL guard on all three methods |
| 19 | `recurring-transactions` | GET, POST, PUT, DELETE | `req.body.id` / `req.query.id` | ✅ | — | `updateRecurringTemplate(companyId, id, ...)` / `deleteRecurringTemplate(companyId, id)` | Clean | companyId first arg in all mutating calls |
| 20 | `supplier-invoices-detail` | GET, PUT | `req.query.id` / `req.body.id` | ✅ | — | GET: `getSupplierInvoiceById(companyId, id)`; PUT: raw `sql` with `AND company_id = ${companyId}` | Clean | Both paths guarded |
| 21 | `tax-directives` | GET, POST, PATCH | `req.query.id` | ✅ | — | `updateTaxDirectiveStatus(companyId, id, ...)` | Clean | companyId threaded through |
| 22 | `webhooks` | GET, POST, PUT, DELETE | `req.body.id` / `req.query.id` | ✅ | — | `updateWebhook(companyId, id, ...)` / `deleteWebhook(companyId, id)` | Clean | companyId first arg in all mutating calls |

---

## Detailed Findings

### F-001 — P1: `consolidated-reports` — adjustmentId IDOR on post/reverse actions

**Route:** `pages/api/accounting/consolidated-reports.ts`
**Methods:** POST (action=`post-elimination`, action=`reverse-elimination`)
**Attack surface:**

```
POST /api/accounting/consolidated-reports
{ "group_id": "<attacker-owns-group>", "action": "post-elimination", "adjustmentId": "<victim-group-adjustment-UUID>" }
```

**Root cause:** The handler calls `verifyGroupAccess(gId)` correctly, but then passes the client-supplied `adjustmentId` directly to `postEliminationAdjustment(adjustmentId)` and `reverseEliminationAdjustment(adjustmentId)` without verifying the adjustment belongs to `gId`.

`postEliminationAdjustment` and `reverseEliminationAdjustment` in `consolidatedReportingService.ts` (lines 170–196) query only on `id`, not on `group_id`:

```sql
UPDATE consolidation_adjustments SET status='posted', ...
WHERE id=${adjustmentId}::UUID AND status='draft'
-- Missing: AND group_id = ${gId}::UUID
```

**Fix:** Add `AND group_id = ${groupId}::UUID` to both UPDATE statements, or verify ownership in the handler before calling the service.

**Files:**
- `pages/api/accounting/consolidated-reports.ts` lines 101–111
- `src/modules/accounting/services/reports/consolidatedReportingService.ts` lines 170–196

---

### F-002 — P1: `documents` — POST upload missing entity ownership check

**Route:** `pages/api/accounting/documents.ts`
**Method:** POST (multipart upload)
**Attack surface:**

```
POST /api/accounting/documents (multipart)
entity_type=supplier_invoice
entity_id=<victim-company-invoice-UUID>
```

**Root cause:** The main handler dispatches POST to `handlePost(req, res, user)` — passing only `user`, not `companyId`. The `handlePost` function calls `uploadDocument({ entityType, entityId, ... })` without first calling `verifyEntityOwnership(entityId, companyId)`.

GET and DELETE both call `verifyEntityOwnership(entityId, companyId)` before acting. POST skips this check entirely.

An authenticated user can attach a document to another tenant's invoice, supplier payment, customer invoice, etc.

**Fix:** Pass `companyId` to `handlePost` and call `verifyEntityOwnership(entityId, companyId)` before `uploadDocument`.

**Files:**
- `pages/api/accounting/documents.ts` lines 42–51 (dispatch), 95–164 (handlePost)
- `src/modules/accounting/services/core/documentStorageService.ts` lines 83–93 (verifyEntityOwnership)

---

### F-003 — P1: `intercompany-transactions` — match action IDOR on sourceId/targetId

**Route:** `pages/api/accounting/intercompany-transactions.ts`
**Method:** POST (action=`match`)
**Attack surface:**

```
POST /api/accounting/intercompany-transactions
{ "action": "match", "sourceId": "<victim-group-tx-UUID>", "targetId": "<victim-tx-UUID>", "groupId": "<attacker-owns-group>" }
```

**Root cause:** The handler verifies `verifyGroupAccess(matchGroupId, userId)` on the supplied `matchGroupId`, but then calls `matchIntercompanyTransactions(sourceId, targetId)` without verifying the transactions belong to `matchGroupId`.

`matchIntercompanyTransactions` in `intercompanyService.ts` (lines 142–167) fetches by `id` only — no `group_id` filter:

```sql
SELECT * FROM intercompany_transactions WHERE id = ${sourceId}::UUID
-- Missing: AND group_id = ${groupId}::UUID
```

**Fix:** Add `AND group_id = ${groupId}::UUID` to both SELECT statements in `matchIntercompanyTransactions`, or add ownership verification in the handler.

**Files:**
- `pages/api/accounting/intercompany-transactions.ts` lines 60–66
- `src/modules/accounting/services/reports/intercompanyService.ts` lines 142–167

---

### F-004 — P2: `companies` — super_admin accesses arbitrary companies (defense-in-depth gap)

**Route:** `pages/api/accounting/companies.ts`
**Method:** GET `?id=<uuid>`
**Context:** The handler explicitly allows super_admin users to fetch any company record without a membership check. This is intentional and documented. However, there is no audit log of super_admin company access, creating a defense-in-depth gap — undetected impersonation is impossible to investigate post-incident.

**Classification:** P2 — design is intentional, but depth is missing.

**Recommended fix:** Emit a `log.warn` or `log.info` (audit-level) whenever `isSuperAdmin` short-circuits the membership check, including `userId`, `targetCompanyId`, and timestamp.

---

## Client-supplied company_id check

```
pages/api/accounting/intercompany-transactions.ts:53:  sourceCompanyId: req.query.company_id
pages/api/accounting/company-documents.ts:65:    const companyId = typeof req.query.companyId === 'string'
pages/api/accounting/company-groups.ts:70:      const companyId = req.query.company_id as string | undefined;
pages/api/accounting/company-groups.ts:80:      const companyId = req.query.company_id as string;
pages/api/accounting/companies.ts:55:      if (!userCompanies.some(c => c.companyId === req.body.companyId))
```

**Assessment:** None of these are P0. All five instances are guarded:

| Hit | Guard |
|-----|-------|
| `intercompany-transactions` `req.query.company_id` | Used as a filter param inside `listIntercompanyTransactions`; group access already verified via `verifyGroupAccess` |
| `company-documents` `req.query.companyId` | Immediately validated by `validateMembership(companyId)` |
| `company-groups` `req.query.company_id` (line 70) | Validated by `sql` membership check before use |
| `company-groups` `req.query.company_id` (line 80) | Validated by `sql` membership check before use |
| `companies` `req.body.companyId` | Validated: `!userCompanies.some(c => c.companyId === req.body.companyId)` → 403 |

**Expected 0 unguarded hits — confirmed 0.**

---

## State-changing routes missing withCompany

**None found.** All 317 routes use `withCompany` or `withAuth`. The 6 `withAuth` routes are cross-company by design (companies, company-documents, company-groups, company-logo, consolidated-reports, intercompany-transactions) and all implement per-request membership/group verification.

---

## Clean sample (5 representative routes confirmed clean)

| Route | Why clean |
|-------|-----------|
| `approval-rules` | `withCompany` → `deleteRule(companyId, id)` at service layer |
| `bank-feeds/[id]/sync` | `withCompany` → `syncBankFeed(companyId, connectionId, userId)` — companyId is first arg |
| `purchase-orders/[id]` | `withCompany` → raw SQL with `AND company_id = ${companyId}::UUID` on all 3 methods |
| `webhooks` | `withCompany` → `deleteWebhook(companyId, id)` — companyId scopes the delete |
| `description-templates` | `withCompany` → service `WHERE id=... AND company_id=...` in delete SQL |

---

## Remediation Priority

| Priority | Finding | Est. Effort |
|----------|---------|-------------|
| P1 | F-002: documents POST missing entity ownership check | 30 min |
| P1 | F-001: consolidated-reports adjustmentId not verified against group | 30 min |
| P1 | F-003: intercompany match action sourceId/targetId not group-verified | 30 min |
| P2 | F-004: super_admin company access missing audit log | 15 min |
