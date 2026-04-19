# PRD-02 Payroll Phase 3 — Run Finalisation: Lifecycle, GL Posting, Payslips, SDL Rollup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop on monthly payroll — a run moves through draft → calculated → approved → paid, GL journal entries are auto-created on approval, employees get downloadable PDF payslips, and SDL uses a real rolling-12-month annual payroll rollup (replacing the Phase 1 hardcoded estimate).

**Architecture:** Extend the Phase 1/2 `payroll_run_headers` table with lifecycle + GL-link columns. Add a `payroll_gl_accounts` config table (7 role → GL account mappings per company). A thin `payrollLifecycleService` handles state transitions and delegates GL posting to a `payrollGlPostingService` that builds journal lines from `payroll_run_headers` totals and calls the existing `createJournalEntry` + `postJournalEntry` services (same pattern as invoices). Payslip PDFs are generated per employee via `pdfkit` (already in package.json). SDL annual-estimate is derived by summing the prior 11 months + current-month gross from `payroll_run_headers`.

**Tech Stack:** Next.js 14 pages router, TypeScript strict, Neon Postgres (`sql` tagged template + `withTransaction`), Vitest, Playwright, `pdfkit`, `lucide-react`, Tailwind. Package manager: bun.

---

## Pre-flight — state of the world at the start of Phase 3

**Phase 1 + Phase 2 shipped (merged):**
- Engine: `src/modules/accounting/services/payroll/{payeEngine,uifEngine,sdlEngine,etiEngine,validationEngine,payrollCalculator}.ts`
- Data-aware: `payrollEmployeeService.ts`, `payrollComponentService.ts`, `payrollEmployeeComponentService.ts`, `payrollRunService.ts`
- API: `pages/api/payroll/{employees,components,runs}/*`
- UI: `pages/payroll/{employees,components,runs}/*` + `src/components/payroll/Employee{Profile,Components}Card.tsx`
- Tests: 769/769 green
- Legacy payroll module fully removed; migration 384 dropped legacy tables

**What Phase 3 adds:**
- Migrations 385 + 386
- 4 new services, 4 new/modified API routes, 2 new UI pages (settings + payslip), extended run detail UI

**What Phase 3 does NOT build:** Leave management (Phase 4), EMP201 UI wiring + IRP5 certs + EMP501 reconciliation (Phase 5), audit log + bulk imports (Phase 6).

**Status CHECK** on `payroll_run_headers.status` is `('draft','calculated','approved','paid','cancelled')` — Phase 2 UI used `'posted'` for the emerald badge which never matches. **Task 10 fixes this** to use `'paid'`.

---

## Critical conventions (read before starting)

- **Package manager:** `bun`. Tests: `bunx vitest run <path>`. Dev: `bun run dev`. Type check: `bunx tsc --noEmit`.
- **DB:** `sql` tagged template from `@/lib/neon`. Use `withTransaction` from `@/lib/neon` when multiple writes must succeed together — existing pattern in `src/modules/accounting/services/gl/journalEntryPostingService.ts`.
- **Multi-tenant:** every query company-scoped via `${companyId}::uuid`. Guard every mutating operation by verifying the target row's `company_id` first, or scope it in the WHERE.
- **GL posting:** reuse `createJournalEntry` + `postJournalEntry` from `@/modules/accounting/services/gl/journalEntryCrudService` and `journalEntryPostingService`. Do not hand-roll INSERT INTO gl_journal_entries.
- **API handlers:** `withAuth(withErrorHandler(withCsrf(handler)))`. Imports exactly like Phase 2 tasks.
- **Logging:** `log.info/warn/error` from `@/lib/logger`. Never `console.log`.
- **File size:** max 300 lines. Split into `src/components/payroll/` sub-components if a page grows.
- **Commits:** conventional prefix — `feat(payroll):`, `feat(db):`, `fix(payroll):`, `test(payroll):`, `refactor(payroll):`, `chore(payroll):`. Always explicit `git add <paths>` — never `git add -A` (keeps the `$HOME/` artefact out).
- **Dev server assumption:** tests that hit DB run against the local Neon-compat DB. Migrations should apply via `bun run scripts/apply-migrations.ts` — if that script errors on pre-existing migration 360, apply 385 + 386 manually via psql and record in `schema_migrations` (pattern established in Phase 2 Task 4).

---

## File Map

### Files to create

| Path | Purpose |
|------|---------|
| `scripts/migrations/sql/385_payroll_run_lifecycle.sql` | Add `approved_by`, `approved_at`, `paid_at`, `posted_journal_entry_id`, `cancelled_by`, `cancelled_at` columns to `payroll_run_headers`. |
| `scripts/migrations/sql/386_payroll_gl_accounts.sql` | Create `payroll_gl_accounts` table for the 7 account mappings. |
| `src/modules/accounting/services/payroll/payrollGlConfigService.ts` | Get/upsert the company's GL account mappings. |
| `src/modules/accounting/services/payroll/payrollGlPostingService.ts` | Build `JournalLineInput[]` from run totals; call `createJournalEntry` + `postJournalEntry`. |
| `src/modules/accounting/services/payroll/payrollLifecycleService.ts` | `approvePayrollRun`, `markPaid`, `cancelPayrollRun` state transitions. |
| `src/modules/accounting/services/payroll/payrollRollupService.ts` | Rolling-12-month annual gross from `payroll_run_headers` for SDL. |
| `src/modules/accounting/services/payroll/payslipPdfService.ts` | Generate a one-page payslip PDF per employee via `pdfkit`. |
| `pages/api/payroll/settings/gl-accounts.ts` | GET/PUT the company's 7 account mappings. |
| `pages/api/payroll/runs/[id]/approve.ts` | POST — transitions draft/calculated → approved + posts GL. |
| `pages/api/payroll/runs/[id]/pay.ts` | POST — transitions approved → paid. |
| `pages/api/payroll/runs/[id]/cancel.ts` | POST — transitions any non-paid status → cancelled + reverses GL if approved. |
| `pages/api/payroll/runs/[id]/payslip/[employeeId].ts` | GET `.pdf`; streams PDF bytes. |
| `pages/payroll/settings/index.tsx` | Settings page: map the 7 roles to GL accounts. |
| `src/components/payroll/PayrollRunActions.tsx` | Split out of `[id].tsx` — Calculate/Approve/Pay/Cancel buttons. |
| `src/components/payroll/PayrollRunLinesTable.tsx` | Split out of `[id].tsx` — the lines table + payslip-download link per row. |
| `tests/unit/services/payroll/payrollGlConfigService.test.ts` | Service tests. |
| `tests/unit/services/payroll/payrollGlPostingService.test.ts` | Journal-line assembly + double-entry balance. |
| `tests/unit/services/payroll/payrollLifecycleService.test.ts` | Transition rules. |
| `tests/unit/services/payroll/payrollRollupService.test.ts` | Rolling-12-month math. |
| `tests/e2e/payroll-phase3-smoke.spec.ts` | Approve → JE exists → payslip downloads. |

### Files to modify

| Path | Change |
|------|--------|
| `src/modules/accounting/services/payroll/payrollRunService.ts` | Replace hardcoded `annualPayrollEstimate` in `calculatePayrollRun` with `payrollRollupService.getAnnualPayrollEstimate(companyId, period)`. |
| `pages/payroll/runs/[id].tsx` | Integrate Approve/Pay/Cancel actions + per-row payslip download. Likely still big enough to justify extracting `PayrollRunActions` and `PayrollRunLinesTable`. |
| `src/components/accounting/navSections/payroll.ts` | Add "Settings" item under a new Configuration section. |

### GL mapping roles (keys in `payroll_gl_accounts`)

Each company maps these 7 role names to their own `gl_accounts.id`:

| Role key | Typical account |
|---|---|
| `salaries_expense` | Salaries & Wages (expense) |
| `net_salaries_payable` | Net Salaries Payable (liability) |
| `paye_payable` | PAYE Payable (liability) |
| `uif_payable` | UIF Payable (liability) |
| `sdl_payable` | SDL Payable (liability) |
| `uif_employer_expense` | UIF Employer Contributions (expense) |
| `sdl_employer_expense` | SDL Contributions (expense) |

### Journal entry assembled by `payrollGlPostingService`

Per payroll run totals (R = `roundCents`):

| Line | Dr | Cr |
|---|---|---|
| Salaries expense | `total_gross` | |
| UIF employer expense | `uif_employer_portion` | |
| SDL expense | `total_sdl` | |
| PAYE payable | | `total_paye` |
| UIF payable (combined employee + employer) | | `total_uif` |
| SDL payable | | `total_sdl` |
| Net salaries payable | | `total_net` |

Balance check: Dr total `= gross + uif_employer + sdl`, Cr total `= paye + uif + sdl + net`. Since `net = gross - paye - uif_employee`, Cr `= paye + uif_employee + uif_employer + sdl + gross - paye - uif_employee = gross + uif_employer + sdl`. ✓ Balanced.

---

## Task 1: Migration 385 — run lifecycle columns

**Files:**
- Create: `scripts/migrations/sql/385_payroll_run_lifecycle.sql`

- [ ] **Step 1: Write migration**

```sql
-- 385_payroll_run_lifecycle.sql
-- PRD-02 Phase 3: add lifecycle audit columns to payroll_run_headers so we
-- know WHO approved/paid/cancelled WHEN, and which GL journal entry was
-- posted on approval.

ALTER TABLE payroll_run_headers
  ADD COLUMN IF NOT EXISTS approved_by                UUID,
  ADD COLUMN IF NOT EXISTS approved_at                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS paid_at                    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by               UUID,
  ADD COLUMN IF NOT EXISTS cancelled_at               TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS posted_journal_entry_id    UUID;

-- FK to gl_journal_entries (if the table exists — it always should by Phase 3)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'gl_journal_entries')
     AND NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                     WHERE table_name = 'payroll_run_headers'
                       AND constraint_name = 'payroll_run_headers_posted_je_fkey')
  THEN
    ALTER TABLE payroll_run_headers
      ADD CONSTRAINT payroll_run_headers_posted_je_fkey
      FOREIGN KEY (posted_journal_entry_id)
      REFERENCES gl_journal_entries(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payroll_run_headers_posted_je
  ON payroll_run_headers (posted_journal_entry_id)
  WHERE posted_journal_entry_id IS NOT NULL;
```

- [ ] **Step 2: Apply**

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/prd-02-payroll
bun run scripts/apply-migrations.ts 2>&1 | tail -10
```

If the runner hits the pre-existing migration 360 error, apply manually:
```bash
psql "$DATABASE_URL" -f scripts/migrations/sql/385_payroll_run_lifecycle.sql
# Then record it, using the same SHA-256 checksum approach as Phase 2 Task 4.
```

- [ ] **Step 3: Verify columns exist**

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name='payroll_run_headers'
  AND column_name IN ('approved_by','approved_at','paid_at','cancelled_by','cancelled_at','posted_journal_entry_id');
```
Expected: 6 rows.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/sql/385_payroll_run_lifecycle.sql
git commit -m "feat(db): migration 385 — payroll run lifecycle columns

Adds approved_by/approved_at, paid_at, cancelled_by/cancelled_at, and
posted_journal_entry_id (FK to gl_journal_entries) on payroll_run_headers.
Prerequisite for Phase 3 run-finalisation flow.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Migration 386 — GL account mappings table

**Files:**
- Create: `scripts/migrations/sql/386_payroll_gl_accounts.sql`

- [ ] **Step 1: Write migration**

```sql
-- 386_payroll_gl_accounts.sql
-- PRD-02 Phase 3: per-company mapping of payroll roles → GL accounts.
-- 7 rows per company once configured. The role key is a plain TEXT enum.

CREATE TABLE IF NOT EXISTS payroll_gl_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN (
    'salaries_expense',
    'net_salaries_payable',
    'paye_payable',
    'uif_payable',
    'sdl_payable',
    'uif_employer_expense',
    'sdl_employer_expense'
  )),
  gl_account_id UUID NOT NULL REFERENCES gl_accounts(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, role)
);

CREATE INDEX IF NOT EXISTS idx_payroll_gl_accounts_company
  ON payroll_gl_accounts (company_id);
```

- [ ] **Step 2: Apply + verify** (same pattern as Task 1)

- [ ] **Step 3: Commit**

```bash
git add scripts/migrations/sql/386_payroll_gl_accounts.sql
git commit -m "feat(db): migration 386 — payroll_gl_accounts

Per-company mapping of 7 payroll roles to GL accounts. Unique per
(company, role). Required before approvePayrollRun can post to GL.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: GL config service + API (TDD)

**Files:**
- Create: `src/modules/accounting/services/payroll/payrollGlConfigService.ts`
- Create: `pages/api/payroll/settings/gl-accounts.ts`
- Create: `tests/unit/services/payroll/payrollGlConfigService.test.ts`

### Service contract

```ts
export type PayrollGlRole =
  | 'salaries_expense'
  | 'net_salaries_payable'
  | 'paye_payable'
  | 'uif_payable'
  | 'sdl_payable'
  | 'uif_employer_expense'
  | 'sdl_employer_expense';

export const PAYROLL_GL_ROLES: readonly PayrollGlRole[] = [
  'salaries_expense', 'net_salaries_payable', 'paye_payable',
  'uif_payable', 'sdl_payable', 'uif_employer_expense', 'sdl_employer_expense',
];

export interface PayrollGlMapping {
  role: PayrollGlRole;
  glAccountId: string;
}

// Returns current mappings (0–7 rows; fewer if not fully configured)
export async function getPayrollGlMappings(companyId: string): Promise<PayrollGlMapping[]>;

// Upsert-all: pass the full set, missing roles leave unchanged. Empty glAccountId for a role deletes that mapping.
export async function upsertPayrollGlMappings(
  companyId: string,
  mappings: PayrollGlMapping[],
): Promise<PayrollGlMapping[]>;

// Convenience: returns Record<role, glAccountId> or throws if any of the 7 roles is missing — called by postToGL.
export async function getCompletePayrollGlMappings(
  companyId: string,
): Promise<Record<PayrollGlRole, string>>;
```

### TDD

- [ ] **Step 1: Write failing tests** at `tests/unit/services/payroll/payrollGlConfigService.test.ts` covering:
  1. `getPayrollGlMappings` returns `[]` when no rows exist
  2. `upsertPayrollGlMappings` inserts new rows and returns them
  3. `upsertPayrollGlMappings` updates existing rows on UNIQUE(company, role) conflict (ON CONFLICT DO UPDATE SET gl_account_id=EXCLUDED.gl_account_id, updated_at=NOW())
  4. `upsertPayrollGlMappings` deletes a mapping when `glAccountId === ''`
  5. `getCompletePayrollGlMappings` throws if fewer than 7 roles configured
  6. All queries include `company_id = ${companyId}::uuid`

Use the mutable-mock pattern from Phase 2 Task 7.

- [ ] **Step 2: Run — FAIL**

```bash
bunx vitest run tests/unit/services/payroll/payrollGlConfigService.test.ts
```

- [ ] **Step 3: Write the service** (~120 lines):

```ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export type PayrollGlRole =
  | 'salaries_expense'
  | 'net_salaries_payable'
  | 'paye_payable'
  | 'uif_payable'
  | 'sdl_payable'
  | 'uif_employer_expense'
  | 'sdl_employer_expense';

export const PAYROLL_GL_ROLES: readonly PayrollGlRole[] = [
  'salaries_expense', 'net_salaries_payable', 'paye_payable',
  'uif_payable', 'sdl_payable', 'uif_employer_expense', 'sdl_employer_expense',
];

export interface PayrollGlMapping {
  role: PayrollGlRole;
  glAccountId: string;
}

export async function getPayrollGlMappings(companyId: string): Promise<PayrollGlMapping[]> {
  const rows = (await sql`
    SELECT role, gl_account_id FROM payroll_gl_accounts
    WHERE company_id = ${companyId}::uuid
    ORDER BY role
  `) as Row[];
  return rows.map(r => ({
    role: String(r.role) as PayrollGlRole,
    glAccountId: String(r.gl_account_id),
  }));
}

export async function upsertPayrollGlMappings(
  companyId: string,
  mappings: PayrollGlMapping[],
): Promise<PayrollGlMapping[]> {
  log.info('Upserting payroll GL mappings', { companyId, count: mappings.length }, 'payrollGlConfigService');
  for (const m of mappings) {
    if (!PAYROLL_GL_ROLES.includes(m.role)) {
      throw new Error(`Unknown payroll GL role: ${m.role}`);
    }
    if (m.glAccountId === '') {
      await sql`
        DELETE FROM payroll_gl_accounts
        WHERE company_id = ${companyId}::uuid AND role = ${m.role}
      `;
    } else {
      await sql`
        INSERT INTO payroll_gl_accounts (company_id, role, gl_account_id)
        VALUES (${companyId}::uuid, ${m.role}, ${m.glAccountId}::uuid)
        ON CONFLICT (company_id, role) DO UPDATE
        SET gl_account_id = EXCLUDED.gl_account_id, updated_at = NOW()
      `;
    }
  }
  return getPayrollGlMappings(companyId);
}

export async function getCompletePayrollGlMappings(
  companyId: string,
): Promise<Record<PayrollGlRole, string>> {
  const rows = await getPayrollGlMappings(companyId);
  const map: Partial<Record<PayrollGlRole, string>> = {};
  for (const r of rows) map[r.role] = r.glAccountId;
  const missing = PAYROLL_GL_ROLES.filter(role => !map[role]);
  if (missing.length > 0) {
    throw new Error(
      `Payroll GL mapping incomplete — missing: ${missing.join(', ')}. Configure at /payroll/settings.`,
    );
  }
  return map as Record<PayrollGlRole, string>;
}
```

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Write API route** `pages/api/payroll/settings/gl-accounts.ts`:

```ts
/**
 * Payroll GL account mappings.
 * GET  /api/payroll/settings/gl-accounts — list current mappings
 * PUT  /api/payroll/settings/gl-accounts — replace all mappings (body: { mappings: PayrollGlMapping[] })
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import {
  withAuth,
  type AuthenticatedNextApiRequest,
  type CompanyAuthedRequest,
} from '@/lib/auth';
import {
  getPayrollGlMappings,
  upsertPayrollGlMappings,
  type PayrollGlMapping,
} from '@/modules/accounting/services/payroll/payrollGlConfigService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const list = await getPayrollGlMappings(companyId);
    return apiResponse.success(res, list);
  }
  if (req.method === 'PUT') {
    const { mappings } = req.body as { mappings?: PayrollGlMapping[] };
    if (!Array.isArray(mappings)) return apiResponse.badRequest(res, 'mappings must be an array');
    const updated = await upsertPayrollGlMappings(companyId, mappings);
    return apiResponse.success(res, updated);
  }
  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
```

- [ ] **Step 6: tsc + vitest** — all green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/accounting/services/payroll/payrollGlConfigService.ts \
        pages/api/payroll/settings/gl-accounts.ts \
        tests/unit/services/payroll/payrollGlConfigService.test.ts
git commit -m "feat(payroll): GL account mapping config service + API

Per-company mapping of 7 payroll roles (salaries expense, net salaries
payable, paye payable, uif payable, sdl payable, uif employer expense,
sdl employer expense) to gl_accounts.id. UI in Task 4.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Payroll settings page (UI)

**Files:**
- Create: `pages/payroll/settings/index.tsx`

The page lists all 7 roles with a `<select>` populated from `GET /api/accounting/gl-accounts` (existing endpoint; returns `{ id, code, name, account_type }`). On save, PUTs the full mapping set.

### Steps

- [ ] **Step 1: Verify the existing GL accounts endpoint**

```bash
grep -rn "api/accounting/gl-accounts\|api/accounting/chart-of-accounts" pages/api/accounting/ | head -3
```
Identify the correct endpoint path. The most common is `pages/api/accounting/gl-accounts.ts` or `chart-of-accounts.ts`. Record which you'll use.

- [ ] **Step 2: Create the page** (~180 lines, under the 300 cap):

```tsx
/**
 * Payroll Settings — GL account mappings.
 * Route: /payroll/settings
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Settings, Loader2, Save, AlertCircle, ArrowLeft } from 'lucide-react';
import {
  PAYROLL_GL_ROLES,
  type PayrollGlRole,
  type PayrollGlMapping,
} from '@/modules/accounting/services/payroll/payrollGlConfigService';

interface GlAccount { id: string; code: string; name: string; account_type: string }

const ROLE_LABELS: Record<PayrollGlRole, string> = {
  salaries_expense:      'Salaries & Wages (expense)',
  net_salaries_payable:  'Net Salaries Payable (liability)',
  paye_payable:          'PAYE Payable (liability)',
  uif_payable:           'UIF Payable (liability)',
  sdl_payable:           'SDL Payable (liability)',
  uif_employer_expense:  'UIF Employer Contributions (expense)',
  sdl_employer_expense:  'SDL Contributions (expense)',
};

export default function PayrollSettingsPage() {
  const [accounts, setAccounts] = useState<GlAccount[]>([]);
  const [mappings, setMappings] = useState<Record<PayrollGlRole, string>>(() =>
    Object.fromEntries(PAYROLL_GL_ROLES.map(r => [r, ''])) as Record<PayrollGlRole, string>,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true); setError('');
    try {
      // NOTE: substitute the endpoint identified in Step 1 if different
      const [aRes, mRes] = await Promise.all([
        apiFetch('/api/accounting/gl-accounts'),
        apiFetch('/api/payroll/settings/gl-accounts'),
      ]);
      if (!aRes.ok) throw new Error(`Accounts HTTP ${aRes.status}`);
      const aJson = await aRes.json();
      setAccounts((aJson.data ?? aJson) as GlAccount[]);

      if (mRes.ok) {
        const mJson = await mRes.json();
        const existing = ((mJson.data ?? mJson) as PayrollGlMapping[]);
        setMappings(prev => ({
          ...prev,
          ...Object.fromEntries(existing.map(m => [m.role, m.glAccountId])),
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally { setIsLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true); setError(''); setMessage('');
    try {
      const payload: PayrollGlMapping[] = PAYROLL_GL_ROLES.map(role => ({
        role, glAccountId: mappings[role] ?? '',
      }));
      const res = await apiFetch('/api/payroll/settings/gl-accounts', {
        method: 'PUT', body: JSON.stringify({ mappings: payload }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMessage('Saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally { setSaving(false); }
  };

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10"><Settings className="h-6 w-6 text-teal-500" /></div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Settings</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">GL account mappings used when a run is approved</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl space-y-4">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}
          {message && (
            <div className="px-4 py-2 rounded-lg bg-teal-500/10 border border-teal-500/30 text-teal-400 text-sm">{message}</div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-500" /></div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-3">
              {PAYROLL_GL_ROLES.map(role => (
                <div key={role} className="grid grid-cols-[1fr_2fr] gap-4 items-center">
                  <label className="text-sm text-[var(--ff-text-secondary)]">{ROLE_LABELS[role]}</label>
                  <select className={field}
                    value={mappings[role] ?? ''}
                    onChange={e => setMappings(prev => ({ ...prev, [role]: e.target.value }))}>
                    <option value="">— none —</option>
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                    ))}
                  </select>
                </div>
              ))}
              <button onClick={save} disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save mappings
              </button>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 3: tsc** clean.

- [ ] **Step 4: Commit**

```bash
git add pages/payroll/settings/index.tsx
git commit -m "feat(payroll): GL account mapping settings page

/payroll/settings lets users pick which gl_accounts to use for the 7
payroll roles. PUTs the full mapping set on save.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: GL posting service (TDD)

**Files:**
- Create: `src/modules/accounting/services/payroll/payrollGlPostingService.ts`
- Create: `tests/unit/services/payroll/payrollGlPostingService.test.ts`

### Contract

```ts
export interface PayrollJournalLine {
  glAccountId: string;
  debit: number;
  credit: number;
  description: string;
}

// Pure function (no DB): returns the 7-row journal, balanced.
export function buildPayrollJournalLines(
  totals: {
    totalGross: number;
    totalPaye: number;
    totalUif: number;           // combined employee + employer
    totalUifEmployee: number;
    totalUifEmployer: number;
    totalSdl: number;
    totalNet: number;
  },
  map: Record<PayrollGlRole, string>,
  memo: string,                  // e.g. "Payroll run Mar 2025"
): PayrollJournalLine[];

// Posts: creates draft journal via createJournalEntry, then calls postJournalEntry.
// Returns the new journal entry id. Company-scoped; user id used for audit.
export async function postPayrollRunToGL(
  companyId: string,
  userId: string,
  runId: string,
): Promise<string>;
```

### TDD for `buildPayrollJournalLines`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { buildPayrollJournalLines } from '@/modules/accounting/services/payroll/payrollGlPostingService';
import { PAYROLL_GL_ROLES } from '@/modules/accounting/services/payroll/payrollGlConfigService';

const MAP = Object.fromEntries(
  PAYROLL_GL_ROLES.map((r, i) => [r, `gl-${i}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`]),
) as Record<typeof PAYROLL_GL_ROLES[number], string>;

describe('buildPayrollJournalLines', () => {
  it('produces 7 lines that balance', () => {
    const lines = buildPayrollJournalLines(
      { totalGross: 100000, totalPaye: 15000, totalUif: 2000,
        totalUifEmployee: 1000, totalUifEmployer: 1000,
        totalSdl: 1000, totalNet: 84000 },
      MAP,
      'Payroll run Mar 2025',
    );
    expect(lines).toHaveLength(7);
    const drSum = lines.reduce((s, l) => s + l.debit, 0);
    const crSum = lines.reduce((s, l) => s + l.credit, 0);
    expect(drSum).toBeCloseTo(crSum, 2);
    expect(drSum).toBeCloseTo(102000, 2); // gross + uif_er + sdl
  });

  it('each line debits XOR credits', () => {
    const lines = buildPayrollJournalLines(
      { totalGross: 100000, totalPaye: 15000, totalUif: 2000,
        totalUifEmployee: 1000, totalUifEmployer: 1000,
        totalSdl: 1000, totalNet: 84000 },
      MAP, 'Memo',
    );
    for (const l of lines) {
      expect(l.debit === 0 || l.credit === 0).toBe(true);
      expect(l.debit + l.credit).toBeGreaterThan(0);
    }
  });

  it('uses the correct GL account for each role', () => {
    const lines = buildPayrollJournalLines(
      { totalGross: 100000, totalPaye: 15000, totalUif: 2000,
        totalUifEmployee: 1000, totalUifEmployer: 1000,
        totalSdl: 1000, totalNet: 84000 },
      MAP, 'Memo',
    );
    const byRole = Object.fromEntries(lines.map(l => [l.description.split(':')[0], l]));
    // Each description starts with the role key followed by a colon
    expect(byRole['salaries_expense']!.glAccountId).toBe(MAP.salaries_expense);
    expect(byRole['paye_payable']!.glAccountId).toBe(MAP.paye_payable);
    expect(byRole['net_salaries_payable']!.glAccountId).toBe(MAP.net_salaries_payable);
  });

  it('skips zero-amount lines (SDL when total_sdl is 0)', () => {
    const lines = buildPayrollJournalLines(
      { totalGross: 100000, totalPaye: 15000, totalUif: 2000,
        totalUifEmployee: 1000, totalUifEmployer: 1000,
        totalSdl: 0, totalNet: 84000 },
      MAP, 'Memo',
    );
    // SDL expense + SDL payable both dropped → 5 lines
    expect(lines).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Failing run** — confirm.

- [ ] **Step 3: Implement `buildPayrollJournalLines`** (pure function, no DB):

```ts
import type { PayrollGlRole } from './payrollGlConfigService';

export interface PayrollJournalLine {
  glAccountId: string;
  debit: number;
  credit: number;
  description: string;
}

const r = (n: number) => Math.round(n * 100) / 100;

export function buildPayrollJournalLines(
  totals: {
    totalGross: number; totalPaye: number;
    totalUif: number; totalUifEmployee: number; totalUifEmployer: number;
    totalSdl: number; totalNet: number;
  },
  map: Record<PayrollGlRole, string>,
  memo: string,
): PayrollJournalLine[] {
  const push = (role: PayrollGlRole, amt: number, side: 'dr' | 'cr'): PayrollJournalLine | null => {
    const a = r(amt);
    if (a === 0) return null;
    return {
      glAccountId: map[role],
      debit:  side === 'dr' ? a : 0,
      credit: side === 'cr' ? a : 0,
      description: `${role}: ${memo}`,
    };
  };

  const maybeLines = [
    push('salaries_expense',     totals.totalGross,         'dr'),
    push('uif_employer_expense', totals.totalUifEmployer,   'dr'),
    push('sdl_employer_expense', totals.totalSdl,           'dr'),
    push('paye_payable',         totals.totalPaye,          'cr'),
    push('uif_payable',          totals.totalUif,           'cr'),
    push('sdl_payable',          totals.totalSdl,           'cr'),
    push('net_salaries_payable', totals.totalNet,           'cr'),
  ];

  return maybeLines.filter((l): l is PayrollJournalLine => l !== null);
}
```

- [ ] **Step 4: Tests pass.**

- [ ] **Step 5: Implement `postPayrollRunToGL`**:

```ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getCompletePayrollGlMappings, type PayrollGlRole } from './payrollGlConfigService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

type Row = DbRow;

export async function postPayrollRunToGL(
  companyId: string, userId: string, runId: string,
): Promise<string> {
  log.info('Posting payroll run to GL', { companyId, runId }, 'payrollGlPostingService');

  const rows = (await sql`
    SELECT period_month, period_year,
           total_gross, total_paye, total_uif, total_sdl, total_net
    FROM payroll_run_headers
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  const h = rows[0];
  if (!h) throw new Error(`Payroll run ${runId} not found`);

  const lineRows = (await sql`
    SELECT
      COALESCE(SUM(uif_employee), 0) AS uif_employee,
      COALESCE(SUM(uif_employer), 0) AS uif_employer
    FROM payroll_run_lines WHERE run_id = ${runId}::uuid
  `) as Row[];
  const lineAgg = lineRows[0] ?? { uif_employee: 0, uif_employer: 0 };

  const map = await getCompletePayrollGlMappings(companyId);
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const memo = `Payroll run ${MONTHS[Number(h.period_month) - 1]} ${h.period_year}`;

  const lines = buildPayrollJournalLines({
    totalGross:         Number(h.total_gross),
    totalPaye:          Number(h.total_paye),
    totalUif:           Number(h.total_uif),
    totalUifEmployee:   Number(lineAgg.uif_employee),
    totalUifEmployer:   Number(lineAgg.uif_employer),
    totalSdl:           Number(h.total_sdl),
    totalNet:           Number(h.total_net),
  }, map, memo);

  if (lines.length === 0) throw new Error('No non-zero journal lines to post');

  const today = new Date().toISOString().slice(0, 10);
  const je = await createJournalEntry(companyId, {
    entryDate: today,
    description: memo,
    source: 'payroll',
    lines,
  });
  await postJournalEntry(companyId, je.id, userId);

  await sql`
    UPDATE payroll_run_headers
    SET posted_journal_entry_id = ${je.id}::uuid, updated_at = NOW()
    WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `;

  log.info('Payroll run posted to GL', { runId, journalEntryId: je.id }, 'payrollGlPostingService');
  return je.id;
}
```

- [ ] **Step 6: tsc + vitest** — green. Mock `createJournalEntry` + `postJournalEntry` for the unit test or leave them unmocked if the posting path already covered by tests in the gl module. Prefer minimal mocking in this file — the unit tests cover `buildPayrollJournalLines`; `postPayrollRunToGL` is glue that's easier to cover in the Task 12 e2e smoke.

- [ ] **Step 7: Commit**

```bash
git add src/modules/accounting/services/payroll/payrollGlPostingService.ts \
        tests/unit/services/payroll/payrollGlPostingService.test.ts
git commit -m "feat(payroll): GL posting — build balanced journal from run totals

buildPayrollJournalLines is a pure function (unit-tested) that produces
up to 7 balanced JournalLineInput rows from run totals + a complete
role→gl_account map. postPayrollRunToGL reads the run, calls the pure
builder, then delegates to createJournalEntry + postJournalEntry and
writes the new JE id back to payroll_run_headers.posted_journal_entry_id.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Lifecycle service + actions API (TDD)

**Files:**
- Create: `src/modules/accounting/services/payroll/payrollLifecycleService.ts`
- Create: `pages/api/payroll/runs/[id]/approve.ts`
- Create: `pages/api/payroll/runs/[id]/pay.ts`
- Create: `pages/api/payroll/runs/[id]/cancel.ts`
- Create: `tests/unit/services/payroll/payrollLifecycleService.test.ts`

### Transition rules

| From → To | Trigger | Side effect |
|---|---|---|
| `calculated` → `approved` | `approvePayrollRun(runId, userId)` | Posts GL via `postPayrollRunToGL`. Sets `approved_by`, `approved_at`. |
| `approved` → `paid` | `markPaid(runId, userId)` | Sets `paid_at`. (Actual bank payout is out of scope.) |
| `draft`/`calculated` → `cancelled` | `cancelPayrollRun(runId, userId)` | Sets `cancelled_by`, `cancelled_at`. No GL to reverse. |
| `approved` → `cancelled` | `cancelPayrollRun(runId, userId)` | Reverses the posted JE via `reverseJournalEntry`. Clears `posted_journal_entry_id`. |
| `paid` → (any) | — | Rejected. Paid runs are immutable. |

### Service

```ts
export async function approvePayrollRun(companyId: string, userId: string, runId: string): Promise<PayrollRunSummary>;
export async function markPaid           (companyId: string, userId: string, runId: string): Promise<PayrollRunSummary>;
export async function cancelPayrollRun   (companyId: string, userId: string, runId: string): Promise<PayrollRunSummary>;
```

Each:
1. Load run (company-scoped); throw if not found.
2. Check `status` against allowed "from" list; throw 400-style `Error` if invalid.
3. Run side effect (GL post or reverse).
4. UPDATE `payroll_run_headers` with new `status` + audit column + NOW().
5. Return the updated summary via `getPayrollRun`.

### TDD

Write at least:
1. `approvePayrollRun` moves calculated → approved and sets `approved_by`/`approved_at`
2. `approvePayrollRun` throws on `status === 'draft'`
3. `approvePayrollRun` throws on `status === 'paid'`
4. `markPaid` requires status=approved
5. `cancelPayrollRun` from approved calls `reverseJournalEntry` and clears `posted_journal_entry_id`
6. `cancelPayrollRun` from draft or calculated doesn't touch GL
7. `cancelPayrollRun` rejects from paid

Mock `@/lib/neon.sql`, `postPayrollRunToGL`, and `reverseJournalEntry` with `vi.mock` + mutable impls.

### API routes (all identical structure)

```ts
// pages/api/payroll/runs/[id]/approve.ts
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { withCsrf } from '@/lib/auth/withCsrf';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollLifecycleService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  const { companyId, user } = req as CompanyAuthedRequest;
  const { id } = req.query;
  if (typeof id !== 'string') return apiResponse.badRequest(res, 'Invalid run ID');
  const summary = await approvePayrollRun(companyId, String(user.id), id);
  return apiResponse.success(res, summary);
}
export default withAuth(withErrorHandler(withCsrf(handler)));
```

(The `pay.ts` and `cancel.ts` routes are the same template — swap in `markPaid` and `cancelPayrollRun`.)

### Steps

- [ ] **Step 1–4 (TDD for the service)**: tests fail → implement → tests pass.
- [ ] **Step 5**: write the 3 API route files.
- [ ] **Step 6**: tsc + full vitest.
- [ ] **Step 7**: Commit.

```bash
git add src/modules/accounting/services/payroll/payrollLifecycleService.ts \
        'pages/api/payroll/runs/[id]/approve.ts' \
        'pages/api/payroll/runs/[id]/pay.ts' \
        'pages/api/payroll/runs/[id]/cancel.ts' \
        tests/unit/services/payroll/payrollLifecycleService.test.ts
git commit -m "feat(payroll): run lifecycle — approve/pay/cancel with GL side effects

Approve posts GL via postPayrollRunToGL and stamps approved_by/at.
Pay stamps paid_at. Cancel from approved reverses the JE; from draft/
calculated is a no-op on GL. Paid runs are immutable.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Annual-payroll rollup service + wire into calculatePayrollRun (TDD)

**Files:**
- Create: `src/modules/accounting/services/payroll/payrollRollupService.ts`
- Create: `tests/unit/services/payroll/payrollRollupService.test.ts`
- Modify: `src/modules/accounting/services/payroll/payrollRunService.ts`

### Contract

```ts
// Sums total_gross from payroll_run_headers for the prior 11 months + the
// month being calculated, scaled to an annual estimate. When fewer than 12
// months of history exist, extrapolate: (sum_of_available_months / months_present) * 12.
//
// The purpose is the SDL R500k/year threshold — if the rolling-12 gross is
// under R500k, SDL is zero.
export async function getAnnualPayrollEstimate(
  companyId: string,
  period: { month: number; year: number },
): Promise<number>;
```

### TDD

Write tests that mock `sql` to return controlled row sets:

1. `getAnnualPayrollEstimate` with 12 months of history returns their sum exactly
2. With 6 months of history, returns `sum × 2` (extrapolation)
3. With 0 months of history, returns 0 (new companies)
4. Filters on `company_id`, non-cancelled status, and the 12-month window ending at the period

### Integrate

In `src/modules/accounting/services/payroll/payrollRunService.ts`, find the line:

```ts
const annualPayrollEstimate = employees.length * 25_000 * 12;
```

Replace with:

```ts
const annualPayrollEstimate = await getAnnualPayrollEstimate(companyId, period);
```

Import `getAnnualPayrollEstimate` from `./payrollRollupService`.

### Steps

- [ ] **Step 1-4: TDD the rollup service.**
- [ ] **Step 5: Wire into `calculatePayrollRun`.** Type check.
- [ ] **Step 6: Run all Phase 1/2/3 unit tests.** No regressions.
- [ ] **Step 7: Commit.**

```bash
git add src/modules/accounting/services/payroll/payrollRollupService.ts \
        tests/unit/services/payroll/payrollRollupService.test.ts \
        src/modules/accounting/services/payroll/payrollRunService.ts
git commit -m "feat(payroll): rolling-12-month annual payroll estimate for SDL

Replaces the hardcoded employees.length × 25000 × 12 in calculatePayrollRun
with a real rollup from payroll_run_headers. Extrapolates proportionally
when less than 12 months of history exist. Drives the SDL R500k threshold
accurately.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Payslip PDF service + API (TDD)

**Files:**
- Create: `src/modules/accounting/services/payroll/payslipPdfService.ts`
- Create: `pages/api/payroll/runs/[id]/payslip/[employeeId].ts`
- Create: `tests/unit/services/payroll/payslipPdfService.test.ts`

### Contract

```ts
// Returns a Buffer containing the PDF. Caller is responsible for writing
// response headers + streaming.
export async function generatePayslipPdf(
  companyId: string, runId: string, employeeId: string,
): Promise<Buffer>;
```

### Implementation notes

- Use `pdfkit` (already in `package.json`). Import as `import PDFDocument from 'pdfkit';`.
- Single-page layout: header with company name + period + employee name/number; earnings table; deductions table; net pay footer.
- Load data via three queries:
  1. `payroll_run_headers` for period + status
  2. `payroll_run_lines` for the employee's line (gross, paye, uif_employee, net)
  3. `payroll_employees` for employee details (name, number)
- Company scope enforced on every query.
- Component breakdown: read `payroll_run_lines.component_breakdown` JSONB — it already contains per-component rows from Phase 1's `calculatePayrollLine`.

### TDD

Full-PDF-content testing is overkill; instead test:
1. `generatePayslipPdf` returns a Buffer starting with the PDF magic `%PDF`
2. It rejects if the employee isn't part of the run (company_id mismatch → throws)
3. It includes the employee's name and net-pay amount in the document's text stream (use `pdf-parse` for the assertion if available, otherwise just scan buffer bytes for the name)

If adding `pdf-parse` as a dev dep is unwanted, fall back to the first two tests only.

### API route

```ts
// pages/api/payroll/runs/[id]/payslip/[employeeId].ts
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { generatePayslipPdf } from '@/modules/accounting/services/payroll/payslipPdfService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  const { companyId } = req as CompanyAuthedRequest;
  const { id, employeeId } = req.query;
  if (typeof id !== 'string' || typeof employeeId !== 'string') {
    return apiResponse.badRequest(res, 'Invalid id or employeeId');
  }
  const pdf = await generatePayslipPdf(companyId, id, employeeId);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${id}-${employeeId}.pdf"`);
  res.send(pdf);
}
// Read-only route — no withCsrf needed, but still auth-gated.
export default withAuth(withErrorHandler(handler));
```

### Steps

- [ ] **Step 1: Write tests** (mocking `sql` and instantiating `PDFDocument` in-process).
- [ ] **Step 2: Implement service.** Keep under 200 lines.
- [ ] **Step 3: Implement API route.**
- [ ] **Step 4: tsc + vitest**.
- [ ] **Step 5: Commit.**

```bash
git add src/modules/accounting/services/payroll/payslipPdfService.ts \
        'pages/api/payroll/runs/[id]/payslip/[employeeId].ts' \
        tests/unit/services/payroll/payslipPdfService.test.ts
git commit -m "feat(payroll): payslip PDF generation + API

Per-employee payslip via pdfkit. GET /api/payroll/runs/[id]/payslip/
[employeeId] streams a Buffer with Content-Type: application/pdf.
Company-scoped at every DB read.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 9: Split run detail page + add Approve/Pay/Cancel + payslip download

**Files:**
- Create: `src/components/payroll/PayrollRunActions.tsx`
- Create: `src/components/payroll/PayrollRunLinesTable.tsx`
- Modify: `pages/payroll/runs/[id].tsx`

### Goals for the updated detail page

1. Keep existing totals cards + Calculate button.
2. Add **Approve** (visible when `status === 'calculated'`), **Pay** (visible when `status === 'approved'`), **Cancel** (visible unless `status ∈ {paid, cancelled}`).
3. Show journal-entry link beside the status when `posted_journal_entry_id` is set: `View in GL →`.
4. Add per-row **Payslip ↓** button in the lines table that opens `/api/payroll/runs/[id]/payslip/[employeeId]` in a new tab.
5. Fix the `StatusBadge` keys — the Phase 2 map uses `posted` (schema uses `paid`). Change the badge key from `posted` to `paid` and keep the emerald colour.

### Extract to `PayrollRunActions`

Props:
```ts
interface Props {
  status: string;
  isBusy: boolean;
  onCalculate: () => void;
  onApprove: () => void;
  onPay: () => void;
  onCancel: () => void;
}
```

### Extract to `PayrollRunLinesTable`

Props:
```ts
interface Props {
  runId: string;
  lines: Line[];
  runStatus: string;
}
```

Body: the existing `<table>` with a new trailing column `Payslip`:
```tsx
<td className="py-2 px-4 text-right">
  {runStatus !== 'draft' && (
    <a href={`/api/payroll/runs/${runId}/payslip/${l.employeeId}`}
       target="_blank" rel="noopener noreferrer"
       className="text-teal-400 hover:text-teal-300 text-xs font-medium">
      Payslip
    </a>
  )}
</td>
```

### Steps

- [ ] **Step 1**: Extract the two sub-components.
- [ ] **Step 2**: Add new handlers to the page (`approve`, `pay`, `cancel`) — identical to the existing `calculate` pattern: POST the action endpoint then `load()` to refresh.
- [ ] **Step 3**: Update `StatusBadge` map: replace the `posted` key with `paid`. Make sure it's applied here AND in `pages/payroll/runs/index.tsx` (runs list page has its own copy).
- [ ] **Step 4**: tsc clean; page file under 300 lines after split.
- [ ] **Step 5**: Commit.

```bash
git add 'pages/payroll/runs/[id].tsx' \
        pages/payroll/runs/index.tsx \
        src/components/payroll/PayrollRunActions.tsx \
        src/components/payroll/PayrollRunLinesTable.tsx
git commit -m "feat(payroll): run detail — Approve/Pay/Cancel + per-row payslip

Extracts PayrollRunActions and PayrollRunLinesTable to keep the page
under 300 lines. Fixes StatusBadge to use 'paid' (matches schema CHECK
constraint) on both runs list and detail.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 10: Nav — add Settings

**Files:**
- Modify: `src/components/accounting/navSections/payroll.ts`

Add a new `Configuration` section containing `Settings`:

```ts
import type { Tab } from './types';

export const payrollTab: Tab = {
  id: 'payroll', label: 'Payroll',
  topItems: [
    { label: 'New Payroll Run', href: '/payroll/runs/new' },
  ],
  items: [
    {
      section: 'Employees',
      items: [
        { label: 'Employees', href: '/payroll/employees' },
        { label: 'Pay Components', href: '/payroll/components' },
      ],
    },
    {
      section: 'Processing',
      items: [
        { label: 'Payroll Runs', href: '/payroll/runs' },
      ],
    },
    {
      section: 'Configuration',
      items: [
        { label: 'Settings', href: '/payroll/settings' },
      ],
    },
  ],
};
```

- [ ] Edit the file. tsc clean. Commit.

```bash
git add src/components/accounting/navSections/payroll.ts
git commit -m "chore(payroll): add Settings to nav (Configuration section)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 11: E2E smoke — approve posts GL + payslip downloads

**Files:**
- Create: `tests/e2e/payroll-phase3-smoke.spec.ts`

### Scenario

1. Log in (shared `storageState` from existing auth.setup.ts).
2. Visit `/payroll/settings`. Map each of the 7 roles to **any** gl_account (pick the first option in each `<select>`). Save.
3. Visit `/payroll/runs`. Find the most recent `calculated` run (or create + calculate a new one if none exists — mirror the Phase 2 smoke for setup).
4. On the run detail page, click **Approve**.
5. Expect status to flip to `approved`.
6. Expect a `View in GL →` link to appear next to the status.
7. Click the first **Payslip** link in the lines table. Expect a new tab with a `application/pdf` response (check `response.headers()['content-type']`).

Selectors: label-proximity or `getByRole('button', { name: 'Approve' })`. Mirror the Phase 2 smoke style.

- [ ] Write the spec. Don't run it — it needs the dev server.
- [ ] Commit.

```bash
git add tests/e2e/payroll-phase3-smoke.spec.ts
git commit -m "test(payroll): e2e smoke — settings map, approve, GL link, payslip

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 12: Final acceptance sweep

- [ ] `bunx tsc --noEmit` — clean.
- [ ] `bunx vitest run` — 800+ tests pass (Phase 1=46 + Phase 2 emp201/assign=7+4 + Phase 3 new tests ≈ 30 more).
- [ ] Smoke manually in browser:
  1. `/payroll/settings` — map the 7 roles, Save, reload, see persisted.
  2. Create a pay component + employee + run (as in Phase 2 flow). Calculate.
  3. Hit **Approve**. Status moves to `approved`. A `View in GL →` link appears.
  4. Click the link — lands in GL journal entry with 5–7 balanced lines.
  5. Click **Payslip** on one of the line rows — PDF renders.
  6. Hit **Pay**. Status moves to `paid`. Approve / Cancel / Pay buttons all disappear.
  7. On another run (still `calculated`), hit **Cancel**. Status moves to `cancelled`.
  8. On a further run, approve then cancel. Verify the associated JE is reversed.
- [ ] `bunx playwright test tests/e2e/payroll-phase3-smoke.spec.ts` — green (may need selector tweaks).

**Phase 4** (next): Leave management rebuild.

**Phase 5** (then): SARS monthly + annual compliance (EMP201 UI wire, IRP5 PDF + e@syFile, EMP501 reconciliation).

**Phase 6** (final): Operational polish — audit log, bulk import, payroll register, UIF/SDL submission reports.
