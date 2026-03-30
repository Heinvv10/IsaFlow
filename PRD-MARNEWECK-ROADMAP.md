# PRD: ISAFlow Rolls-Royce Roadmap
## Addressing Mr Marneweck's Gap Analysis — Full Implementation Plan

**Version:** 1.0
**Date:** 30 March 2026
**Status:** Draft
**Owner:** ISAFlow Product & Engineering

---

## 1. Overview

This PRD defines the complete implementation plan for every gap and partial item identified in the ISAFlow Gap Analysis Report. It covers 22 deliverables across 4 quarters, organized into 8 workstreams. Each feature includes requirements, acceptance criteria, database changes, API contracts, UI specifications, and testing strategy.

**Goal:** Transform ISAFlow from a strong accounting platform (69% feature coverage) into a Rolls-Royce-class system (100% coverage) that surpasses Sage, Xero, and QuickBooks in the South African market.

---

## 2. Workstream Summary

| # | Workstream | Quarter | Items | Priority |
|---|-----------|---------|-------|----------|
| WS-1 | Audit Trail & Data Integrity | Q2 2026 | 2 | Critical + Medium |
| WS-2 | Security & Authentication | Q2 2026 | 1 | High |
| WS-3 | Command Palette & Keyboard Shortcuts | Q2 2026 | 2 | High |
| WS-4 | Permissions & Governance | Q3 2026 | 2 | High |
| WS-5 | Performance & Caching | Q3 2026 | 1 | High |
| WS-6 | UX Enhancements | Q3 2026 | 6 | Medium |
| WS-7 | Reporting & Compliance | Q4 2026 | 4 | High + Medium |
| WS-8 | Integration & Migration | Q4 2026 + Q1 2027 | 4 | Medium + Low |

---

## 3. Architecture Conventions

All implementations MUST follow existing ISAFlow patterns:

- **Migrations:** `scripts/migrations/sql/NNN_description.sql` — sequential numbering, idempotent (`IF NOT EXISTS`), indexes on query paths
- **Services:** `src/modules/accounting/services/*Service.ts` — async functions, `sql` tagged templates, `log` singleton, company-scoped queries
- **APIs:** `pages/api/accounting/*.ts` — `withCompany(withErrorHandler(handler))`, `apiResponse.*` helpers, userId from JWT
- **Pages:** `pages/accounting/*.tsx` — `<AppLayout>`, `useCompany()`, `apiFetch()`, hydration safety, Tailwind + CSS vars
- **Preferences:** `user_preferences` table — key/value per user, no company scope
- **Logging:** `log.info/warn/error(message, data, component)` — never `console.*`

---

## WS-1: Audit Trail & Data Integrity (Q2 2026) — CRITICAL

### Feature 1.1: Comprehensive Audit Trail

**Gap:** No field-level change history. Only created_by/posted_by/reversed_by timestamps on GL entries. Accountants need to trace exactly who changed what and when.

**Priority:** Critical
**Effort:** 2 weeks

#### 1.1.1 Database Migration — `267_audit_trail.sql`

```sql
-- Core audit log table
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id),
  user_email VARCHAR(255),
  action VARCHAR(20) NOT NULL CHECK (action IN (
    'create', 'update', 'delete', 'post', 'reverse', 'approve', 'reject', 'login', 'export'
  )),
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  entity_ref VARCHAR(100),
  changes JSONB,
  ip_address VARCHAR(45),
  user_agent TEXT,
  session_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_log_company ON audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_date ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_company_date ON audit_log(company_id, created_at DESC);

-- GIN index for JSONB changes queries
CREATE INDEX IF NOT EXISTS idx_audit_log_changes ON audit_log USING GIN (changes);
```

**`changes` JSONB structure:**
```json
{
  "fields": [
    {
      "field": "amount",
      "old": "50000.00",
      "new": "55000.00",
      "label": "Invoice Amount"
    },
    {
      "field": "status",
      "old": "draft",
      "new": "posted",
      "label": "Status"
    }
  ],
  "metadata": {
    "source": "manual",
    "reason": "Correction per client request"
  }
}
```

**Entity types to track:**
- `gl_journal_entry` — create, post, reverse
- `gl_account` — create, update, deactivate
- `customer_invoice` — create, update, post, write_off
- `supplier_invoice` — create, update, post, approve
- `bank_transaction` — match, exclude, split, allocate
- `bank_rule` — create, update, delete
- `customer` — create, update, delete
- `supplier` — create, update, delete
- `item` — create, update, delete
- `approval_request` — approve, reject
- `fixed_asset` — create, update, dispose, depreciate
- `budget` — create, update
- `company_settings` — update
- `user_access` — invite, role_change, remove

#### 1.1.2 Service — `auditTrailService.ts`

```
Location: src/modules/accounting/services/auditTrailService.ts

Functions:
  logAudit(params: AuditEntry): Promise<void>
    - Fire-and-forget (non-blocking, catch errors silently)
    - Auto-detect IP from request headers (x-forwarded-for, x-real-ip)
    - Compute diff between old and new objects for 'update' actions

  getAuditLog(companyId, filters): Promise<{ items: AuditLogItem[], total: number }>
    - Filters: entity_type, entity_id, user_id, action, date_from, date_to
    - Pagination: limit, offset
    - Sort: created_at DESC (default)

  getEntityHistory(companyId, entityType, entityId): Promise<AuditLogItem[]>
    - Full change timeline for a specific record
    - Used for "History" panel on entity detail pages

  diffObjects(oldObj, newObj, fieldLabels): ChangeField[]
    - Compute field-level changes
    - Skip unchanged fields
    - Map field names to human-readable labels
    - Handle nested objects (e.g., line items)
```

#### 1.1.3 Integration Pattern

Every service function that modifies data must call `logAudit()` after successful mutation. Pattern:

```typescript
// In journalEntryService.ts → postEntry():
const result = await sql`UPDATE gl_journal_entries SET status='posted' ...`;
await logAudit({
  companyId, userId, action: 'post',
  entityType: 'gl_journal_entry', entityId: id,
  entityRef: result.entry_number,
  changes: { fields: [{ field: 'status', old: 'draft', new: 'posted', label: 'Status' }] },
  ip, userAgent, sessionId,
});
```

#### 1.1.4 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounting/audit-log` | List audit entries with filters, pagination |
| GET | `/api/accounting/audit-log-entity?type=X&id=Y` | History for specific entity |
| GET | `/api/accounting/audit-log-export` | Export audit log as Excel/CSV |

**Query params for list:** `entity_type`, `entity_id`, `user_id`, `action`, `date_from`, `date_to`, `search` (searches entity_ref and user_email), `limit`, `offset`

#### 1.1.5 UI — Audit Log Viewer

**Page:** `pages/accounting/audit-log.tsx`

**Layout:**
- Header: "Audit Trail" title with export button
- Filter bar: Entity type dropdown, Action dropdown, User dropdown, Date range picker, Search box
- Table columns: Date/Time, User, Action, Entity Type, Reference, Changes Summary, IP
- Expandable rows: Show full change detail (field → old value → new value)
- Click entity reference → navigate to that entity

**Entity History Panel:**
- Reusable `<AuditHistory entityType="X" entityId="Y" />` component
- Shown as slide-over panel on entity detail pages (invoices, journal entries, etc.)
- Timeline view: vertical list of changes with user avatar, action, and timestamp

#### 1.1.6 Navigation

Add "Audit Trail" to the Tools tab in `accountingNavConfig.ts`:
```
Tools → Audit Trail (existing reports/audit-trail.tsx becomes the new audit-log.tsx)
```

#### 1.1.7 Acceptance Criteria

- [ ] Every create/update/delete/post/reverse action on financial entities writes to audit_log
- [ ] Changes JSONB captures field-level before/after values for all update actions
- [ ] Audit log viewer shows paginated list with all filters working
- [ ] Entity history panel shows timeline of changes for any record
- [ ] Export to Excel includes all visible columns
- [ ] Audit log entries are company-scoped (users only see their company's audit trail)
- [ ] logAudit() is non-blocking — failures don't break the parent operation
- [ ] IP address captured from request headers
- [ ] Audit log entries cannot be modified or deleted via API (append-only)

---

### Feature 1.2: Undo Capability for Recent Actions

**Gap:** No general undo. Only GL reversals exist for posted entries.

**Priority:** Medium
**Effort:** 1 week

#### 1.2.1 Design

Implement a **soft-delete with undo window** pattern for non-posted transactions:

- When a user deletes a draft invoice, bank rule, customer, supplier, or item → mark as `deleted_at = NOW()` instead of hard delete
- Show toast notification: "Deleted [Entity]. Undo?" with 30-second timer
- If user clicks Undo → clear `deleted_at` timestamp
- Background job purges records where `deleted_at < NOW() - INTERVAL '30 seconds'`
- All list queries add `WHERE deleted_at IS NULL`

#### 1.2.2 Database Migration — `268_soft_delete.sql`

```sql
-- Add soft-delete columns to entities that support undo
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE items ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE bank_rules ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE customer_invoices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial indexes for efficient queries (only non-deleted rows)
CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_suppliers_active ON suppliers(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_items_active ON items(company_id) WHERE deleted_at IS NULL;
```

#### 1.2.3 UI Pattern

```
User clicks "Delete" on draft invoice →
  1. API sets deleted_at = NOW(), returns { undoToken: uuid, expiresAt: timestamp }
  2. UI shows toast: "Invoice INV-042 deleted. [Undo]" with countdown
  3. User clicks Undo → API clears deleted_at WHERE id = X AND undo_token = Y
  4. Toast expires → record stays soft-deleted, background cleanup eventually hard-deletes
```

**Scope:** Only draft/unposted entities. Posted GL entries continue to use the reversal mechanism.

#### 1.2.4 Acceptance Criteria

- [ ] Deleting a draft entity soft-deletes it (sets deleted_at)
- [ ] Toast notification appears with 30-second undo window
- [ ] Clicking Undo restores the entity
- [ ] Soft-deleted entities are hidden from all list views
- [ ] Posted GL entries are NOT affected (still use reversal)
- [ ] Audit log captures both delete and undo actions

---

## WS-2: Security & Authentication (Q2 2026) — HIGH

### Feature 2.1: Two-Factor Authentication (2FA)

**Gap:** JWT token auth only. No 2FA. Critical for accounting software handling sensitive financial data.

**Priority:** High
**Effort:** 2 weeks

#### 2.1.1 Database Migration — `269_two_factor_auth.sql`

```sql
-- 2FA configuration per user
CREATE TABLE IF NOT EXISTS user_2fa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method VARCHAR(20) NOT NULL CHECK (method IN ('totp', 'sms')),
  secret_encrypted TEXT,
  phone_number VARCHAR(20),
  is_enabled BOOLEAN DEFAULT false,
  is_verified BOOLEAN DEFAULT false,
  backup_codes TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, method)
);

-- Trusted devices (skip 2FA for 30 days)
CREATE TABLE IF NOT EXISTS user_trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_fingerprint VARCHAR(255) NOT NULL,
  device_name VARCHAR(255),
  trusted_until TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, device_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_user_2fa_user ON user_2fa(user_id);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON user_trusted_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_expiry ON user_trusted_devices(trusted_until);
```

#### 2.1.2 TOTP Flow

**Setup (one-time):**
1. User navigates to My Account → Security → Enable 2FA
2. Backend generates TOTP secret (using `otpauth` or `speakeasy` npm package)
3. Frontend displays QR code (otpauth:// URI) for Google Authenticator / Authy
4. User enters 6-digit code from authenticator app
5. Backend verifies code, sets `is_verified = true`, generates 10 backup codes
6. Display backup codes once (user must save them)

**Login with 2FA:**
1. User submits email + password → normal auth
2. If user has 2FA enabled → return `{ requiresTwoFactor: true, tempToken: '...' }`
3. Frontend shows 2FA code input screen
4. User enters 6-digit TOTP code (or backup code)
5. Backend verifies → issue full JWT session token
6. Optional: "Trust this device for 30 days" checkbox → creates trusted device entry

**SMS Fallback:**
1. User clicks "Use SMS instead" on 2FA screen
2. Backend sends 6-digit code via SMS (using existing emailService pattern, adapt for SMS provider)
3. Code valid for 5 minutes, single-use

#### 2.1.3 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/2fa-setup` | Generate TOTP secret + QR code URI |
| POST | `/api/auth/2fa-verify-setup` | Verify initial TOTP code, enable 2FA |
| POST | `/api/auth/2fa-verify` | Verify TOTP/SMS code during login |
| POST | `/api/auth/2fa-disable` | Disable 2FA (requires current code) |
| POST | `/api/auth/2fa-backup-codes` | Regenerate backup codes |
| GET | `/api/auth/2fa-status` | Check if 2FA is enabled for current user |
| POST | `/api/auth/2fa-sms-send` | Send SMS verification code |

#### 2.1.4 Login Flow Changes

Modify `pages/api/auth/login.ts`:
```
1. Validate email + password (existing)
2. Check user_2fa table for enabled 2FA
3. If 2FA enabled:
   a. Check trusted_devices for valid device fingerprint
   b. If trusted → skip 2FA, issue full token
   c. If not trusted → return { requiresTwoFactor: true, tempToken }
4. If 2FA not enabled → issue full token (existing flow)
```

Modify `pages/login.tsx`:
```
1. Existing login form
2. If response.requiresTwoFactor → show 2FA input screen
3. 2FA screen: 6-digit code input, "Use SMS" link, "Use backup code" link
4. "Trust this device" checkbox
5. Submit → verify → redirect to accounting
```

#### 2.1.5 Enforcement Rules

- Owner and Admin roles: 2FA strongly recommended (banner until enabled)
- All roles: 2FA optional but encouraged
- Future: company setting to enforce 2FA for all users

#### 2.1.6 UI — My Account Security Tab

Add to `pages/accounting/my-account.tsx`:
- Security section with 2FA status
- "Enable Two-Factor Authentication" button → setup wizard
- "Manage Trusted Devices" → list with remove option
- "Regenerate Backup Codes" button
- "Disable 2FA" button (requires code confirmation)

#### 2.1.7 Dependencies

- `otpauth` npm package (TOTP generation/verification)
- `qrcode` npm package (QR code generation for authenticator setup)
- SMS provider integration (Clickatell, Africa's Talking, or Twilio)

#### 2.1.8 Acceptance Criteria

- [ ] User can enable TOTP-based 2FA via QR code setup
- [ ] Login requires 2FA code when enabled
- [ ] Backup codes work as alternative to TOTP
- [ ] SMS fallback sends code and verifies correctly
- [ ] "Trust this device" skips 2FA for 30 days
- [ ] Trusted devices can be viewed and revoked
- [ ] Disabling 2FA requires current code verification
- [ ] 2FA secrets are encrypted at rest
- [ ] Audit log captures 2FA enable/disable/login events
- [ ] Rate limiting: max 5 failed 2FA attempts per 15 minutes

---

## WS-3: Command Palette & Keyboard Shortcuts (Q2 2026) — HIGH

### Feature 3.1: Global Command Palette

**Gap:** No unified search. Module-specific search only. Accountants need instant access to any record.

**Priority:** High
**Effort:** 1.5 weeks

#### 3.1.1 Design

A `cmdk`-style command palette accessible via `Ctrl+K` (or `Cmd+K` on Mac) from anywhere in the application.

**Sections:**
1. **Recent Items** — Last 10 accessed entities (stored in localStorage)
2. **Quick Actions** — "New Invoice", "New Journal Entry", "New Customer", etc.
3. **Search Results** — Real-time fuzzy search across all entities

**Search Sources:**
- GL Accounts (code + name)
- Customers (name + account number)
- Suppliers (name + account number)
- Customer Invoices (number + customer name)
- Supplier Invoices (number + supplier name)
- Journal Entries (entry number + description)
- Bank Transactions (description + reference)
- Items (code + name)
- Pages/Navigation (all nav items by label)

#### 3.1.2 API Endpoint

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounting/global-search?q=term&limit=8` | Unified search across all entities |

**Response:**
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "type": "customer",
        "id": "uuid",
        "title": "Acme Corp",
        "subtitle": "ACC-001 | R 125,000.00 outstanding",
        "url": "/accounting/customers?id=uuid",
        "icon": "users"
      },
      {
        "type": "gl_account",
        "id": "uuid",
        "title": "1000 - Bank Account",
        "subtitle": "Asset | Bank",
        "url": "/accounting/chart-of-accounts?id=uuid",
        "icon": "book-open"
      }
    ],
    "actions": [
      { "label": "New Customer Invoice", "url": "/accounting/customer-invoices/new", "shortcut": "Ctrl+Shift+I" },
      { "label": "New Journal Entry", "url": "/accounting/journal-entries/new", "shortcut": "Ctrl+Shift+J" }
    ]
  }
}
```

**Service:** `globalSearchService.ts`
- Parallel queries across all entity tables using `Promise.all()`
- Fuzzy matching using existing `fuzzyMatcher.ts` utility
- Results ranked by relevance score
- Company-scoped (all queries filter by companyId)

#### 3.1.3 UI Component — `CommandPalette.tsx`

```
Location: src/components/layout/CommandPalette.tsx

Structure:
- Modal overlay (dark backdrop, centered dialog)
- Search input at top (auto-focused)
- Debounced search (300ms)
- Grouped results by entity type
- Keyboard navigation: Arrow Up/Down to select, Enter to navigate, Esc to close
- Recent items shown when input is empty
- Quick actions shown below recent items
- Loading spinner during search
- "No results" state with suggestions
```

**Integration:** Mount in `AppLayout.tsx`, listen for `Ctrl+K` keydown globally.

#### 3.1.4 Acceptance Criteria

- [ ] Ctrl+K opens command palette from any page
- [ ] Typing searches across all entity types with fuzzy matching
- [ ] Results grouped by type with icons
- [ ] Arrow keys navigate results, Enter opens selected result
- [ ] Esc closes palette
- [ ] Recent items shown when palette opens (before typing)
- [ ] Quick actions accessible (new invoice, new entry, etc.)
- [ ] Search debounced at 300ms
- [ ] Results return within 500ms
- [ ] Company-scoped (only shows current company's data)

---

### Feature 3.2: Keyboard Shortcuts System

**Gap:** No keyboard shortcuts for power users. Accountants navigate with keyboards.

**Priority:** High
**Effort:** 1 week

#### 3.2.1 Shortcut Registry

```
Location: src/lib/keyboard-shortcuts.ts

Global shortcuts (work from any page):
  Ctrl+K          → Open command palette
  ?               → Show shortcut help overlay
  G then D        → Go to Dashboard
  G then C        → Go to Customers
  G then S        → Go to Suppliers
  G then B        → Go to Banking
  G then A        → Go to Accounts
  G then R        → Go to Reports
  G then V        → Go to VAT

Page-level shortcuts (context-dependent):
  Ctrl+N          → New entity (invoice, entry, customer — per page)
  Ctrl+S          → Save current form
  Ctrl+Enter      → Post/submit current form
  Ctrl+E          → Export current view
  Ctrl+F          → Focus search/filter input
  Escape          → Close modal/panel, clear selection

Table shortcuts:
  J / Arrow Down  → Next row
  K / Arrow Up    → Previous row
  Enter           → Open selected row
  X               → Toggle row selection
  Ctrl+A          → Select all rows
```

#### 3.2.2 Implementation

**Hook:** `useKeyboardShortcuts(shortcuts: ShortcutConfig[])`
- Register/unregister shortcuts based on component lifecycle
- Support key sequences (G then D = "gd")
- Prevent conflicts with browser defaults
- Disable when focus is in text input/textarea (unless Ctrl/Cmd modifier)
- Store custom bindings in `user_preferences` table (future)

**Overlay component:** `ShortcutHelpOverlay.tsx`
- Triggered by `?` key
- Shows all available shortcuts grouped by category
- Indicates which shortcuts are active on current page

#### 3.2.3 Integration

Mount `useKeyboardShortcuts()` in `AppLayout.tsx` for global shortcuts. Individual pages register their own page-level shortcuts.

#### 3.2.4 Acceptance Criteria

- [ ] All global shortcuts work from any page
- [ ] `?` shows help overlay with all shortcuts
- [ ] Shortcuts disabled when typing in text fields
- [ ] Page-level shortcuts register/unregister on navigation
- [ ] Key sequences work (G then D within 1 second)
- [ ] No conflicts with browser defaults (Ctrl+C, Ctrl+V, etc.)

---

## WS-4: Permissions & Governance (Q3 2026) — HIGH

### Feature 4.1: Granular Module-Level Permissions

**Gap:** Basic 4-role system only. No module-level or document-level access restrictions.

**Priority:** High
**Effort:** 2 weeks

#### 4.1.1 Database Migration — `270_granular_permissions.sql`

```sql
-- Module permission definitions
CREATE TABLE IF NOT EXISTS permission_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key VARCHAR(50) NOT NULL UNIQUE,
  module_name VARCHAR(100) NOT NULL,
  description TEXT,
  display_order INT DEFAULT 100
);

-- Permission assignments per company_user
CREATE TABLE IF NOT EXISTS company_user_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_key VARCHAR(50) NOT NULL,
  can_read BOOLEAN DEFAULT false,
  can_write BOOLEAN DEFAULT false,
  can_delete BOOLEAN DEFAULT false,
  can_export BOOLEAN DEFAULT false,
  can_approve BOOLEAN DEFAULT false,
  account_range_from VARCHAR(20),
  account_range_to VARCHAR(20),
  restrictions JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, user_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_cup_company_user ON company_user_permissions(company_id, user_id);

-- Seed default modules
INSERT INTO permission_modules (module_key, module_name, display_order) VALUES
  ('dashboard', 'Dashboard', 10),
  ('customers', 'Customers & AR', 20),
  ('suppliers', 'Suppliers & AP', 30),
  ('items', 'Items & Inventory', 40),
  ('banking', 'Banking & Reconciliation', 50),
  ('accounts', 'Chart of Accounts & GL', 60),
  ('vat', 'VAT & Tax', 70),
  ('accountant', 'Accountant''s Area', 80),
  ('reports', 'Reports', 90),
  ('sars', 'SARS Compliance', 100),
  ('tools', 'Tools & Settings', 110),
  ('group', 'Group Consolidation', 120),
  ('payroll', 'Payroll', 130)
ON CONFLICT (module_key) DO NOTHING;
```

#### 4.1.2 Permission Resolution Logic

```
Priority order (highest wins):
1. Owner role → full access to everything (hardcoded)
2. Admin role → full access to everything (hardcoded)
3. company_user_permissions entries (if any exist for user)
4. Role-based defaults:
   - Manager → read/write/export all modules, approve on assigned modules
   - Viewer → read/export all modules, no write/delete/approve

Custom permissions override role defaults when present.
```

#### 4.1.3 Middleware Enhancement

Extend `withCompany.ts` to load permissions:
```typescript
// After resolving companyId and companyRole:
const permissions = await getCompanyUserPermissions(companyId, userId);
req.permissions = permissions; // Map<moduleKey, PermissionSet>
```

New helper: `withPermission(moduleKey, action)`
```typescript
// Usage in API:
export default withCompany(withPermission('banking', 'write')(withErrorHandler(handler)));
```

#### 4.1.4 UI — User Permission Editor

Enhance `pages/accounting/user-access.tsx`:
- Click user row → expand permission editor
- Module list with toggle switches: Read, Write, Delete, Export, Approve
- Account range restriction fields (from account code, to account code)
- "Reset to Role Defaults" button
- Changes save immediately via API

#### 4.1.5 Field Masking

For sensitive data, add `restrictions` JSONB support:
```json
{
  "mask_fields": ["bank_account_number", "bank_branch_code", "salary"],
  "hide_modules": ["payroll"]
}
```

Service layer checks restrictions before returning data, replaces masked fields with `"****"`.

#### 4.1.6 Acceptance Criteria

- [ ] Owner/Admin always have full access (cannot be restricted)
- [ ] Managers can be given custom per-module permissions
- [ ] Viewers limited to read/export by default
- [ ] Permission editor shows module grid with toggle switches
- [ ] Account range restrictions limit GL account visibility
- [ ] Field masking hides sensitive data for restricted users
- [ ] Navigation hides modules the user cannot access
- [ ] API endpoints enforce permissions (return 403 if unauthorized)
- [ ] Audit log captures permission changes

---

## WS-5: Performance & Caching (Q3 2026) — HIGH

### Feature 5.1: Server-Side Caching Layer

**Gap:** No Redis or server-side caching. Complex reports will slow down at scale.

**Priority:** High
**Effort:** 1.5 weeks

#### 5.1.1 Architecture

Use **in-memory LRU cache** (via `lru-cache` npm package) as the first tier. Redis can be added later if scale demands it. This avoids infrastructure complexity while delivering the performance win.

```
Location: src/lib/cache.ts

Cache tiers:
  Tier 1: LRU in-memory cache (per-process, 500MB max)
  Tier 2: Database (existing)
  Future Tier 3: Redis (when multi-instance deployment needed)
```

#### 5.1.2 Cache Strategy

| Data Type | TTL | Cache Key Pattern | Invalidation |
|-----------|-----|-------------------|--------------|
| GL Accounts list | 5 min | `gl-accounts:{companyId}` | On account create/update/delete |
| Customer list | 5 min | `customers:{companyId}` | On customer create/update/delete |
| Supplier list | 5 min | `suppliers:{companyId}` | On supplier create/update/delete |
| Item list | 5 min | `items:{companyId}` | On item create/update/delete |
| Report results | 2 min | `report:{type}:{companyId}:{hash(params)}` | On GL entry post/reverse |
| User permissions | 10 min | `perms:{companyId}:{userId}` | On permission change |
| Company settings | 15 min | `settings:{companyId}` | On settings update |

#### 5.1.3 Cache Invalidation Pattern

```typescript
// In services, after mutation:
import { cache } from '@/lib/cache';

// After creating a customer:
cache.invalidate(`customers:${companyId}`);

// After posting a journal entry (invalidates all reports):
cache.invalidatePattern(`report:*:${companyId}:*`);
```

#### 5.1.4 Materialized Views for Group Reports

```sql
-- 271_materialized_views.sql
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_consolidated_trial_balance AS
SELECT
  g.id AS group_id,
  gc.company_id,
  ga.account_code,
  ga.account_name,
  ga.account_type,
  COALESCE(SUM(jl.debit), 0) AS total_debit,
  COALESCE(SUM(jl.credit), 0) AS total_credit,
  COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS net_balance
FROM company_groups g
JOIN group_companies gc ON gc.group_id = g.id
JOIN gl_accounts ga ON ga.company_id = gc.company_id
LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
GROUP BY g.id, gc.company_id, ga.account_code, ga.account_name, ga.account_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_ctb ON mv_consolidated_trial_balance(group_id, company_id, account_code);

-- Refresh after each GL post (called from service layer):
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_consolidated_trial_balance;
```

#### 5.1.5 Acceptance Criteria

- [ ] Reference data (accounts, customers, suppliers, items) served from cache after first load
- [ ] Cache invalidated automatically on data mutation
- [ ] Report query times reduced by 50%+ on subsequent loads
- [ ] Materialized view for consolidated trial balance refreshes after GL posts
- [ ] Cache miss falls through to database transparently
- [ ] Memory usage stays within configured limits (500MB default)

---

## WS-6: UX Enhancements (Q3 2026) — MEDIUM

### Feature 6.1: Interactive Onboarding Tour

**Priority:** Medium | **Effort:** 1 week

- Use a lightweight tour library (e.g., `driver.js` or custom implementation)
- Trigger on first login to accounting module (check `user_preferences` key `onboarding_completed`)
- Tour steps: Dashboard overview → Navigation tabs → Creating first customer → Creating an invoice → Banking → Reports
- "Skip Tour" button at any step
- "Restart Tour" option in Help menu
- Contextual "?" tooltips on complex fields (VAT type, account subtype, cost centre) — stored as static content, rendered on hover

#### Acceptance Criteria
- [ ] Tour triggers on first accounting module visit
- [ ] Tour can be skipped and restarted
- [ ] "?" tooltips appear on hover for complex fields
- [ ] Tour completion stored in user_preferences

---

### Feature 6.2: Account Range Quick-Jump

**Priority:** Medium | **Effort:** 3 days

Enhance chart of accounts page:
- Add account category sidebar (Assets, Liabilities, Equity, Revenue, Expenses)
- Click category → scroll/filter to that range
- Search input supports code prefix filtering: typing "1" shows only 1xxx accounts, "41" shows 41xx
- Keyboard: type digits to jump to that account range

#### Acceptance Criteria
- [ ] Category sidebar shows account type groups with count
- [ ] Clicking category filters the list instantly
- [ ] Prefix typing filters accounts by code
- [ ] Quick-jump works with keyboard

---

### Feature 6.3: Excel Import Wizard

**Priority:** Medium | **Effort:** 1.5 weeks

Build a general-purpose Excel/CSV import wizard for GL transactions:

**Step 1 — Upload:** Drag-and-drop file upload (xlsx, csv). Parse file on client using `xlsx` npm package (already likely available).

**Step 2 — Column Mapping:** Show first 5 rows as preview. Dropdowns to map each source column to ISAFlow fields: Date, Account Code, Description, Reference, Debit, Credit, VAT Code, Cost Centre.

**Step 3 — Validation:** Validate all rows. Show error count, warning count, valid count. Red highlight on error rows (invalid account code, unbalanced entry, invalid date). Yellow for warnings (missing optional fields).

**Step 4 — Review & Import:** Summary: X entries will be created, Y lines total, Z total value. "Import as Draft" or "Import and Post" buttons.

**API:** `POST /api/accounting/gl-import` — accepts validated row data, creates journal entries.

**Template download:** `GET /api/accounting/gl-import-template` — returns Excel template with headers and sample data.

#### Acceptance Criteria
- [ ] Upload accepts .xlsx and .csv files
- [ ] Column mapping with preview of first 5 rows
- [ ] Validation highlights errors with row-level messages
- [ ] Account codes validated against chart of accounts
- [ ] Debit/credit balance validated per entry
- [ ] Template download with correct headers
- [ ] Import creates journal entries in draft or posted status
- [ ] Audit log captures import action with row count

---

### Feature 6.4: Debit/Credit Display Toggle

**Priority:** Medium | **Effort:** 3 days

Add user preference for transaction display mode:

- **Split mode** (default): Separate Debit and Credit columns
- **Net mode**: Single Amount column (positive = debit, negative = credit for expense accounts; reversed for revenue)

**Storage:** `user_preferences` key `display_mode` → value `split` | `net`

**API:** `GET/POST /api/auth/preferences` (existing endpoint, add key)

**UI:** Toggle switch in report header and in My Account → Preferences. Apply to: Journal entry list, Account transactions report, Bank transaction list, All export outputs.

#### Acceptance Criteria
- [ ] Toggle appears on transaction list pages and in preferences
- [ ] Split mode shows Debit | Credit columns
- [ ] Net mode shows single Amount column with sign
- [ ] Preference persists across sessions
- [ ] Export respects the user's display preference

---

### Feature 6.5: Description Templates & Auto-Suggest

**Priority:** Medium | **Effort:** 3 days

#### Database Migration — `272_description_templates.sql`

```sql
CREATE TABLE IF NOT EXISTS transaction_description_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  template TEXT NOT NULL,
  entity_type VARCHAR(50),
  usage_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_desc_templates_company ON transaction_description_templates(company_id);
```

**Features:**
- Pre-defined templates: "Payment received from {customer}", "Salary payment - {month} {year}", "Rent - {property} - {month}"
- Auto-suggest based on historical descriptions (top 10 matching descriptions from last 12 months)
- Dropdown appears when user types in description field (debounced 300ms)
- Templates manageable via Company Settings → Description Templates

**API:** `GET /api/accounting/description-suggest?q=term&entity_type=journal_entry`

#### Acceptance Criteria
- [ ] Description field shows auto-complete dropdown while typing
- [ ] Historical descriptions ranked by frequency
- [ ] Templates with variable placeholders
- [ ] Template management page in settings

---

### Feature 6.6: Duplicate Detection & Merge Wizard

**Priority:** Medium | **Effort:** 1 week

**Service:** `duplicateDetectionService.ts`

Detection rules:
- **Customers:** Same name (fuzzy, >85% match), same email, same VAT number
- **Suppliers:** Same name (fuzzy, >85% match), same email, same VAT number
- **Items:** Same code, same name (fuzzy, >90% match)

**API:**
- `GET /api/accounting/duplicates?entity_type=customer` — list detected duplicates with confidence scores
- `POST /api/accounting/duplicates-merge` — merge two entities (keep primary, reassign transactions from duplicate)

**Merge process:**
1. Show side-by-side comparison of duplicate records
2. User selects which field value to keep for each field
3. Confirm merge → reassign all invoices, payments, transactions from duplicate to primary
4. Soft-delete the duplicate (with undo support from WS-1)
5. Audit log captures merge with full detail

#### Acceptance Criteria
- [ ] Duplicate detection runs on demand with confidence scores
- [ ] Side-by-side comparison for manual review
- [ ] Merge reassigns all linked transactions
- [ ] Original duplicate soft-deleted (undoable)
- [ ] Audit log captures merge details

---

## WS-7: Reporting & Compliance (Q4 2026) — HIGH + MEDIUM

### Feature 7.1: Custom Report Builder

**Gap:** All reports are pre-built with fixed layouts. Users can't create custom reports.

**Priority:** High
**Effort:** 3 weeks

#### 7.1.1 Database Migration — `273_custom_reports.sql`

```sql
CREATE TABLE IF NOT EXISTS custom_report_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by VARCHAR(255) NOT NULL REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  data_source VARCHAR(50) NOT NULL CHECK (data_source IN (
    'gl_transactions', 'customer_invoices', 'supplier_invoices',
    'bank_transactions', 'items', 'customers', 'suppliers',
    'ar_aging', 'ap_aging', 'trial_balance', 'budget_vs_actual'
  )),
  columns JSONB NOT NULL DEFAULT '[]',
  filters JSONB NOT NULL DEFAULT '[]',
  sort_by JSONB DEFAULT '[]',
  group_by JSONB DEFAULT '[]',
  totals JSONB DEFAULT '{}',
  layout_options JSONB DEFAULT '{}',
  is_shared BOOLEAN DEFAULT false,
  schedule JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_reports_company ON custom_report_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_custom_reports_user ON custom_report_templates(created_by);
```

**`columns` JSONB structure:**
```json
[
  { "field": "entry_date", "label": "Date", "width": 100, "format": "date" },
  { "field": "account_code", "label": "Account", "width": 80 },
  { "field": "description", "label": "Description", "width": 200 },
  { "field": "debit", "label": "Debit", "width": 100, "format": "currency", "total": true },
  { "field": "credit", "label": "Credit", "width": 100, "format": "currency", "total": true }
]
```

**`filters` JSONB structure:**
```json
[
  { "field": "entry_date", "operator": "between", "value": ["2026-01-01", "2026-03-31"] },
  { "field": "account_type", "operator": "in", "value": ["revenue", "expense"] }
]
```

#### 7.1.2 UI — Report Builder Page

**Page:** `pages/accounting/reports/builder.tsx`

**Layout:**
1. **Left panel:** Data source selector, available fields list (drag source)
2. **Center panel:** Report preview (live-updating table with sample data)
3. **Right panel:** Column properties (label, width, format, sort, total)
4. **Top bar:** Report name, Save, Run, Export, Schedule buttons
5. **Filter bar:** Add filter conditions with field/operator/value

**Drag-and-drop:** Fields dragged from available list to column area. Reorder columns by dragging. Remove by dragging back or clicking X.

**Schedule:** Optional — run report weekly/monthly, email results as Excel to specified recipients.

#### 7.1.3 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounting/custom-reports` | List user's saved report templates |
| POST | `/api/accounting/custom-reports` | Save/update report template |
| DELETE | `/api/accounting/custom-reports?id=X` | Delete template |
| POST | `/api/accounting/custom-reports-run` | Execute report, return data |
| POST | `/api/accounting/custom-reports-export` | Execute and export as Excel/CSV/PDF |
| GET | `/api/accounting/custom-reports-fields?source=X` | Available fields for data source |

#### 7.1.4 Acceptance Criteria

- [ ] User can select data source and see available fields
- [ ] Drag-and-drop column ordering
- [ ] Filter builder with multiple conditions (AND logic)
- [ ] Group by with subtotals
- [ ] Column totals for numeric fields
- [ ] Report preview updates live
- [ ] Save/load report templates
- [ ] Export to Excel, CSV, PDF
- [ ] Share report template with company users
- [ ] Schedule reports for email delivery
- [ ] Standard report templates pre-seeded (top 5 common reports)

---

### Feature 7.2: IFRS Disclosure Note Generator

**Priority:** Medium
**Effort:** 1.5 weeks

#### 7.2.1 Design

Auto-generate standard IFRS disclosure notes from ISAFlow's financial data. Notes are generated as structured text that can be exported to Word/PDF for inclusion in annual financial statements.

**Disclosure notes to generate:**
1. **Accounting Policies** — Based on company settings (depreciation method, inventory valuation, revenue recognition)
2. **Property, Plant & Equipment** — From fixed assets register (cost, accumulated depreciation, carrying value, movements)
3. **Trade Receivables** — From AR aging (gross, provision for doubtful debts, net)
4. **Trade Payables** — From AP aging (current, 30/60/90+)
5. **Revenue** — From income statement by category
6. **Taxation** — VAT reconciliation, income tax provision
7. **Cash Flow Notes** — From cash flow statement components
8. **Related Party Transactions** — From intercompany transactions (group module)
9. **Subsequent Events** — Manual input (template with date, description, impact fields)
10. **Contingent Liabilities** — Manual input (template with description, estimated amount, probability)

#### 7.2.2 API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/accounting/disclosure-notes?year=2026` | Generate all applicable notes |
| GET | `/api/accounting/disclosure-notes-export?year=2026&format=docx` | Export as Word document |
| POST | `/api/accounting/disclosure-notes-manual` | Save manual note entries (subsequent events, contingencies) |

#### 7.2.3 Acceptance Criteria

- [ ] Auto-generates notes 1-8 from existing data
- [ ] Manual input forms for notes 9-10
- [ ] Preview all notes on screen
- [ ] Export as Word (.docx) and PDF
- [ ] Notes reference correct fiscal year data
- [ ] PPE note shows full movement schedule (opening, additions, disposals, depreciation, closing)
- [ ] AR/AP notes match aging reports

---

### Feature 7.3: CaseWare-Compatible Export

**Priority:** Medium
**Effort:** 1 week

#### 7.3.1 Design

Export trial balance and account mapping in formats compatible with CaseWare Working Papers and CaseWare Cloud.

**Export formats:**
1. **CaseWare CSV** — Trial balance with account code, name, debit, credit in CaseWare's expected column format
2. **XBRL Taxonomy Mapping** — Map ISAFlow account types to IFRS XBRL taxonomy elements (for CaseWare Cloud)

#### 7.3.2 Database Migration — `274_account_mapping.sql`

```sql
-- Configurable account mapping for external tools
CREATE TABLE IF NOT EXISTS account_external_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE CASCADE,
  target_system VARCHAR(50) NOT NULL CHECK (target_system IN ('caseware', 'xbrl', 'custom')),
  external_code VARCHAR(100) NOT NULL,
  external_label VARCHAR(200),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, gl_account_id, target_system)
);

CREATE INDEX IF NOT EXISTS idx_ext_mapping_company ON account_external_mapping(company_id);
```

#### 7.3.3 UI

- Account Mapping page (under Accountant's Area): Table with ISAFlow account | CaseWare code | XBRL element
- Auto-suggest CaseWare codes based on account type
- Export button with format selection (CaseWare CSV, XBRL)
- Mapping saved per company for reuse each year

#### 7.3.4 Acceptance Criteria

- [ ] Trial balance exports in CaseWare CSV format
- [ ] Account mapping configurable per company
- [ ] Mapping persists across periods (reusable)
- [ ] Export file imports into CaseWare without errors
- [ ] XBRL taxonomy mapping for IFRS elements

---

### Feature 7.4: Data Archiving & Retention Engine

**Priority:** High
**Effort:** 1.5 weeks

#### 7.4.1 Design

Archive old financial data to maintain database performance as companies grow.

**Rules:**
- Configurable retention period (default: 7 years, per SA Companies Act)
- Archive = move to `archive_*` tables (same schema, separate tables)
- Archived data still queryable via specific "Historical Data" page
- Company setting: `data_retention_years` (minimum 5, default 7)

#### 7.4.2 Database Migration — `275_data_archiving.sql`

```sql
-- Archive tables (mirror structure of active tables)
CREATE TABLE IF NOT EXISTS archive_gl_journal_entries (LIKE gl_journal_entries INCLUDING ALL);
CREATE TABLE IF NOT EXISTS archive_gl_journal_lines (LIKE gl_journal_lines INCLUDING ALL);
CREATE TABLE IF NOT EXISTS archive_bank_transactions (LIKE bank_transactions INCLUDING ALL);
CREATE TABLE IF NOT EXISTS archive_customer_invoices (LIKE customer_invoices INCLUDING ALL);
CREATE TABLE IF NOT EXISTS archive_supplier_invoices (LIKE supplier_invoices INCLUDING ALL);

-- Archival tracking
CREATE TABLE IF NOT EXISTS archive_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  run_by VARCHAR(255) NOT NULL REFERENCES users(id),
  cutoff_date DATE NOT NULL,
  entries_archived INT DEFAULT 0,
  lines_archived INT DEFAULT 0,
  transactions_archived INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### 7.4.3 Archive Process

1. Admin navigates to Tools → Data Archiving
2. System shows data volume by year (row counts, estimated size)
3. Admin selects cutoff date (e.g., "Archive everything before 2020-01-01")
4. System validates: cutoff must be > retention period ago, all periods must be closed/locked
5. Confirmation dialog with summary
6. Background job: INSERT INTO archive_* SELECT FROM * WHERE date < cutoff, then DELETE from active tables
7. Run within a transaction (rollback on any error)
8. Audit log captures archive action

#### 7.4.4 UI

**Page:** `pages/accounting/data-archiving.tsx` (under Tools tab)

- Storage dashboard: rows per table, estimated size, growth trend
- Archive wizard: select cutoff date, preview affected records, confirm
- Archive history: list of past runs with status
- "View Archived Data" link → filtered read-only view of archive tables

#### 7.4.5 Acceptance Criteria

- [ ] Archive moves data to archive_* tables
- [ ] Active table queries unaffected (no schema changes)
- [ ] Archived data viewable via dedicated page (read-only)
- [ ] Minimum retention period enforced (5 years)
- [ ] All periods must be locked before archiving
- [ ] Archive runs in background with progress tracking
- [ ] Rollback on any error (transactional)
- [ ] Audit log captures archive details
- [ ] Storage dashboard shows volume per table

---

## WS-8: Integration & Migration (Q4 2026 + Q1 2027) — MEDIUM + LOW

### Feature 8.1: CRM Webhook/API Integration Framework

**Priority:** Medium | **Effort:** 1.5 weeks

#### 8.1.1 Database Migration — `276_webhooks.sql`

```sql
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  url TEXT NOT NULL,
  secret VARCHAR(255),
  events TEXT[] NOT NULL,
  is_active BOOLEAN DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  failure_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  response_status INT,
  response_body TEXT,
  delivered_at TIMESTAMPTZ DEFAULT NOW(),
  success BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_webhooks_company ON webhook_endpoints(company_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
```

**Events:**
- `customer.created`, `customer.updated`
- `supplier.created`, `supplier.updated`
- `invoice.created`, `invoice.posted`, `invoice.paid`
- `payment.received`, `payment.made`

**Delivery:** Fire-and-forget HTTP POST with HMAC-SHA256 signature. Retry 3x with exponential backoff. Disable webhook after 10 consecutive failures.

**UI:** Company Settings → Webhooks → Add endpoint, select events, test delivery.

#### Acceptance Criteria
- [ ] Webhook endpoints configurable per company
- [ ] Events fire on entity mutations
- [ ] HMAC signature for verification
- [ ] Delivery log with status
- [ ] Auto-disable after repeated failures
- [ ] Test delivery button

---

### Feature 8.2: Additional Bank PDF Parsers

**Priority:** Low | **Effort:** 1 week per bank

Add bank statement PDF parsers for major SA banks:
- **FNB** — FNB statement format (table extraction)
- **Standard Bank** — Standard Bank statement format
- **Nedbank** — Nedbank statement format
- **Capitec** — Capitec statement format

Each parser follows the existing `bankPdfParser.ts` pattern:
- Parse PDF using `pdf-parse`
- Extract transactions: date, description, amount, balance
- Return `ParsedTransaction[]` array
- Auto-detect bank from PDF content/layout

**Service:** `bankPdfParserFactory.ts` — detects bank format and routes to correct parser.

#### Acceptance Criteria
- [ ] Each bank parser extracts transactions correctly
- [ ] Auto-detection identifies bank from PDF
- [ ] Fallback to generic parser if bank not recognized
- [ ] Test suite with sample PDF per bank

---

### Feature 8.3: Additional Migration Tools

**Priority:** Low | **Effort:** 1 week per tool

Extend the Sage migration pattern to support:
- **Xero** — Import via Xero API export (CSV-based)
- **QuickBooks** — Import via QBO IIF file format
- **Pastel** — Import via Pastel data export (CSV)

Each migration tool:
1. Upload exported file(s) from source system
2. Map source accounts to ISAFlow chart of accounts
3. Import: accounts, opening balances, customer/supplier master data, historical transactions
4. Balance verification report (source vs imported)

**Page:** `pages/accounting/migration/index.tsx` — source selection, then wizard per source.

#### Acceptance Criteria
- [ ] Each source has dedicated import wizard
- [ ] Account mapping with suggestions
- [ ] Opening balance import
- [ ] Master data import (customers, suppliers)
- [ ] Balance verification report after import
- [ ] Rollback capability (delete imported data)

---

### Feature 8.4: Recurring Transaction Templates

**Priority:** Low | **Effort:** 3 days

#### Database Migration — `277_recurring_transactions.sql`

```sql
CREATE TABLE IF NOT EXISTS recurring_transaction_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  entity_type VARCHAR(50) NOT NULL CHECK (entity_type IN (
    'journal_entry', 'customer_invoice', 'supplier_invoice'
  )),
  template_data JSONB NOT NULL,
  frequency VARCHAR(20) NOT NULL CHECK (frequency IN (
    'daily', 'weekly', 'monthly', 'quarterly', 'annually'
  )),
  next_run_date DATE,
  last_run_date DATE,
  is_active BOOLEAN DEFAULT true,
  auto_post BOOLEAN DEFAULT false,
  created_by VARCHAR(255) NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recurring_company ON recurring_transaction_templates(company_id);
CREATE INDEX IF NOT EXISTS idx_recurring_next_run ON recurring_transaction_templates(next_run_date) WHERE is_active = true;
```

**Features:**
- Create template from any existing transaction ("Save as Recurring")
- Manual or automatic execution
- Auto-post option for trusted recurring entries (e.g., monthly rent)
- Dashboard widget showing upcoming recurring transactions

#### Acceptance Criteria
- [ ] Create recurring template from existing transaction
- [ ] Manual "Run Now" button
- [ ] Frequency options: daily, weekly, monthly, quarterly, annually
- [ ] Auto-post option for trusted entries
- [ ] Next run date calculation
- [ ] Dashboard shows upcoming recurring items

---

## 4. Implementation Timeline

```
Q2 2026 (April - June)
├── Week 1-2:   WS-1.1 Audit Trail (CRITICAL)
├── Week 3-4:   WS-2.1 Two-Factor Authentication
├── Week 5-6:   WS-3.1 Command Palette
├── Week 6-7:   WS-3.2 Keyboard Shortcuts
└── Week 7-8:   WS-1.2 Undo Capability + buffer/testing

Q3 2026 (July - September)
├── Week 1-2:   WS-4.1 Granular Permissions
├── Week 3-4:   WS-5.1 Caching Layer + Materialized Views
├── Week 4-5:   WS-6.3 Excel Import Wizard
├── Week 5:     WS-6.1 Onboarding Tour
├── Week 6:     WS-6.2 Account Range Quick-Jump
├── Week 6:     WS-6.4 Debit/Credit Display Toggle
├── Week 7:     WS-6.5 Description Templates
├── Week 7-8:   WS-6.6 Duplicate Detection
└── Week 8:     Buffer/testing/polish

Q4 2026 (October - December)
├── Week 1-3:   WS-7.1 Custom Report Builder
├── Week 4-5:   WS-7.2 IFRS Disclosure Notes
├── Week 5-6:   WS-7.3 CaseWare Export
├── Week 7-8:   WS-7.4 Data Archiving Engine
├── Week 9-10:  WS-8.1 Webhook Framework
└── Week 10-11: WS-8.4 Recurring Transactions

Q1 2027 (January - March)
├── Week 1-4:   WS-8.2 Bank PDF Parsers (FNB, StdBank, Nedbank, Capitec)
├── Week 5-8:   WS-8.3 Migration Tools (Xero, QuickBooks, Pastel)
└── Week 9-10:  Final integration testing + polish
```

---

## 5. Migration Sequence

All migrations must run in order. Reserved numbers:

| Number | Migration | Workstream |
|--------|-----------|-----------|
| 267 | `audit_trail.sql` | WS-1.1 |
| 268 | `soft_delete.sql` | WS-1.2 |
| 269 | `two_factor_auth.sql` | WS-2.1 |
| 270 | `granular_permissions.sql` | WS-4.1 |
| 271 | `materialized_views.sql` | WS-5.1 |
| 272 | `description_templates.sql` | WS-6.5 |
| 273 | `custom_reports.sql` | WS-7.1 |
| 274 | `account_mapping.sql` | WS-7.3 |
| 275 | `data_archiving.sql` | WS-7.4 |
| 276 | `webhooks.sql` | WS-8.1 |
| 277 | `recurring_transactions.sql` | WS-8.4 |

---

## 6. Dependencies (npm packages)

| Package | Purpose | Workstream |
|---------|---------|-----------|
| `otpauth` | TOTP generation/verification | WS-2.1 |
| `qrcode` | QR code for 2FA setup | WS-2.1 |
| `lru-cache` | In-memory caching | WS-5.1 |
| `driver.js` | Onboarding tour (optional) | WS-6.1 |
| `docx` | Word document generation for IFRS notes | WS-7.2 |

---

## 7. Testing Strategy

Each feature requires:

1. **Unit tests** — Service functions with mocked database (Vitest)
2. **API tests** — Endpoint request/response validation
3. **E2E tests** — Critical user flows (Playwright)
4. **Manual QA** — Accountant walkthrough for UX validation

**Critical path E2E tests:**
- Audit trail: create invoice → update → post → verify audit log shows all changes
- 2FA: enable → login with code → trusted device → disable
- Command palette: open → search → navigate → verify correct page
- Custom reports: create template → run → export → verify data
- Permissions: set viewer permissions → verify restricted access

---

## 8. Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| Gap Analysis Coverage | 69% | 100% | All 22 action items delivered |
| Audit Trail Completeness | 0% | 100% | Every financial mutation logged |
| Report Query Time (p95) | ~2s | <500ms | With caching layer |
| Search-to-Result Time | N/A | <500ms | Command palette response |
| 2FA Adoption | 0% | >80% for admin/owner | User settings audit |
| User Satisfaction (Mr Marneweck) | Feedback pending | Approval on all points | Demo walkthrough |

---

## 9. Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|------------|------------|
| Audit trail performance overhead | Slower write operations | Medium | Fire-and-forget logging, async inserts, batch writes |
| 2FA SMS delivery reliability | Users locked out | Low | Backup codes, TOTP primary, trusted devices |
| Custom report builder complexity | Long dev time | Medium | Start with 3 data sources, expand iteratively |
| Cache invalidation bugs | Stale data shown | Medium | Conservative TTLs, manual cache clear in admin |
| Migration data loss | Imported data incorrect | Low | Dry-run mode, balance verification, rollback |

---

*This PRD addresses every point from the Gap Analysis Report. Implementation follows ISAFlow's established patterns and conventions. Each feature is designed to be independently deployable — no feature blocks another.*
