# PRD-02 Payroll Phase 2 — Legacy Sweep + Core Payroll UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the pre-Phase-1 legacy payroll module (17 API files, 7 UI pages, 14 services, 4 tables) and ship a working UI for the Phase 1 engine — employees list/create/edit, pay components, payroll runs with calculate action.

**Architecture:** Part A decommissions the legacy system (file deletes + one migration that drops legacy tables). Part B adds one missing service method (component assignment), then builds Next.js pages wired to Phase 1 APIs using the existing `AppLayout` + `apiFetch` + `formatCurrency` patterns. No new state-management library — each page uses local `useState` + `useEffect`.

**Tech Stack:** Next.js 14 (pages router), TypeScript strict, Tailwind (via `var(--ff-*)` CSS variables), `lucide-react` icons, Vitest + Playwright. Package manager: bun.

---

## Pre-flight — what's being swept

**Legacy files to delete** (do not skip — route collisions exist):

`pages/api/payroll/` — delete these 17 files:
- `audit-log.ts`, `emp501-reconciliation.ts`, `employees.ts`, `employees-detail.ts`, `irp5-certificates.ts`, `irp5-generate.ts`, `irp5-readiness.ts`, `leave-applications.ts`, `leave-balances.ts`, `payroll-documents.ts`, `payroll-emp201.ts`, `payroll-runs.ts`, `payroll-runs-action.ts`, `payroll-runs-detail.ts`, `payroll-sdl.ts`, `payslip-pdf.ts`, `uif-declaration.ts`

`pages/payroll/` — delete these 7 legacy files + 3 legacy directories:
- Files: `emp201.tsx`, `emp501.tsx`, `irp5.tsx`, `irp5-readiness.tsx`, `tax-directives.tsx`, `uif.tsx`
- Directories (to be deleted then rebuilt): `employees/`, `runs/`, `leave/`

`src/modules/payroll/` — delete the entire directory (14 files).

**Phase 1 code stays put** — all new code lives under `src/modules/accounting/services/payroll/` and `pages/api/payroll/{employees,components,runs}/`.

**Legacy tables to drop** in migration 384:
- `payslips`
- `pay_structures`
- `payroll_runs` (legacy — Phase 1 uses `payroll_run_headers`)
- `employees` (only payroll references it — verified with grep)

**Nav:** `Leave` is deferred to Phase 3; remove that nav entry so there are no 404s.

---

## Critical conventions (read before starting)

- **Package manager:** `bun`. Tests: `bunx vitest run <path>`. Dev: `bun run dev`. Type check: `bunx tsc --noEmit`.
- **DB:** `sql` tagged template from `@/lib/neon`. Always `${companyId}::uuid` scope. Never string-concatenate SQL.
- **API handlers:** wrap with `withAuth(withErrorHandler(withCsrf(handler)))`. Import:
  ```ts
  import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
  import { withCsrf } from '@/lib/auth/withCsrf';
  import { withErrorHandler } from '@/lib/api-error-handler';
  ```
- **API response helpers:** `apiResponse.success(res, data)`, `.created()`, `.badRequest(res, 'msg')`, `.notFound(res, 'Entity', id)`, `.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET','POST'])`.
- **Logger:** `import { log } from '@/lib/logger'; log.info('msg', { meta }, 'category')` — NEVER `console.log`.
- **Fetch on the client:** use `apiFetch` from `@/lib/apiFetch` (auto-attaches company + CSRF).
- **Tailwind:** use the project's CSS variables — `bg-[var(--ff-bg-primary)]`, `text-[var(--ff-text-secondary)]`, etc. Accent colour: `teal-500` / `teal-600`.
- **Icons:** from `lucide-react`. Size: `h-4 w-4` inline, `h-5 w-5` buttons, `h-6 w-6` headers, `h-8 w-8` spinners, `h-12 w-12` empty-state placeholders.
- **File size:** max 300 lines per file. Split when bigger.
- **Commits:** after every passing test / green build. Message format: `feat(payroll):`, `chore(payroll): sweep legacy`, `fix(payroll):`, `test(payroll):`.
- **Migrations:** `IF NOT EXISTS` on every `CREATE`; `IF EXISTS` on every `DROP`.

---

## File Map

### Files to delete (Part A)

| Path | Notes |
|------|-------|
| `pages/api/payroll/audit-log.ts` | legacy |
| `pages/api/payroll/emp501-reconciliation.ts` | legacy |
| `pages/api/payroll/employees.ts` | **route collision with Phase 1 `employees/index.ts`** |
| `pages/api/payroll/employees-detail.ts` | legacy |
| `pages/api/payroll/irp5-certificates.ts` | legacy (EMP501 rebuild = Phase 4) |
| `pages/api/payroll/irp5-generate.ts` | legacy |
| `pages/api/payroll/irp5-readiness.ts` | legacy |
| `pages/api/payroll/leave-applications.ts` | legacy (Leave rebuild = Phase 3) |
| `pages/api/payroll/leave-balances.ts` | legacy |
| `pages/api/payroll/payroll-documents.ts` | legacy |
| `pages/api/payroll/payroll-emp201.ts` | legacy |
| `pages/api/payroll/payroll-runs.ts` | legacy |
| `pages/api/payroll/payroll-runs-action.ts` | legacy |
| `pages/api/payroll/payroll-runs-detail.ts` | legacy |
| `pages/api/payroll/payroll-sdl.ts` | legacy |
| `pages/api/payroll/payslip-pdf.ts` | legacy |
| `pages/api/payroll/uif-declaration.ts` | legacy |
| `pages/payroll/emp201.tsx` | legacy (Phase 4) |
| `pages/payroll/emp501.tsx` | legacy (Phase 4) |
| `pages/payroll/irp5.tsx` | legacy |
| `pages/payroll/irp5-readiness.tsx` | legacy (Phase 4) |
| `pages/payroll/tax-directives.tsx` | legacy |
| `pages/payroll/uif.tsx` | legacy |
| `pages/payroll/employees/` (dir, 3 files) | legacy — rebuilt in Part B |
| `pages/payroll/runs/` (dir, 3 files) | legacy — rebuilt in Part B |
| `pages/payroll/leave/` (dir, 2 files) | legacy — deferred to Phase 3 |
| `src/modules/payroll/` (14 files) | legacy module entirely |
| `tests/unit/services/payroll/` (only if empty after Phase 1 scan) | NO — Phase 1 tests live here; keep |

Note: the last row is a trap — Phase 1 put its tests in `tests/unit/services/payroll/`. **Do NOT delete this directory.** Only `src/modules/payroll/` is legacy.

### Files to modify (Part A)

| Path | Change |
|------|--------|
| `src/modules/accounting/services/reports/emp201Service.ts` | Rewire from `payroll_runs` + `payslips` → `payroll_run_headers` + `payroll_run_lines`. |
| `src/components/accounting/navSections/payroll.ts` | Remove Leave + Compliance section temporarily. |
| `scripts/migrations/sql/384_drop_legacy_payroll.sql` | **Create**: drops 4 legacy tables. |

### Files to create (Part B)

| Path | Purpose |
|------|---------|
| `src/modules/accounting/services/payroll/payrollEmployeeComponentService.ts` | Assign/remove employee–component mappings. |
| `pages/api/payroll/employees/[id]/components.ts` | GET/POST/DELETE assignment endpoints. |
| `pages/payroll/employees/index.tsx` | List page (rebuilt). |
| `pages/payroll/employees/new.tsx` | Create page (rebuilt). |
| `pages/payroll/employees/[id].tsx` | Detail + edit + components (rebuilt). |
| `pages/payroll/components/index.tsx` | **New** — Pay components list + inline create. |
| `pages/payroll/runs/index.tsx` | List page (rebuilt). |
| `pages/payroll/runs/new.tsx` | Create page (rebuilt). |
| `pages/payroll/runs/[id].tsx` | Detail + Calculate action (rebuilt). |
| `tests/unit/services/payroll/payrollEmployeeComponentService.test.ts` | Service tests. |
| `tests/e2e/payroll-smoke.spec.ts` | Full golden-path flow. |

---

## Part A — Decommission Legacy

### Task 1: Delete legacy API routes

**Files:**
- Delete: 17 files in `pages/api/payroll/` listed in File Map above.

- [ ] **Step 1: Confirm legacy files exist, then delete**

Run:
```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/prd-02-payroll
ls pages/api/payroll/ | sort
```

Expected: the 17 legacy files are listed (alongside Phase 1 directories `employees/`, `components/`, `runs/`).

- [ ] **Step 2: Delete the 17 legacy API files**

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/prd-02-payroll
rm pages/api/payroll/audit-log.ts \
   pages/api/payroll/emp501-reconciliation.ts \
   pages/api/payroll/employees.ts \
   pages/api/payroll/employees-detail.ts \
   pages/api/payroll/irp5-certificates.ts \
   pages/api/payroll/irp5-generate.ts \
   pages/api/payroll/irp5-readiness.ts \
   pages/api/payroll/leave-applications.ts \
   pages/api/payroll/leave-balances.ts \
   pages/api/payroll/payroll-documents.ts \
   pages/api/payroll/payroll-emp201.ts \
   pages/api/payroll/payroll-runs.ts \
   pages/api/payroll/payroll-runs-action.ts \
   pages/api/payroll/payroll-runs-detail.ts \
   pages/api/payroll/payroll-sdl.ts \
   pages/api/payroll/payslip-pdf.ts \
   pages/api/payroll/uif-declaration.ts
```

- [ ] **Step 3: Verify remaining routes are all Phase 1**

```bash
ls pages/api/payroll/
```

Expected output:
```
components
employees
runs
```

- [ ] **Step 4: Type check — expect errors about missing legacy service imports (next task fixes)**

```bash
bunx tsc --noEmit 2>&1 | grep "modules/payroll" | head -5
```

Expected: zero lines (because we just deleted the things importing it). If you see `Cannot find module '@/modules/payroll/...'` it means something under `src/` or `pages/` still imports legacy. Run Task 3 first to clear.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(payroll): delete 17 legacy API routes (Phase 2 Part A)"
```

---

### Task 2: Delete legacy UI pages

**Files:**
- Delete: 6 legacy files + 3 legacy directories under `pages/payroll/`.

- [ ] **Step 1: Delete legacy top-level UI pages**

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/prd-02-payroll
rm pages/payroll/emp201.tsx \
   pages/payroll/emp501.tsx \
   pages/payroll/irp5.tsx \
   pages/payroll/irp5-readiness.tsx \
   pages/payroll/tax-directives.tsx \
   pages/payroll/uif.tsx
```

- [ ] **Step 2: Delete legacy UI directories (entire trees)**

```bash
rm -rf pages/payroll/employees \
       pages/payroll/runs \
       pages/payroll/leave
```

- [ ] **Step 3: Verify `pages/payroll/` is now empty**

```bash
ls pages/payroll/ 2>/dev/null; echo "exit=$?"
```

Expected: `exit=0` with no output (directory still exists but empty) OR the directory may have been removed if empty.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(payroll): delete legacy UI pages (Phase 2 Part A)"
```

---

### Task 3: Delete legacy payroll service module

**Files:**
- Delete: entire `src/modules/payroll/` directory (14 files).

- [ ] **Step 1: Delete the legacy module**

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/prd-02-payroll
rm -rf src/modules/payroll
```

- [ ] **Step 2: Search for any remaining imports of the deleted module**

```bash
grep -rln "from '@/modules/payroll" src/ pages/ tests/ 2>/dev/null
```

Expected: **no output**. If there are results, those files reference the deleted module — inspect and either delete or rewire to `@/modules/accounting/services/payroll/*` (the Phase 1 module).

- [ ] **Step 3: Type check the whole project**

```bash
bunx tsc --noEmit 2>&1 | tail -20
```

Expected: clean (no errors), OR the only remaining errors are in `src/modules/accounting/services/reports/emp201Service.ts` (fixed in Task 5).

If there are other errors, open the offending files and remove any `@/modules/payroll/*` references.

- [ ] **Step 4: Run Phase 1 unit tests to confirm nothing broke**

```bash
bunx vitest run tests/unit/services/payroll/
```

Expected: `Test Files 6 passed (6) | Tests 46 passed (46)`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(payroll): delete legacy src/modules/payroll module (Phase 2 Part A)"
```

---

### Task 4: Migration 384 — drop legacy tables

**Files:**
- Create: `scripts/migrations/sql/384_drop_legacy_payroll.sql`

**Why four drops?** `payslips` FKs to both `payroll_runs` and `employees`. `pay_structures` FKs to `employees`. Drop order: dependents first, parents last. `CASCADE` is used as belt-and-braces for any FKs not modelled explicitly.

- [ ] **Step 1: Write the migration**

Create file `scripts/migrations/sql/384_drop_legacy_payroll.sql`:
```sql
-- 384_drop_legacy_payroll.sql
-- PRD-02 Phase 2: remove pre-Phase-1 payroll schema.
-- Phase 1 tables live in payroll_employees / payroll_components /
-- payroll_run_headers / payroll_run_lines and are unaffected.

DROP TABLE IF EXISTS payslips       CASCADE;
DROP TABLE IF EXISTS pay_structures CASCADE;
DROP TABLE IF EXISTS payroll_runs   CASCADE;
DROP TABLE IF EXISTS employees      CASCADE;

-- Any remaining legacy payroll audit / ETI / readiness helper tables are
-- dropped explicitly too, if they exist. CASCADE handles grandchild FKs.
DROP TABLE IF EXISTS payroll_audit_log CASCADE;
```

- [ ] **Step 2: Apply to the dev DB via the existing migration runner**

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/prd-02-payroll
bun run scripts/migrate-database.ts
```

Expected: runner reports `384_drop_legacy_payroll.sql` applied. Re-running should be a no-op.

- [ ] **Step 3: Verify with `psql` / Neon SQL editor that the tables are gone**

Run (adjust per your runner):
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name
IN ('employees','payslips','pay_structures','payroll_runs','payroll_audit_log');
```

Expected: **empty result**.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrations/sql/384_drop_legacy_payroll.sql
git commit -m "feat(db): migration 384 — drop legacy payroll tables (Phase 2 Part A)"
```

---

### Task 5: Rewire `emp201Service.ts` to Phase 1 schema

**Files:**
- Modify: `src/modules/accounting/services/reports/emp201Service.ts`

The existing service queries `payroll_runs` + `payslips`. After Task 4 those tables don't exist. Update the query to target `payroll_run_headers` + `payroll_run_lines`. The service's defensive "table missing" path will still cover clean-install cases.

- [ ] **Step 1: Read the current service**

Already present; full contents are in Phase 1 context. Key facts:
- Exports `generateEMP201(companyId, periodStart, periodEnd): Promise<EMP201Data>`
- Checks `information_schema.tables` for `('payroll_runs','payslips')` then bails if absent.
- The final aggregate uses `pr.run_date`, `ps.gross_pay`, `ps.paye`, `ps.uif_employee`, `ps.uif_employer`, `ps.sdl`.

- [ ] **Step 2: Write a failing test**

Create `tests/unit/services/reports/emp201Service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const calls: Array<{ strings: readonly string[]; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: Array.from(strings), values });
    const joined = strings.join('?');
    if (joined.includes('information_schema.tables')) {
      return Promise.resolve([
        { table_name: 'payroll_run_headers' },
        { table_name: 'payroll_run_lines' },
      ]);
    }
    if (joined.includes('FROM payroll_run_headers')) {
      return Promise.resolve([
        {
          id: 'run-1',
          period_month: 3,
          period_year: 2025,
          employee_count: 2,
          total_gross: 50000,
          total_paye: 7000,
          total_uif: 1000,
          total_sdl: 500,
        },
      ]);
    }
    return Promise.resolve([]);
  };
  return { sql, __esModule: true, _calls: calls };
});

import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emp201Service — Phase 1 schema', () => {
  it('queries payroll_run_headers (not legacy payroll_runs)', async () => {
    const result = await generateEMP201(
      '11111111-1111-1111-1111-111111111111',
      '2025-03-01',
      '2025-03-31',
    );
    expect(result.totalPAYE).toBe(7000);
    expect(result.totalUIF).toBe(1000);
    expect(result.totalSDL).toBe(500);
    expect(result.payrollRuns).toHaveLength(1);
  });

  it('returns zero-filled data when new tables are missing', async () => {
    const { _calls } = (await import('@/lib/neon')) as unknown as {
      _calls: Array<{ strings: readonly string[] }>;
    };
    _calls.length = 0;

    // Re-mock to simulate missing tables
    vi.resetModules();
    vi.doMock('@/lib/neon', () => ({
      sql: () => Promise.resolve([]), // no tables found
    }));
    const { generateEMP201: gen } = await import(
      '@/modules/accounting/services/reports/emp201Service'
    );

    const result = await gen(
      '11111111-1111-1111-1111-111111111111',
      '2025-03-01',
      '2025-03-31',
    );
    expect(result.totalPAYE).toBe(0);
    expect(result.payrollRuns).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it FAILS**

```bash
bunx vitest run tests/unit/services/reports/emp201Service.test.ts
```

Expected: the first test fails because the service still references `payroll_runs`/`payslips`.

- [ ] **Step 4: Update the service to read Phase 1 tables**

Replace the contents of `src/modules/accounting/services/reports/emp201Service.ts` with:
```ts
/**
 * EMP201 Generation Service
 * Reads SARS EMP201 (PAYE/UIF/SDL) totals from Phase 1 payroll tables
 * (payroll_run_headers, payroll_run_lines). Gracefully returns zero-filled
 * data if the tables have not yet been created.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface EMP201Data {
  periodStart: string;
  periodEnd: string;
  totalPAYE: number;
  totalUIF_employee: number;
  totalUIF_employer: number;
  totalUIF: number;
  totalSDL: number;
  employeeCount: number;
  totalTaxableRemuneration: number;
  totalDeductions: number;
  payrollRuns: EMP201PayrollRun[];
}

export interface EMP201PayrollRun {
  id: string;
  runDate: string;
  employeeCount: number;
  grossPay: number;
  paye: number;
  uif: number;
  sdl: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function generateEMP201(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<EMP201Data> {
  log.info('Generating EMP201', { companyId, periodStart, periodEnd }, 'emp201Service');

  const empty: EMP201Data = {
    periodStart, periodEnd,
    totalPAYE: 0, totalUIF_employee: 0, totalUIF_employer: 0, totalUIF: 0,
    totalSDL: 0, employeeCount: 0,
    totalTaxableRemuneration: 0, totalDeductions: 0,
    payrollRuns: [],
  };

  let tablesReady = false;
  try {
    const rows = (await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('payroll_run_headers', 'payroll_run_lines')
    `) as Row[];
    tablesReady = rows.length >= 2;
  } catch (err) {
    log.warn('Could not check payroll tables', { error: err }, 'emp201Service');
  }
  if (!tablesReady) return empty;

  try {
    const start = new Date(periodStart);
    const end = new Date(periodEnd);
    const runs = (await sql`
      SELECT
        prh.id,
        prh.period_month,
        prh.period_year,
        prh.employee_count,
        prh.total_gross,
        prh.total_paye,
        prh.total_uif,
        prh.total_sdl
      FROM payroll_run_headers prh
      WHERE prh.company_id = ${companyId}::uuid
        AND prh.status = 'calculated'
        AND make_date(prh.period_year, prh.period_month, 1) >= ${start.toISOString().slice(0, 10)}
        AND make_date(prh.period_year, prh.period_month, 1) <= ${end.toISOString().slice(0, 10)}
      ORDER BY prh.period_year, prh.period_month
    `) as Row[];

    if (runs.length === 0) return empty;

    let totalPAYE = 0, totalUIF = 0, totalSDL = 0, totalGross = 0, empCount = 0;

    const payrollRuns: EMP201PayrollRun[] = runs.map((r) => {
      const paye = Number(r.total_paye) || 0;
      const uif  = Number(r.total_uif) || 0;
      const sdl  = Number(r.total_sdl) || 0;
      const gross = Number(r.total_gross) || 0;
      const count = Number(r.employee_count) || 0;
      totalPAYE  += paye;
      totalUIF   += uif;
      totalSDL   += sdl;
      totalGross += gross;
      empCount = Math.max(empCount, count);
      return {
        id: String(r.id),
        runDate: `${r.period_year}-${String(r.period_month).padStart(2, '0')}-01`,
        employeeCount: count,
        grossPay: round(gross),
        paye: round(paye),
        uif: round(uif),
        sdl: round(sdl),
      };
    });

    return {
      periodStart, periodEnd,
      totalPAYE: round(totalPAYE),
      totalUIF_employee: round(totalUIF / 2), // Phase 4 splits employee/employer from lines
      totalUIF_employer: round(totalUIF / 2),
      totalUIF: round(totalUIF),
      totalSDL: round(totalSDL),
      employeeCount: empCount,
      totalTaxableRemuneration: round(totalGross),
      totalDeductions: round(totalPAYE + totalUIF + totalSDL),
      payrollRuns,
    };
  } catch (err) {
    log.warn('Error generating EMP201', { error: err }, 'emp201Service');
    return empty;
  }
}
```

- [ ] **Step 5: Run the test again — expect PASS**

```bash
bunx vitest run tests/unit/services/reports/emp201Service.test.ts
```

Expected: `Test Files 1 passed (1) | Tests 2 passed (2)`.

- [ ] **Step 6: Re-run full Phase 1 suite to confirm no regressions**

```bash
bunx vitest run tests/unit/services/
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/modules/accounting/services/reports/emp201Service.ts tests/unit/services/reports/emp201Service.test.ts
git commit -m "refactor(payroll): rewire emp201Service to Phase 1 tables"
```

---

### Task 6: Tidy the nav — defer Leave + Compliance

**Files:**
- Modify: `src/components/accounting/navSections/payroll.ts`

Phase 2 only ships Employees + Components + Runs. Leave is Phase 3, compliance (IRP5 / EMP501) is Phase 4. Shipping dead links is worse than omitting them.

- [ ] **Step 1: Replace the file contents**

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
  ],
};
```

- [ ] **Step 2: Type check**

```bash
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/accounting/navSections/payroll.ts
git commit -m "chore(payroll): trim nav to Phase 2 scope (Employees, Components, Runs)"
```

---

## Part B — Core Payroll UI

### Task 7: Employee ↔ Component assignment service + API

The Phase 1 engine needs each employee to have at least one pay component (e.g. "Basic Salary") so `calculatePayrollRun` produces non-zero output. Phase 1 shipped read-only `getEmployeeComponents` but no way to create assignments. That's what this task adds.

**Files:**
- Create: `src/modules/accounting/services/payroll/payrollEmployeeComponentService.ts`
- Create: `pages/api/payroll/employees/[id]/components.ts`
- Create: `tests/unit/services/payroll/payrollEmployeeComponentService.test.ts`

- [ ] **Step 1: Write the failing service test**

Create `tests/unit/services/payroll/payrollEmployeeComponentService.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ sql: string; values: unknown[] }> = [];
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const s = strings.join('?');
    calls.push({ sql: s, values });
    if (s.includes('INSERT INTO payroll_employee_components')) {
      return Promise.resolve([{
        id: 'pec-1',
        employee_id: values[0],
        component_id: values[1],
        amount: values[2],
        effective_from: values[3],
        effective_to: null,
      }]);
    }
    if (s.includes('UPDATE payroll_employee_components')) {
      return Promise.resolve([]);
    }
    if (s.includes('FROM payroll_employees')) {
      return Promise.resolve([{ id: values[0] }]); // verify company scope
    }
    return Promise.resolve([]);
  },
}));

import {
  assignComponentToEmployee,
  endEmployeeComponent,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

beforeEach(() => {
  calls.length = 0;
});

describe('payrollEmployeeComponentService', () => {
  it('assignComponentToEmployee inserts with company guard', async () => {
    const res = await assignComponentToEmployee(
      'company-1',
      'emp-1',
      'comp-1',
      25000,
      new Date('2025-03-01'),
    );
    expect(res.amount).toBe(25000);
    const hasCompanyGuard = calls.some(c =>
      c.sql.includes('FROM payroll_employees') && c.sql.includes('company_id')
    );
    expect(hasCompanyGuard).toBe(true);
  });

  it('assignComponentToEmployee rejects when employee is not in company', async () => {
    // override mock for this test: employee lookup returns empty
    const neon = await import('@/lib/neon');
    const original = neon.sql;
    (neon as any).sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
      const s = strings.join('?');
      if (s.includes('FROM payroll_employees')) return Promise.resolve([]);
      return original(strings as any, ...values);
    };
    await expect(
      assignComponentToEmployee('company-1', 'emp-1', 'comp-1', 25000, new Date('2025-03-01'))
    ).rejects.toThrow(/not found/i);
    (neon as any).sql = original;
  });

  it('endEmployeeComponent sets effective_to', async () => {
    await endEmployeeComponent('company-1', 'pec-1', new Date('2025-04-30'));
    const hasUpdate = calls.some(c =>
      c.sql.includes('UPDATE payroll_employee_components')
      && c.sql.includes('effective_to')
    );
    expect(hasUpdate).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module not found)**

```bash
bunx vitest run tests/unit/services/payroll/payrollEmployeeComponentService.test.ts
```

- [ ] **Step 3: Implement the service**

Create `src/modules/accounting/services/payroll/payrollEmployeeComponentService.ts`:
```ts
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface EmployeeComponentAssignment {
  id: string;
  employeeId: string;
  componentId: string;
  amount: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

function mapRow(r: Row): EmployeeComponentAssignment {
  return {
    id: String(r.id),
    employeeId: String(r.employee_id),
    componentId: String(r.component_id),
    amount: Number(r.amount),
    effectiveFrom: new Date(String(r.effective_from)),
    effectiveTo: r.effective_to ? new Date(String(r.effective_to)) : null,
  };
}

async function assertEmployeeInCompany(
  employeeId: string,
  companyId: string,
): Promise<void> {
  const rows = (await sql`
    SELECT id FROM payroll_employees
    WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (rows.length === 0) {
    throw new Error(`Payroll employee ${employeeId} not found in company`);
  }
}

export async function assignComponentToEmployee(
  companyId: string,
  employeeId: string,
  componentId: string,
  amount: number,
  effectiveFrom: Date,
  effectiveTo?: Date,
): Promise<EmployeeComponentAssignment> {
  log.info(
    'Assigning component to employee',
    { companyId, employeeId, componentId, amount },
    'payrollEmployeeComponentService',
  );
  await assertEmployeeInCompany(employeeId, companyId);

  const rows = (await sql`
    INSERT INTO payroll_employee_components (
      employee_id, component_id, amount, effective_from, effective_to
    ) VALUES (
      ${employeeId}::uuid, ${componentId}::uuid, ${amount},
      ${effectiveFrom.toISOString().slice(0, 10)},
      ${effectiveTo ? effectiveTo.toISOString().slice(0, 10) : null}
    )
    RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error('Failed to assign component');
  return mapRow(rows[0]);
}

export async function endEmployeeComponent(
  companyId: string,
  assignmentId: string,
  effectiveTo: Date,
): Promise<void> {
  log.info(
    'Ending employee component',
    { companyId, assignmentId, effectiveTo },
    'payrollEmployeeComponentService',
  );
  await sql`
    UPDATE payroll_employee_components
    SET effective_to = ${effectiveTo.toISOString().slice(0, 10)}
    WHERE id = ${assignmentId}::uuid
      AND employee_id IN (
        SELECT id FROM payroll_employees WHERE company_id = ${companyId}::uuid
      )
  `;
}

export async function listEmployeeComponentAssignments(
  companyId: string,
  employeeId: string,
): Promise<Array<EmployeeComponentAssignment & { componentName: string; componentType: string }>> {
  await assertEmployeeInCompany(employeeId, companyId);
  const rows = (await sql`
    SELECT pec.*, pc.name AS component_name, pc.component_type
    FROM payroll_employee_components pec
    JOIN payroll_components pc ON pc.id = pec.component_id
    WHERE pec.employee_id = ${employeeId}::uuid
    ORDER BY pec.effective_from DESC
  `) as Row[];
  return rows.map(r => ({
    ...mapRow(r),
    componentName: String(r.component_name),
    componentType: String(r.component_type),
  }));
}
```

- [ ] **Step 4: Run service test — expect PASS**

```bash
bunx vitest run tests/unit/services/payroll/payrollEmployeeComponentService.test.ts
```

- [ ] **Step 5: Create the API route**

Create `pages/api/payroll/employees/[id]/components.ts`:
```ts
/**
 * Employee Components API
 * GET    /api/payroll/employees/:id/components      — list assignments
 * POST   /api/payroll/employees/:id/components      — assign (body: componentId, amount, effectiveFrom, effectiveTo?)
 * DELETE /api/payroll/employees/:id/components?aid  — end an assignment (body: effectiveTo)
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
  assignComponentToEmployee,
  endEmployeeComponent,
  listEmployeeComponentAssignments,
} from '@/modules/accounting/services/payroll/payrollEmployeeComponentService';

async function handler(
  req: AuthenticatedNextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;
  if (typeof id !== 'string') return apiResponse.badRequest(res, 'Invalid employee ID');

  if (req.method === 'GET') {
    const items = await listEmployeeComponentAssignments(companyId, id);
    return apiResponse.success(res, items);
  }

  if (req.method === 'POST') {
    const { componentId, amount, effectiveFrom, effectiveTo } =
      req.body as Record<string, unknown>;
    if (!componentId || amount == null || !effectiveFrom) {
      return apiResponse.badRequest(
        res,
        'componentId, amount, effectiveFrom are required',
      );
    }
    const out = await assignComponentToEmployee(
      companyId,
      id,
      String(componentId),
      Number(amount),
      new Date(String(effectiveFrom)),
      effectiveTo ? new Date(String(effectiveTo)) : undefined,
    );
    return apiResponse.created(res, out);
  }

  if (req.method === 'DELETE') {
    const { aid } = req.query;
    const { effectiveTo } = req.body as Record<string, unknown>;
    if (typeof aid !== 'string' || !effectiveTo) {
      return apiResponse.badRequest(res, 'aid + effectiveTo required');
    }
    await endEmployeeComponent(companyId, aid, new Date(String(effectiveTo)));
    return apiResponse.success(res, { ended: aid });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
```

- [ ] **Step 6: Type check**

```bash
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/modules/accounting/services/payroll/payrollEmployeeComponentService.ts \
        pages/api/payroll/employees/[id]/components.ts \
        tests/unit/services/payroll/payrollEmployeeComponentService.test.ts
git commit -m "feat(payroll): employee-component assignment service + API"
```

---

### Task 8: Employees — list page

**Files:**
- Create: `pages/payroll/employees/index.tsx`

Shape returned by `GET /api/payroll/employees` (unwrapped from `{ data }`):
```ts
interface PayrollEmployeeApi {
  id: string;
  companyId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  idNumber?: string;
  taxNumber?: string;
  employmentType: 'permanent' | 'contract' | 'casual' | 'director';
  startDate: string;
  endDate?: string;
  dateOfBirth?: string;
  uifExcluded: boolean;
  medicalAidMainMember: boolean;
  medicalAidDependantsCount: number;
}
```

- [ ] **Step 1: Create the page**

```tsx
/**
 * Payroll Employees List — Phase 2.
 * Route: /payroll/employees
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Users, Loader2, AlertCircle, Plus, Search } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';

interface EmployeeListItem {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  employmentType: string;
  startDate: string;
  endDate?: string;
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        active
          ? 'bg-teal-500/10 text-teal-400'
          : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]'
      }`}
    >
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

export default function EmployeesListPage() {
  const [employees, setEmployees] = useState<EmployeeListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/employees');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = (json.data ?? json) as EmployeeListItem[];
      setEmployees(data);
    } catch {
      setError('Failed to load employees');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = employees.filter(e => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.employeeNumber.toLowerCase().includes(q) ||
      `${e.firstName} ${e.lastName}`.toLowerCase().includes(q)
    );
  });

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <Users className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Employees</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">SA-compliant payroll roster</p>
              </div>
            </div>
            <Link
              href="/payroll/employees/new"
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium"
            >
              <Plus className="h-4 w-4" /> New Employee
            </Link>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or employee number..."
                className="pl-9 pr-4 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm w-80 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>
            {!isLoading && (
              <span className="text-sm text-[var(--ff-text-secondary)]">
                {filtered.length} employee{filtered.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16">
              <Users className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No employees yet</p>
              <Link
                href="/payroll/employees/new"
                className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> New Employee
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Emp #</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Type</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Start</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(e => (
                    <tr
                      key={e.id}
                      className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]"
                    >
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)] font-mono text-xs">{e.employeeNumber}</td>
                      <td className="py-3 px-4">
                        <Link
                          href={`/payroll/employees/${e.id}`}
                          className="font-medium text-[var(--ff-text-primary)] hover:text-teal-400"
                        >
                          {e.firstName} {e.lastName}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)] capitalize">{e.employmentType}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{e.startDate.slice(0, 10)}</td>
                      <td className="py-3 px-4"><StatusBadge active={!e.endDate || new Date(e.endDate) > new Date()} /></td>
                      <td className="py-3 px-4">
                        <Link href={`/payroll/employees/${e.id}`} className="text-teal-400 hover:text-teal-300 text-xs font-medium">
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Dev server sanity check**

```bash
bun run dev
# visit http://localhost:3000/payroll/employees
```

Expected: empty-state "No employees yet" (DB has none yet). No console errors.

- [ ] **Step 3: Type check**

```bash
bunx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add pages/payroll/employees/index.tsx
git commit -m "feat(payroll): employees list page"
```

---

### Task 9: Employees — new page

**Files:**
- Create: `pages/payroll/employees/new.tsx`

Required by Phase 1 POST: `firstName`, `lastName`, `employeeNumber`, `employmentType`, `startDate`.
Optional: `taxNumber`, `idNumber`, `dateOfBirth`, `endDate`, `uifExcluded`, `medicalAidMainMember`, `medicalAidDependantsCount`.

- [ ] **Step 1: Create the page**

```tsx
/**
 * Payroll Employee Create Page — Phase 2.
 * Route: /payroll/employees/new
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { UserPlus, Loader2, ArrowLeft } from 'lucide-react';

type EmploymentType = 'permanent' | 'contract' | 'casual' | 'director';

interface FormState {
  firstName: string;
  lastName: string;
  employeeNumber: string;
  employmentType: EmploymentType;
  startDate: string;
  idNumber: string;
  taxNumber: string;
  dateOfBirth: string;
  uifExcluded: boolean;
  medicalAidMainMember: boolean;
  medicalAidDependantsCount: string; // string in form, coerced on submit
}

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function NewEmployeePage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>({
    firstName: '', lastName: '', employeeNumber: '',
    employmentType: 'permanent', startDate: todayISO(),
    idNumber: '', taxNumber: '', dateOfBirth: '',
    uifExcluded: false, medicalAidMainMember: true,
    medicalAidDependantsCount: '0',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(prev => ({ ...prev, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.firstName || !form.lastName || !form.employeeNumber || !form.startDate) {
      setError('Name, employee number, and start date are required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/payroll/employees', {
        method: 'POST',
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          employeeNumber: form.employeeNumber,
          employmentType: form.employmentType,
          startDate: form.startDate,
          taxNumber: form.taxNumber || undefined,
          idNumber: form.idNumber || undefined,
          dateOfBirth: form.dateOfBirth || undefined,
          uifExcluded: form.uifExcluded,
          medicalAidMainMember: form.medicalAidMainMember,
          medicalAidDependantsCount: Number(form.medicalAidDependantsCount) || 0,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      const created = json.data ?? json;
      router.push(`/payroll/employees/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  };

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
  const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/employees" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <UserPlus className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Employee</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Create a payroll employee</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Identification</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={label}>First name *</label>
                <input className={field} value={form.firstName} onChange={e => set('firstName', e.target.value)} required />
              </div>
              <div>
                <label className={label}>Last name *</label>
                <input className={field} value={form.lastName} onChange={e => set('lastName', e.target.value)} required />
              </div>
              <div>
                <label className={label}>Employee number *</label>
                <input className={field} value={form.employeeNumber} onChange={e => set('employeeNumber', e.target.value)} required />
              </div>
              <div>
                <label className={label}>Employment type</label>
                <select className={field} value={form.employmentType} onChange={e => set('employmentType', e.target.value as EmploymentType)}>
                  <option value="permanent">Permanent</option>
                  <option value="contract">Contract</option>
                  <option value="casual">Casual</option>
                  <option value="director">Director</option>
                </select>
              </div>
              <div>
                <label className={label}>SA ID number</label>
                <input className={field} value={form.idNumber} onChange={e => set('idNumber', e.target.value)} placeholder="13 digits" />
              </div>
              <div>
                <label className={label}>SARS tax number</label>
                <input className={field} value={form.taxNumber} onChange={e => set('taxNumber', e.target.value)} placeholder="10 digits" />
              </div>
              <div>
                <label className={label}>Date of birth</label>
                <input type="date" className={field} value={form.dateOfBirth} onChange={e => set('dateOfBirth', e.target.value)} />
              </div>
              <div>
                <label className={label}>Start date *</label>
                <input type="date" className={field} value={form.startDate} onChange={e => set('startDate', e.target.value)} required />
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Payroll flags</h2>
            <div className="grid grid-cols-2 gap-4">
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={form.uifExcluded} onChange={e => set('uifExcluded', e.target.checked)} />
                Excluded from UIF
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={form.medicalAidMainMember} onChange={e => set('medicalAidMainMember', e.target.checked)} />
                Medical aid main member
              </label>
              <div>
                <label className={label}>Medical aid dependants</label>
                <input type="number" min="0" className={field} value={form.medicalAidDependantsCount} onChange={e => set('medicalAidDependantsCount', e.target.value)} />
              </div>
            </div>
          </section>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Employee
            </button>
            <Link href="/payroll/employees" className="px-4 py-2 rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Dev sanity — create an employee**

Visit `/payroll/employees/new`, fill the form, submit. Expected: redirects to `/payroll/employees/<new-id>` (next task renders that page; for now it 404s — acceptable until Task 10).

- [ ] **Step 3: Type check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add pages/payroll/employees/new.tsx
git commit -m "feat(payroll): new employee form page"
```

---

### Task 10: Employees — detail + edit + component assignment

**Files:**
- Create: `pages/payroll/employees/[id].tsx`

The page does three things:
1. Load and display the employee (with inline edit for mutable fields).
2. List assigned components (via the Task 7 API).
3. Inline "assign new component" form — pick from `/api/payroll/components` then set amount + effective-from.

- [ ] **Step 1: Create the page**

```tsx
/**
 * Payroll Employee Detail + Edit + Components — Phase 2.
 * Route: /payroll/employees/[id]
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { User, ArrowLeft, Loader2, AlertCircle, Plus, X, Save } from 'lucide-react';

interface Employee {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  employmentType: 'permanent' | 'contract' | 'casual' | 'director';
  startDate: string;
  endDate?: string;
  taxNumber?: string;
  idNumber?: string;
  dateOfBirth?: string;
  uifExcluded: boolean;
  medicalAidMainMember: boolean;
  medicalAidDependantsCount: number;
}

interface Component {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
}

interface Assignment {
  id: string;
  componentId: string;
  componentName: string;
  componentType: string;
  amount: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export default function EmployeeDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const employeeId = typeof id === 'string' ? id : '';

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [components, setComponents] = useState<Component[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);

  // Assignment form
  const [newComponentId, setNewComponentId] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newFrom, setNewFrom] = useState(new Date().toISOString().slice(0, 10));
  const [addingAssignment, setAddingAssignment] = useState(false);

  const loadAll = useCallback(async () => {
    if (!employeeId) return;
    setIsLoading(true);
    setError('');
    try {
      const [eRes, cRes, aRes] = await Promise.all([
        apiFetch(`/api/payroll/employees/${employeeId}`),
        apiFetch('/api/payroll/components'),
        apiFetch(`/api/payroll/employees/${employeeId}/components`),
      ]);
      if (!eRes.ok) throw new Error(`Employee HTTP ${eRes.status}`);
      const eJson = await eRes.json();
      const cJson = cRes.ok ? await cRes.json() : { data: [] };
      const aJson = aRes.ok ? await aRes.json() : { data: [] };
      setEmployee((eJson.data ?? eJson) as Employee);
      setComponents((cJson.data ?? cJson) as Component[]);
      setAssignments((aJson.data ?? aJson) as Assignment[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setIsLoading(false);
    }
  }, [employeeId]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const saveProfile = async () => {
    if (!employee) return;
    setSavingProfile(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/employees/${employee.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          firstName: employee.firstName,
          lastName: employee.lastName,
          employmentType: employee.employmentType,
          taxNumber: employee.taxNumber,
          idNumber: employee.idNumber,
          dateOfBirth: employee.dateOfBirth,
          endDate: employee.endDate,
          uifExcluded: employee.uifExcluded,
          medicalAidMainMember: employee.medicalAidMainMember,
          medicalAidDependantsCount: employee.medicalAidDependantsCount,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSavingProfile(false);
    }
  };

  const assignComponent = async () => {
    if (!newComponentId || !newAmount) return;
    setAddingAssignment(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/components`, {
        method: 'POST',
        body: JSON.stringify({
          componentId: newComponentId,
          amount: Number(newAmount),
          effectiveFrom: newFrom,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setNewComponentId(''); setNewAmount('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assignment failed');
    } finally {
      setAddingAssignment(false);
    }
  };

  const endAssignment = async (assignmentId: string) => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await apiFetch(
      `/api/payroll/employees/${employeeId}/components?aid=${assignmentId}`,
      { method: 'DELETE', body: JSON.stringify({ effectiveTo: today }) },
    );
    if (res.ok) await loadAll();
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)]">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (error && !employee) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)] flex-col gap-2">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-red-400 text-sm">{error}</p>
          <Link href="/payroll/employees" className="text-teal-400 text-sm">Back</Link>
        </div>
      </AppLayout>
    );
  }

  if (!employee) return null;

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
  const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/employees" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <User className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
                {employee.firstName} {employee.lastName}
              </h1>
              <p className="text-sm text-[var(--ff-text-secondary)] font-mono">{employee.employeeNumber}</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Profile */}
          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Profile</h2>
              <button
                onClick={saveProfile}
                disabled={savingProfile}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-medium"
              >
                {savingProfile ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={label}>First name</label>
                <input className={field} value={employee.firstName}
                  onChange={e => setEmployee({ ...employee, firstName: e.target.value })} />
              </div>
              <div>
                <label className={label}>Last name</label>
                <input className={field} value={employee.lastName}
                  onChange={e => setEmployee({ ...employee, lastName: e.target.value })} />
              </div>
              <div>
                <label className={label}>Tax number</label>
                <input className={field} value={employee.taxNumber ?? ''}
                  onChange={e => setEmployee({ ...employee, taxNumber: e.target.value })} />
              </div>
              <div>
                <label className={label}>ID number</label>
                <input className={field} value={employee.idNumber ?? ''}
                  onChange={e => setEmployee({ ...employee, idNumber: e.target.value })} />
              </div>
              <div>
                <label className={label}>Date of birth</label>
                <input type="date" className={field} value={employee.dateOfBirth?.slice(0, 10) ?? ''}
                  onChange={e => setEmployee({ ...employee, dateOfBirth: e.target.value })} />
              </div>
              <div>
                <label className={label}>End date</label>
                <input type="date" className={field} value={employee.endDate?.slice(0, 10) ?? ''}
                  onChange={e => setEmployee({ ...employee, endDate: e.target.value || undefined })} />
              </div>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={employee.uifExcluded}
                  onChange={e => setEmployee({ ...employee, uifExcluded: e.target.checked })} />
                UIF excluded
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={employee.medicalAidMainMember}
                  onChange={e => setEmployee({ ...employee, medicalAidMainMember: e.target.checked })} />
                Medical aid main member
              </label>
              <div>
                <label className={label}>Medical aid dependants</label>
                <input type="number" min="0" className={field} value={employee.medicalAidDependantsCount}
                  onChange={e => setEmployee({ ...employee, medicalAidDependantsCount: Number(e.target.value) || 0 })} />
              </div>
            </div>
          </section>

          {/* Components */}
          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">Pay Components</h2>

            <div className="flex items-end gap-3 mb-4 pb-4 border-b border-[var(--ff-border-primary)]">
              <div className="flex-1">
                <label className={label}>Component</label>
                <select className={field} value={newComponentId} onChange={e => setNewComponentId(e.target.value)}>
                  <option value="">Select a component…</option>
                  {components.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.componentType})</option>
                  ))}
                </select>
              </div>
              <div className="w-40">
                <label className={label}>Amount (R)</label>
                <input type="number" step="0.01" className={field}
                  value={newAmount} onChange={e => setNewAmount(e.target.value)} />
              </div>
              <div className="w-40">
                <label className={label}>Effective from</label>
                <input type="date" className={field}
                  value={newFrom} onChange={e => setNewFrom(e.target.value)} />
              </div>
              <button
                onClick={assignComponent}
                disabled={!newComponentId || !newAmount || addingAssignment}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium"
              >
                {addingAssignment ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Assign
              </button>
            </div>

            {assignments.length === 0 ? (
              <p className="text-sm text-[var(--ff-text-tertiary)]">No components assigned yet. Assign at least a basic-salary component to produce non-zero payroll.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] text-left">
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium">Component</th>
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium">Type</th>
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium text-right">Amount</th>
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium">From</th>
                    <th className="py-2 text-[var(--ff-text-secondary)] font-medium">To</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map(a => (
                    <tr key={a.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-2 text-[var(--ff-text-primary)]">{a.componentName}</td>
                      <td className="py-2 text-[var(--ff-text-secondary)] capitalize">{a.componentType}</td>
                      <td className="py-2 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(a.amount)}</td>
                      <td className="py-2 text-[var(--ff-text-secondary)]">{a.effectiveFrom.slice(0, 10)}</td>
                      <td className="py-2 text-[var(--ff-text-secondary)]">{a.effectiveTo ? a.effectiveTo.slice(0, 10) : '—'}</td>
                      <td className="py-2 text-right">
                        {!a.effectiveTo && (
                          <button onClick={() => endAssignment(a.id)}
                            className="p-1 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] hover:text-red-400">
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Dev sanity — load the employee created in Task 9**

Visit `/payroll/employees/<id>`. Expected: profile fields populated; components list empty; assignment form present. PATCH/Save toggles loading. Assignment requires a component to exist (Task 11 creates one).

- [ ] **Step 3: Type check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add pages/payroll/employees/[id].tsx
git commit -m "feat(payroll): employee detail + edit + component assignment"
```

---

### Task 11: Pay Components — list + inline create

**Files:**
- Create: `pages/payroll/components/index.tsx`

One page handles both list and "new" (inline form). Creating new payroll configuration pages shouldn't require navigation gymnastics.

SARS source code cheat-sheet shown inline: `3601`=basic salary, `3605`=annual bonus, `3606`=commission, `3713`=travel/cell allowance, `3802`=housing allowance.

- [ ] **Step 1: Create the page**

```tsx
/**
 * Pay Components List + Create — Phase 2.
 * Route: /payroll/components
 */
import { useEffect, useState, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Tags, Loader2, AlertCircle, Plus } from 'lucide-react';

type ComponentType = 'earning' | 'deduction' | 'employer_contribution';

interface Component {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: ComponentType;
  isTaxable: boolean;
  isUifApplicable: boolean;
  isSdlApplicable: boolean;
}

const SARS_HINTS = [
  '3601 — Basic salary',
  '3605 — Annual bonus',
  '3606 — Commission',
  '3713 — Travel/cell allowance',
  '3802 — Housing allowance',
  '4001 — Pension fund (deduction)',
  '4005 — Medical aid (deduction)',
];

export default function PayComponentsPage() {
  const [components, setComponents] = useState<Component[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [sarsCode, setSarsCode] = useState('3601');
  const [type, setType] = useState<ComponentType>('earning');
  const [isTaxable, setIsTaxable] = useState(true);
  const [isUifApplicable, setIsUifApplicable] = useState(true);
  const [isSdlApplicable, setIsSdlApplicable] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/components');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setComponents((json.data ?? json) as Component[]);
    } catch {
      setError('Failed to load components');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !sarsCode) return;
    setCreating(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/components', {
        method: 'POST',
        body: JSON.stringify({
          name, sarsSourceCode: sarsCode, componentType: type,
          isTaxable, isUifApplicable, isSdlApplicable,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setName(''); setSarsCode('3601'); setType('earning');
      setIsTaxable(true); setIsUifApplicable(true); setIsSdlApplicable(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
  const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Tags className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Pay Components</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Earnings, deductions, employer contributions (SARS-tagged)</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}

          <form onSubmit={create} className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">New component</h2>
            <div className="grid grid-cols-4 gap-4">
              <div className="col-span-2">
                <label className={label}>Name</label>
                <input className={field} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Basic Salary" />
              </div>
              <div>
                <label className={label}>SARS code</label>
                <input className={field} value={sarsCode} onChange={e => setSarsCode(e.target.value)} />
                <p className="text-[10px] text-[var(--ff-text-tertiary)] mt-1">{SARS_HINTS.join(' · ')}</p>
              </div>
              <div>
                <label className={label}>Type</label>
                <select className={field} value={type} onChange={e => setType(e.target.value as ComponentType)}>
                  <option value="earning">Earning</option>
                  <option value="deduction">Deduction</option>
                  <option value="employer_contribution">Employer contribution</option>
                </select>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={isTaxable} onChange={e => setIsTaxable(e.target.checked)} />
                Taxable
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={isUifApplicable} onChange={e => setIsUifApplicable(e.target.checked)} />
                UIF applicable
              </label>
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
                <input type="checkbox" checked={isSdlApplicable} onChange={e => setIsSdlApplicable(e.target.checked)} />
                SDL applicable
              </label>
              <button type="submit" disabled={creating || !name}
                className="ml-auto flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add component
              </button>
            </div>
          </form>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : components.length === 0 ? (
            <div className="text-center py-12 text-[var(--ff-text-secondary)] text-sm">
              No components yet — create one above.
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">SARS</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Type</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Tax</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">UIF</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">SDL</th>
                  </tr>
                </thead>
                <tbody>
                  {components.map(c => (
                    <tr key={c.id} className="border-b border-[var(--ff-border-primary)] last:border-0">
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">{c.name}</td>
                      <td className="py-3 px-4 font-mono text-xs text-[var(--ff-text-secondary)]">{c.sarsSourceCode}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)] capitalize">{c.componentType.replace('_', ' ')}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.isTaxable ? 'Y' : 'N'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.isUifApplicable ? 'Y' : 'N'}</td>
                      <td className="py-3 px-4 text-[var(--ff-text-secondary)]">{c.isSdlApplicable ? 'Y' : 'N'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Dev sanity — create a "Basic Salary" component (3601, earning, taxable, UIF+SDL applicable)**

- [ ] **Step 3: Type check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add pages/payroll/components/index.tsx
git commit -m "feat(payroll): pay components list + inline create page"
```

---

### Task 12: Payroll Runs — list page

**Files:**
- Create: `pages/payroll/runs/index.tsx`

Shape from `GET /api/payroll/runs`:
```ts
interface PayrollRunSummary {
  id: string;
  companyId: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
  employeeCount: number;
}
```

- [ ] **Step 1: Create the page**

```tsx
/**
 * Payroll Runs List — Phase 2.
 * Route: /payroll/runs
 */
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { CalendarDays, Loader2, AlertCircle, Plus } from 'lucide-react';

interface RunRow {
  id: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalNet: number;
  employeeCount: number;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const periodLabel = (r: RunRow) => `${MONTHS[r.periodMonth - 1]} ${r.periodYear}`;

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-yellow-500/10 text-yellow-400',
    calculated: 'bg-blue-500/10 text-blue-400',
    approved: 'bg-teal-500/10 text-teal-400',
    posted: 'bg-emerald-500/10 text-emerald-400',
    cancelled: 'bg-red-500/10 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-500/10 text-gray-400'}`}>
      {status}
    </span>
  );
}

export default function PayrollRunsListPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/runs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRuns((json.data ?? json) as RunRow[]);
    } catch {
      setError('Failed to load payroll runs');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarDays className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Runs</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Monthly payroll cycles</p>
              </div>
            </div>
            <Link href="/payroll/runs/new" className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium">
              <Plus className="h-4 w-4" /> New Payroll Run
            </Link>
          </div>
        </div>

        <div className="p-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 text-red-400 py-12">
              <AlertCircle className="h-5 w-5" /><span>{error}</span>
            </div>
          ) : runs.length === 0 ? (
            <div className="text-center py-16">
              <CalendarDays className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)] font-medium">No payroll runs yet</p>
              <Link href="/payroll/runs/new" className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium">
                <Plus className="h-4 w-4" /> New Payroll Run
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--ff-border-primary)] overflow-hidden bg-[var(--ff-surface-primary)]">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Period</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Status</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Employees</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Gross</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">PAYE</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Net</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map(r => (
                    <tr key={r.id} className="border-b border-[var(--ff-border-primary)] last:border-0 hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="py-3 px-4 text-[var(--ff-text-primary)]">{periodLabel(r)}</td>
                      <td className="py-3 px-4"><StatusBadge status={r.status} /></td>
                      <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{r.employeeCount}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(r.totalGross)}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(r.totalPaye)}</td>
                      <td className="py-3 px-4 text-right font-mono text-[var(--ff-text-primary)] font-medium">{formatCurrency(r.totalNet)}</td>
                      <td className="py-3 px-4 text-right">
                        <Link href={`/payroll/runs/${r.id}`} className="text-teal-400 hover:text-teal-300 text-xs font-medium">
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Dev sanity — visit `/payroll/runs`, expect empty state.**

- [ ] **Step 3: Type check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add pages/payroll/runs/index.tsx
git commit -m "feat(payroll): payroll runs list page"
```

---

### Task 13: Payroll Runs — new page

**Files:**
- Create: `pages/payroll/runs/new.tsx`

Minimal form: pick month + year. POST body expects `{ month: number, year: number }`.

- [ ] **Step 1: Create the page**

```tsx
/**
 * New Payroll Run — Phase 2.
 * Route: /payroll/runs/new
 */
import { useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { Plus, ArrowLeft, Loader2 } from 'lucide-react';

const MONTHS = [
  { v: 1, n: 'January' }, { v: 2, n: 'February' }, { v: 3, n: 'March' },
  { v: 4, n: 'April' }, { v: 5, n: 'May' }, { v: 6, n: 'June' },
  { v: 7, n: 'July' }, { v: 8, n: 'August' }, { v: 9, n: 'September' },
  { v: 10, n: 'October' }, { v: 11, n: 'November' }, { v: 12, n: 'December' },
];

export default function NewPayrollRunPage() {
  const router = useRouter();
  const today = new Date();
  const [month, setMonth] = useState<number>(today.getMonth() + 1);
  const [year, setYear] = useState<number>(today.getFullYear());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await apiFetch('/api/payroll/runs', {
        method: 'POST',
        body: JSON.stringify({ month, year }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      const created = json.data ?? json;
      router.push(`/payroll/runs/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  };

  const field = 'w-full px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500';
  const label = 'block text-xs font-medium text-[var(--ff-text-secondary)] mb-1';

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/payroll/runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Plus className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">New Payroll Run</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Pick the period — calculation happens on the next page.</p>
            </div>
          </div>
        </div>

        <form onSubmit={submit} className="p-6 max-w-md space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}
          <div className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4 space-y-4">
            <div>
              <label className={label}>Month</label>
              <select className={field} value={month} onChange={e => setMonth(Number(e.target.value))}>
                {MONTHS.map(m => <option key={m.v} value={m.v}>{m.n}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>Year</label>
              <input type="number" min="2020" max="2099" className={field}
                value={year} onChange={e => setYear(Number(e.target.value) || today.getFullYear())} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" disabled={submitting}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Create Run
            </button>
            <Link href="/payroll/runs" className="px-4 py-2 rounded-lg text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] text-sm">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Dev sanity — create a new run for the current month; expect redirect to detail page (not yet built)**

- [ ] **Step 3: Type check**

```bash
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add pages/payroll/runs/new.tsx
git commit -m "feat(payroll): new payroll run form"
```

---

### Task 14: Payroll Runs — detail + calculate + lines

**Files:**
- Create: `pages/payroll/runs/[id].tsx`
- Modify: `src/modules/accounting/services/payroll/payrollRunService.ts` (**add `getPayrollRunLines` helper**)
- Modify: `pages/api/payroll/runs/[id].ts` (**include lines in the GET response**)

Reason: the current `GET /api/payroll/runs/[id]` only returns the header summary. The UI needs line items too.

- [ ] **Step 1: Add `getPayrollRunLines` to the service**

Append to `src/modules/accounting/services/payroll/payrollRunService.ts` (at the bottom, before any existing exports block — simple export):

```ts
export interface PayrollRunLine {
  id: string;
  runId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
}

export async function getPayrollRunLines(
  runId: string,
  companyId: string,
): Promise<PayrollRunLine[]> {
  const rows = (await sql`
    SELECT
      prl.*,
      pe.employee_number,
      pe.first_name,
      pe.last_name
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    JOIN payroll_employees    pe  ON pe.id  = prl.employee_id
    WHERE prl.run_id = ${runId}::uuid
      AND prh.company_id = ${companyId}::uuid
    ORDER BY pe.employee_number
  `) as Row[];

  return rows.map(r => ({
    id: String(r.id),
    runId: String(r.run_id),
    employeeId: String(r.employee_id),
    employeeNumber: String(r.employee_number),
    employeeName: `${r.first_name} ${r.last_name}`,
    grossPay: Number(r.gross_pay),
    taxableIncome: Number(r.taxable_income),
    paye: Number(r.paye),
    uifEmployee: Number(r.uif_employee),
    uifEmployer: Number(r.uif_employer),
    sdl: Number(r.sdl),
    eti: Number(r.eti),
    netPay: Number(r.net_pay),
  }));
}
```

- [ ] **Step 2: Update the GET handler to include lines**

Replace the body of `pages/api/payroll/runs/[id].ts` with:
```ts
/**
 * Payroll Run Detail API
 * GET /api/payroll/runs/[id]  - Get a single payroll run + its lines
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
  getPayrollRun,
  getPayrollRunLines,
} from '@/modules/accounting/services/payroll/payrollRunService';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const { id } = req.query;
  if (typeof id !== 'string') return apiResponse.badRequest(res, 'Invalid run ID');

  const run = await getPayrollRun(id, companyId);
  if (!run) return apiResponse.notFound(res, 'PayrollRun', id);

  const lines = await getPayrollRunLines(id, companyId);
  return apiResponse.success(res, { ...run, lines });
}

export default withAuth(withErrorHandler(withCsrf(handler)));
```

- [ ] **Step 3: Create the page**

Create `pages/payroll/runs/[id].tsx`:
```tsx
/**
 * Payroll Run Detail — Phase 2.
 * Route: /payroll/runs/[id]
 */
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { CalendarDays, ArrowLeft, Loader2, AlertCircle, Calculator, CheckCircle2 } from 'lucide-react';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

interface Line {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
}

interface RunDetail {
  id: string;
  periodMonth: number;
  periodYear: number;
  status: string;
  totalGross: number;
  totalPaye: number;
  totalUif: number;
  totalSdl: number;
  totalEti: number;
  totalNet: number;
  employeeCount: number;
  lines: Line[];
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-yellow-500/10 text-yellow-400',
    calculated: 'bg-blue-500/10 text-blue-400',
    approved: 'bg-teal-500/10 text-teal-400',
    posted: 'bg-emerald-500/10 text-emerald-400',
    cancelled: 'bg-red-500/10 text-red-400',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-500/10 text-gray-400'}`}>
      {status}
    </span>
  );
}

export default function PayrollRunDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const runId = typeof id === 'string' ? id : '';

  const [run, setRun] = useState<RunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [calculating, setCalculating] = useState(false);

  const load = useCallback(async () => {
    if (!runId) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setRun((json.data ?? json) as RunDetail);
    } catch {
      setError('Failed to load run');
    } finally {
      setIsLoading(false);
    }
  }, [runId]);

  useEffect(() => { load(); }, [load]);

  const calculate = async () => {
    if (!runId) return;
    setCalculating(true);
    setError('');
    try {
      const res = await apiFetch(`/api/payroll/runs/${runId}/calculate`, { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Calculate failed');
    } finally {
      setCalculating(false);
    }
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)]">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }
  if (error && !run) {
    return (
      <AppLayout>
        <div className="min-h-screen flex items-center justify-center bg-[var(--ff-bg-primary)] flex-col gap-2">
          <AlertCircle className="h-8 w-8 text-red-400" />
          <p className="text-red-400 text-sm">{error}</p>
          <Link href="/payroll/runs" className="text-teal-400 text-sm">Back</Link>
        </div>
      </AppLayout>
    );
  }
  if (!run) return null;

  const period = `${MONTHS[run.periodMonth - 1]} ${run.periodYear}`;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/payroll/runs" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
                <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
              </Link>
              <div className="p-2 rounded-lg bg-teal-500/10">
                <CalendarDays className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Payroll Run — {period}</h1>
                <div className="flex items-center gap-2 mt-1"><StatusBadge status={run.status} /></div>
              </div>
            </div>
            <button onClick={calculate} disabled={calculating || run.status !== 'draft' && run.status !== 'calculated'}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-sm font-medium">
              {calculating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calculator className="h-4 w-4" />}
              {run.status === 'draft' ? 'Calculate' : 'Recalculate'}
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {error && (
            <div className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">{error}</div>
          )}

          {/* Totals cards */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { label: 'Employees', value: String(run.employeeCount), mono: false },
              { label: 'Total Gross', value: formatCurrency(run.totalGross), mono: true },
              { label: 'Total PAYE', value: formatCurrency(run.totalPaye), mono: true },
              { label: 'Total UIF', value: formatCurrency(run.totalUif), mono: true },
              { label: 'Total SDL', value: formatCurrency(run.totalSdl), mono: true },
              { label: 'Total Net', value: formatCurrency(run.totalNet), mono: true, accent: true },
            ].map(stat => (
              <div key={stat.label} className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-3">
                <p className="text-[10px] uppercase tracking-wide text-[var(--ff-text-tertiary)]">{stat.label}</p>
                <p className={`mt-1 ${stat.mono ? 'font-mono' : ''} ${stat.accent ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'} text-sm font-semibold`}>
                  {stat.value}
                </p>
              </div>
            ))}
          </div>

          {/* Lines */}
          <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line items</h2>
              {run.status === 'calculated' && (
                <span className="flex items-center gap-1 text-xs text-teal-400">
                  <CheckCircle2 className="h-4 w-4" /> Calculated
                </span>
              )}
            </div>
            {run.lines.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)] text-sm">
                No lines yet — press <span className="text-teal-400 font-medium">Calculate</span> to generate payroll for this period.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--ff-bg-secondary)] text-left">
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium">Emp #</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Gross</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">PAYE</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">UIF (E)</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">UIF (R)</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">SDL</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">ETI</th>
                    <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {run.lines.map(l => (
                    <tr key={l.id} className="border-t border-[var(--ff-border-primary)]">
                      <td className="py-2 px-4 font-mono text-xs text-[var(--ff-text-secondary)]">{l.employeeNumber}</td>
                      <td className="py-2 px-4 text-[var(--ff-text-primary)]">{l.employeeName}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(l.grossPay)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.paye)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.uifEmployee)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.uifEmployer)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.sdl)}</td>
                      <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.eti)}</td>
                      <td className="py-2 px-4 text-right font-mono text-teal-400 font-medium">{formatCurrency(l.netPay)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 4: Type check + unit tests**

```bash
bunx tsc --noEmit
bunx vitest run tests/unit/services/payroll/
```

Expected: clean; 47+ tests pass (we didn't add a service test for `getPayrollRunLines`; Task 15 covers it via e2e).

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/payroll/payrollRunService.ts \
        pages/api/payroll/runs/[id].ts \
        pages/payroll/runs/[id].tsx
git commit -m "feat(payroll): payroll run detail page with lines + Calculate action"
```

---

### Task 15: End-to-end smoke test

**Files:**
- Create: `tests/e2e/payroll-smoke.spec.ts`

Proves the Phase 2 loop works: create component → create employee → assign component → create run → calculate → read totals. If any step breaks, this catches it.

- [ ] **Step 1: Verify Playwright is configured**

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/prd-02-payroll
ls playwright.config.ts 2>/dev/null && head -20 playwright.config.ts
```

If it doesn't exist, skip this task and log a TODO to add one in Phase 3.

- [ ] **Step 2: Write the test**

Create `tests/e2e/payroll-smoke.spec.ts`:
```ts
import { test, expect } from '@playwright/test';

const SUFFIX = String(Date.now()).slice(-6);
const EMP_NO = `E-PHASE2-${SUFFIX}`;
const COMP_NAME = `Basic Salary ${SUFFIX}`;

test('Phase 2 payroll golden path', async ({ page }) => {
  // Components page — create basic salary component
  await page.goto('/payroll/components');
  await page.fill('input[placeholder*="Basic Salary"]', COMP_NAME);
  await page.click('button:has-text("Add component")');
  await expect(page.locator('table')).toContainText(COMP_NAME);

  // Employees page — create an employee
  await page.goto('/payroll/employees/new');
  await page.fill('input[placeholder=""] >> nth=0', 'Phase');        // first name
  await page.fill('input[placeholder=""] >> nth=1', 'Two');          // last name
  await page.fill('input[value=""][required]', EMP_NO);              // employee number
  await page.click('button:has-text("Create Employee")');
  await expect(page).toHaveURL(/\/payroll\/employees\/[0-9a-f-]+/);

  // Assign basic salary R25,000
  await page.selectOption('select:near(:text("Component"))', { label: `${COMP_NAME} (earning)` });
  await page.fill('input[type="number"][step="0.01"]', '25000');
  await page.click('button:has-text("Assign")');
  await expect(page.locator('td')).toContainText(COMP_NAME);

  // Create a run
  const today = new Date();
  await page.goto('/payroll/runs/new');
  await page.selectOption('select', { index: today.getMonth() });
  await page.fill('input[type="number"]', String(today.getFullYear()));
  await page.click('button:has-text("Create Run")');
  await expect(page).toHaveURL(/\/payroll\/runs\/[0-9a-f-]+/);

  // Calculate
  await page.click('button:has-text("Calculate")');
  await expect(page.locator('text=/R\s*25[,\s]000/')).toBeVisible({ timeout: 10_000 });
});
```

- [ ] **Step 3: Run e2e (dev server must be up in another terminal)**

```bash
bunx playwright test tests/e2e/payroll-smoke.spec.ts --reporter=list
```

Expected: test passes. If it fails on selectors, open Playwright UI and adjust selectors (DOM may have shifted from inline styles).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/payroll-smoke.spec.ts
git commit -m "test(payroll): e2e smoke — components → employees → run → calculate"
```

---

## Acceptance (final check before closing Phase 2)

Run the full suite and verify:

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/prd-02-payroll
bunx tsc --noEmit            # clean
bunx vitest run              # all green (includes Phase 1 + emp201Service + employee-component tests)
bunx playwright test tests/e2e/payroll-smoke.spec.ts
```

**Smoke checklist:**
1. `/payroll/employees` loads, empty-state → create employee → detail page opens.
2. `/payroll/components` loads, create a Basic Salary (3601) component.
3. Return to employee detail, assign the component with amount R25,000, effective today.
4. `/payroll/runs/new` → create run for current month → redirects to detail.
5. Press **Calculate** → totals and lines appear non-zero.
6. Nav has three sections: Employees, Pay Components, Payroll Runs. No Leave/Compliance items.

If all six steps pass in the browser **and** the three test suites are green, Phase 2 is done.

**Phase 3** (next): run lifecycle (approve/post), GL auto-posting, payslip PDFs, real rolling-12-month SDL calculation, Leave module rebuild.

**Phase 4** (then): EMP201 wiring + UI, IRP5 readiness + generation, EMP501 reconciliation.
