# Bureau Cockpit Accounting Signals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped `/bureau` cockpit aggregator with four accounting signals (unreconciled bank transactions, bills to approve, VAT due, month-end progress) across all of a firm's client companies.

**Architecture:** Extract all aggregation SQL out of the 240-line API handler into a new `bureauWorkAggregatorService`. Each signal is a thin SQL wrapper (filters `company_id = ANY(${companyIds})`) plus a pure, unit-tested shaping function. VAT-period derivation is a separate pure helper. The handler stays thin: auth → derive `companyIds` from `bureau_companies` → call the service → respond.

**Tech Stack:** Next.js 14 API route, TypeScript (strict, `noUncheckedIndexedAccess`), `sql` tagged template from `@/lib/neon` (pg-backed, RLS-bypassing pool), Vitest (`environment: 'node'`, `tests/unit/**/*.test.ts`).

**Spec:** `docs/superpowers/specs/2026-06-08-bureau-accounting-signals-design.md`

---

## Tenant-safety invariant (load-bearing — applies to every task)

`@/lib/neon`'s pool bypasses RLS. Isolation rests entirely on `company_id = ANY(${companyIds})`, where `companyIds` is derived **only** from the caller's `bureau_companies`. Every signal wrapper MUST keep that filter; pure shapers MUST drop any row whose `company_id` is absent from the `companyMeta` map. The handler is the single place that derives `companyIds`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/bureau/services/vatPeriodHelper.ts` (create) | Pure: derive the expected just-ended bi-monthly VAT period + due date from alignment + date. |
| `src/modules/bureau/services/bureauWorkAggregatorService.ts` (create) | `WorkItem` type, shared date/severity helpers, all signal wrappers (payroll moved here + 4 accounting), pure shapers, `aggregateBureauWork()`. |
| `src/modules/bureau/services/.claude.md` (create) | Module doc incl. the tenant-safety invariant. |
| `pages/api/bureau/index.ts` (modify) | Slim to: auth → companyIds → `aggregateBureauWork` → respond. Zero SQL. |
| `pages/bureau/index.tsx` (modify) | Render the new `stats.monthEnd` "X/N closed" figure in the stats strip. |
| `tests/unit/bureau/vatPeriodHelper.test.ts` (create) | VAT period derivation. |
| `tests/unit/bureau/bureauSignalShapers.test.ts` (create) | Shapers + tenant-safety guard + month-end reduction. |

---

### Task 1: VAT period helper (pure)

**Files:**
- Create: `src/modules/bureau/services/vatPeriodHelper.ts`
- Test: `tests/unit/bureau/vatPeriodHelper.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/bureau/vatPeriodHelper.test.ts
import { describe, it, expect } from 'vitest';
import { expectedVatPeriodAsOf } from '@/modules/bureau/services/vatPeriodHelper';

describe('expectedVatPeriodAsOf', () => {
  it('odd alignment in June returns the May-ending period', () => {
    // Most recent odd-numbered month fully ended by 2026-06-08 is May (month 5).
    const p = expectedVatPeriodAsOf('odd', new Date('2026-06-08T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-04-01', periodEnd: '2026-05-31', dueDate: '2026-06-25' });
  });

  it('even alignment in June returns the April-ending period', () => {
    const p = expectedVatPeriodAsOf('even', new Date('2026-06-08T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-03-01', periodEnd: '2026-04-30', dueDate: '2026-05-25' });
  });

  it('skips a parity month that has not fully ended yet', () => {
    // 2026-05-15 odd: May has not ended, so the period is the one ending March 31.
    const p = expectedVatPeriodAsOf('odd', new Date('2026-05-15T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2026-02-01', periodEnd: '2026-03-31', dueDate: '2026-04-25' });
  });

  it('wraps across the year boundary', () => {
    // 2026-01-10 odd: most recent odd month-end is November 2025.
    const p = expectedVatPeriodAsOf('odd', new Date('2026-01-10T00:00:00Z'));
    expect(p).toEqual({ periodStart: '2025-10-01', periodEnd: '2025-11-30', dueDate: '2025-12-25' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- vatPeriodHelper`
Expected: FAIL — cannot find module `vatPeriodHelper`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/modules/bureau/services/vatPeriodHelper.ts
/**
 * Pure VAT-period derivation for the bureau cockpit's "VAT due" signal.
 *
 * SA VAT vendors file bi-monthly. `companies.vat_period_alignment` records
 * which month-number parity a vendor's period ENDS on: 'odd' = Category A
 * (periods end Jan/Mar/May/…), 'even' = Category B (Feb/Apr/…). Each period
 * spans two calendar months. Returns are due by the 25th of the month
 * following the period end.
 *
 * NOTE: monthly (Category C) vendors are out of scope this increment — the
 * column only encodes odd/even parity. Treating everyone as bi-monthly is the
 * documented simplification; refine if a monthly flag is added.
 */
export type VatAlignment = 'odd' | 'even';

export interface VatPeriod {
  /** YYYY-MM-DD, first day of the two-month period. */
  periodStart: string;
  /** YYYY-MM-DD, last day of the period (a month of the requested parity). */
  periodEnd: string;
  /** YYYY-MM-DD, 25th of the month after periodEnd. */
  dueDate: string;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function expectedVatPeriodAsOf(alignment: VatAlignment, asOf: Date): VatPeriod {
  const wantOddEnd = alignment === 'odd';
  let y = asOf.getUTCFullYear();
  let m = asOf.getUTCMonth() + 1; // 1..12

  for (let i = 0; i < 13; i++) {
    const lastDay = new Date(Date.UTC(y, m, 0)); // day 0 of month m+1 = last day of month m
    const parityOdd = m % 2 === 1;
    if (parityOdd === wantOddEnd && lastDay.getTime() <= asOf.getTime()) {
      const periodStart = new Date(Date.UTC(y, m - 2, 1)); // first day of the preceding month
      const dueMonth = m === 12 ? 1 : m + 1;
      const dueYear = m === 12 ? y + 1 : y;
      const dueDate = new Date(Date.UTC(dueYear, dueMonth - 1, 25));
      return { periodStart: iso(periodStart), periodEnd: iso(lastDay), dueDate: iso(dueDate) };
    }
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  // Unreachable: within 13 months back we always hit a matching parity month-end.
  throw new Error('expectedVatPeriodAsOf: no period found');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- vatPeriodHelper`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/bureau/services/vatPeriodHelper.ts tests/unit/bureau/vatPeriodHelper.test.ts
git commit -m "feat(bureau): pure VAT period helper for cockpit VAT-due signal"
```

---

### Task 2: Extract aggregator service; move payroll signals; slim handler

This is a behaviour-preserving refactor. Move the `WorkItem` type, the helpers (`formatPeriod`, `endOfNextMonth`, `severityForDate`), and the four payroll queries out of `pages/api/bureau/index.ts` into the new service, exposed via `aggregateBureauWork()`. The handler keeps auth + companyId derivation only.

**Files:**
- Create: `src/modules/bureau/services/bureauWorkAggregatorService.ts`
- Modify: `pages/api/bureau/index.ts`

- [ ] **Step 1: Create the service with the moved code**

```ts
// src/modules/bureau/services/bureauWorkAggregatorService.ts
/**
 * Cross-client work aggregator for the /bureau cockpit.
 *
 * TENANT SAFETY: runs on the RLS-bypassing @/lib/neon pool. Every query MUST
 * filter company_id = ANY(${companyIds}); companyIds is bureau-derived by the
 * caller and is the ONLY company input. Pure shapers drop rows whose
 * company_id is not in the supplied companyMeta map.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export type Severity = 'overdue' | 'due_soon' | 'info';

export interface WorkItem {
  bureauId: string;
  bureauName: string;
  companyId: string;
  companyName: string;
  task: string;
  detail: string;
  dueAt: string | null;
  href: string;
  severity: Severity;
}

export interface CompanyMeta {
  bureau_id: string;
  bureau_name: string;
  company_id: string;
  company_name: string;
}

export interface MonthEndStat {
  closed: number;
  total: number;
}

export interface AggregateResult {
  items: WorkItem[];
  monthEnd: MonthEndStat;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function formatPeriod(month: number, year: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function endOfNextMonth(periodMonth: number, periodYear: number): Date {
  const nextMonth = periodMonth === 12 ? 1 : periodMonth + 1;
  const nextYear = periodMonth === 12 ? periodYear + 1 : periodYear;
  return new Date(nextYear, nextMonth, 0, 23, 59, 59);
}

export function severityForDate(due: Date, today: Date): Severity {
  const days = (due.getTime() - today.getTime()) / (24 * 3600 * 1000);
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due_soon';
  return 'info';
}

// ── Payroll signals (moved verbatim from the handler) ───────────────────────

async function payrollSignals(
  companyIds: string[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): Promise<WorkItem[]> {
  const inThirtyDays = new Date(today.getTime() + 30 * 24 * 3600 * 1000);
  const [pendingRuns, irp5Issues, directives, leave] = await Promise.all([
    sql`
      SELECT pr.id, pr.company_id, pr.period_year, pr.period_month, pr.status
        FROM payroll_run_headers pr
       WHERE pr.company_id = ANY(${companyIds})
         AND pr.status IN ('draft','calculated','approved')
       ORDER BY pr.period_year, pr.period_month
    `,
    sql`
      SELECT pe.company_id, COUNT(*) FILTER (WHERE pe.tax_number IS NULL) AS missing_tax,
                            COUNT(*) FILTER (WHERE pe.id_number IS NULL)  AS missing_id
        FROM payroll_employees pe
       WHERE pe.company_id = ANY(${companyIds})
         AND pe.end_date IS NULL
       GROUP BY pe.company_id
    `,
    sql`
      SELECT td.company_id, COUNT(*)::int AS expiring
        FROM tax_directives td
       WHERE td.company_id = ANY(${companyIds})
         AND td.expiry_date IS NOT NULL
         AND td.expiry_date <= ${inThirtyDays.toISOString().slice(0, 10)}::date
         AND td.expiry_date >= ${today.toISOString().slice(0, 10)}::date
       GROUP BY td.company_id
    `,
    sql`
      SELECT plr.company_id, COUNT(*)::int AS pending
        FROM payroll_leave_requests plr
       WHERE plr.company_id = ANY(${companyIds})
         AND plr.status = 'pending'
       GROUP BY plr.company_id
    `,
  ]);

  const items: WorkItem[] = [];

  for (const r of pendingRuns as Array<{ id: string; company_id: string; period_year: number; period_month: number; status: string }>) {
    const m = meta.get(r.company_id);
    if (!m) continue;
    const dueAt = endOfNextMonth(r.period_month, r.period_year);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: `Pay run · ${r.status}`, detail: formatPeriod(r.period_month, r.period_year),
      dueAt: dueAt.toISOString(), href: `/payroll/runs/${r.id}`, severity: severityForDate(dueAt, today),
    });
  }
  for (const r of irp5Issues as Array<{ company_id: string; missing_tax: string | number; missing_id: string | number }>) {
    const m = meta.get(r.company_id);
    if (!m) continue;
    const missingTax = Number(r.missing_tax); const missingId = Number(r.missing_id);
    if (missingTax === 0 && missingId === 0) continue;
    const parts: string[] = [];
    if (missingTax > 0) parts.push(`${missingTax} missing tax #`);
    if (missingId > 0) parts.push(`${missingId} missing ID`);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'IRP5 readiness', detail: parts.join(' · '), dueAt: null, href: '/payroll/irp5', severity: 'info',
    });
  }
  for (const r of directives as Array<{ company_id: string; expiring: number }>) {
    const m = meta.get(r.company_id);
    if (!m || r.expiring === 0) continue;
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Tax directive renewal', detail: `${r.expiring} expiring within 30 days`,
      dueAt: inThirtyDays.toISOString(), href: '/payroll/tax-directives', severity: 'due_soon',
    });
  }
  for (const r of leave as Array<{ company_id: string; pending: number }>) {
    const m = meta.get(r.company_id);
    if (!m || r.pending === 0) continue;
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Leave approvals', detail: `${r.pending} pending`, dueAt: null, href: '/payroll/leave', severity: 'info',
    });
  }
  return items;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/** Runs one signal, degrading to [] on failure so one bad query can't 500 the cockpit. */
async function safeSignal(name: string, fn: () => Promise<WorkItem[]>): Promise<WorkItem[]> {
  try {
    return await fn();
  } catch (err) {
    // Degrade gracefully — the cockpit still renders the other signals.
    log.warn('bureau signal failed', { signal: name, message: err instanceof Error ? err.message : String(err) }, 'Bureau');
    return [];
  }
}

export async function aggregateBureauWork(
  companyIds: string[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): Promise<AggregateResult> {
  const groups = await Promise.all([
    safeSignal('payroll', () => payrollSignals(companyIds, meta, today)),
  ]);
  const items = groups.flat();
  items.sort((a, b) => {
    const order: Record<Severity, number> = { overdue: 0, due_soon: 1, info: 2 };
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    if (!a.dueAt && !b.dueAt) return a.companyName.localeCompare(b.companyName);
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.localeCompare(b.dueAt);
  });
  return { items, monthEnd: { closed: 0, total: meta.size } };
}
```

- [ ] **Step 2: Slim the handler to call the service**

Replace the body of `pages/api/bureau/index.ts` after `companyMeta` construction. The full new file:

```ts
/**
 * GET /api/bureau
 *
 * Returns the bureaus the current user belongs to + the cross-client work
 * aggregator. All aggregation SQL lives in bureauWorkAggregatorService.
 *
 * Auth: any logged-in user. account_type='direct' users get an empty payload;
 * the page redirects them away.
 */
import type { NextApiResponse } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql } from '@/lib/neon';
import { listBureausForUser } from '@/modules/bureau/services/bureauService';
import {
  aggregateBureauWork,
  type CompanyMeta,
  type WorkItem,
} from '@/modules/bureau/services/bureauWorkAggregatorService';

function zeroStats() {
  return { overdue: 0, dueSoon: 0, info: 0, total: 0, monthEnd: { closed: 0, total: 0 } };
}

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const userId = req.user.id;
  const bureaus = await listBureausForUser(userId);
  if (bureaus.length === 0) {
    return apiResponse.success(res, { bureaus: [], workItems: [], stats: zeroStats() });
  }

  const bureauIds = bureaus.map((b) => b.id);
  const companyRows = (await sql`
    SELECT bc.bureau_id, b.name AS bureau_name, bc.company_id, c.name AS company_name
      FROM bureau_companies bc
      JOIN bureaus b ON b.id = bc.bureau_id
      JOIN companies c ON c.id = bc.company_id
     WHERE bc.bureau_id = ANY(${bureauIds})
     ORDER BY b.name, c.name
  `) as unknown as CompanyMeta[];

  if (companyRows.length === 0) {
    return apiResponse.success(res, { bureaus, workItems: [], stats: zeroStats(), companyCount: 0 });
  }

  const companyIds = companyRows.map((r) => r.company_id);
  const meta = new Map<string, CompanyMeta>(companyRows.map((r) => [r.company_id, r]));

  const { items, monthEnd } = await aggregateBureauWork(companyIds, meta, new Date());

  const stats = {
    overdue: items.filter((i: WorkItem) => i.severity === 'overdue').length,
    dueSoon: items.filter((i: WorkItem) => i.severity === 'due_soon').length,
    info: items.filter((i: WorkItem) => i.severity === 'info').length,
    total: items.length,
    monthEnd,
  };

  return apiResponse.success(res, { bureaus, workItems: items, stats, companyCount: companyRows.length });
}

export default withUserAuth(withErrorHandler(handler));
```

- [ ] **Step 3: Verify type-check and build pass (behaviour preserved)**

Run: `bun run type-check`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/modules/bureau/services/bureauWorkAggregatorService.ts pages/api/bureau/index.ts
git commit -m "refactor(bureau): extract aggregator service; handler holds no SQL"
```

---

### Task 3: Unreconciled-transactions signal

**Files:**
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts`
- Test: `tests/unit/bureau/bureauSignalShapers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/bureau/bureauSignalShapers.test.ts
import { describe, it, expect } from 'vitest';
import {
  shapeUnreconciled,
  type CompanyMeta,
} from '@/modules/bureau/services/bureauWorkAggregatorService';

const meta = new Map<string, CompanyMeta>([
  ['c1', { bureau_id: 'b1', bureau_name: 'Acme Books', company_id: 'c1', company_name: 'Client One' }],
]);

describe('shapeUnreconciled', () => {
  it('emits one info item per company with unreconciled txns', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 14 }], meta);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      companyId: 'c1', companyName: 'Client One', task: 'Bank reconciliation',
      detail: '14 unreconciled', severity: 'info', href: '/accounting/reports/bank-transactions',
    });
  });

  it('drops rows whose company_id is not in the bureau meta map (tenant guard)', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 3 }, { company_id: 'rogue', cnt: 9 }], meta);
    expect(items).toHaveLength(1);
    expect(items[0]!.companyId).toBe('c1');
  });

  it('skips companies with zero unreconciled', () => {
    expect(shapeUnreconciled([{ company_id: 'c1', cnt: 0 }], meta)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: FAIL — `shapeUnreconciled` is not exported.

- [ ] **Step 3: Implement shaper + wrapper, wire into orchestrator**

Add to `bureauWorkAggregatorService.ts`:

```ts
export interface UnreconciledRow { company_id: string; cnt: number | string; }

export function shapeUnreconciled(rows: UnreconciledRow[], meta: Map<string, CompanyMeta>): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    const cnt = Number(r.cnt);
    if (!m || cnt === 0) continue;
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Bank reconciliation', detail: `${cnt} unreconciled`, dueAt: null,
      href: '/accounting/reports/bank-transactions', severity: 'info',
    });
  }
  return items;
}

async function unreconciledSignal(companyIds: string[], meta: Map<string, CompanyMeta>): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT company_id, COUNT(*)::int AS cnt
      FROM bank_transactions
     WHERE company_id = ANY(${companyIds})
       AND status NOT IN ('reconciled','excluded')
     GROUP BY company_id
  `) as unknown as UnreconciledRow[];
  return shapeUnreconciled(rows, meta);
}
```

Add to the `Promise.all` array in `aggregateBureauWork`:

```ts
    safeSignal('unreconciled', () => unreconciledSignal(companyIds, meta)),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/bureau/services/bureauWorkAggregatorService.ts tests/unit/bureau/bureauSignalShapers.test.ts
git commit -m "feat(bureau): unreconciled bank transactions signal"
```

---

### Task 4: Bills-to-approve signal

**Files:**
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts`
- Test: `tests/unit/bureau/bureauSignalShapers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `bureauSignalShapers.test.ts`:

```ts
import { shapeBillsToApprove } from '@/modules/bureau/services/bureauWorkAggregatorService';

describe('shapeBillsToApprove', () => {
  const today = new Date('2026-06-08T00:00:00Z');

  it('flags overdue when the earliest due date is in the past', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 9, earliest_due: '2026-06-01' }], meta, today);
    expect(items[0]).toMatchObject({
      task: 'Bills to approve', detail: '9 awaiting approval', severity: 'overdue',
      href: '/accounting/reports/ap-aging', dueAt: '2026-06-01',
    });
  });

  it('flags due_soon within 7 days and info beyond', () => {
    const soon = shapeBillsToApprove([{ company_id: 'c1', cnt: 2, earliest_due: '2026-06-12' }], meta, today);
    expect(soon[0]!.severity).toBe('due_soon');
    const later = shapeBillsToApprove([{ company_id: 'c1', cnt: 2, earliest_due: '2026-07-30' }], meta, today);
    expect(later[0]!.severity).toBe('info');
  });

  it('treats a null due date as info and dropping unknown companies', () => {
    const items = shapeBillsToApprove(
      [{ company_id: 'c1', cnt: 1, earliest_due: null }, { company_id: 'x', cnt: 5, earliest_due: null }],
      meta, today,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('info');
    expect(items[0]!.dueAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: FAIL — `shapeBillsToApprove` is not exported.

- [ ] **Step 3: Implement shaper + wrapper, wire into orchestrator**

Add to `bureauWorkAggregatorService.ts`:

```ts
export interface BillsRow { company_id: string; cnt: number | string; earliest_due: string | null; }

export function shapeBillsToApprove(rows: BillsRow[], meta: Map<string, CompanyMeta>, today: Date): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    const cnt = Number(r.cnt);
    if (!m || cnt === 0) continue;
    const due = r.earliest_due ? new Date(`${r.earliest_due}T00:00:00Z`) : null;
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Bills to approve', detail: `${cnt} awaiting approval`,
      dueAt: r.earliest_due, href: '/accounting/reports/ap-aging',
      severity: due ? severityForDate(due, today) : 'info',
    });
  }
  return items;
}

async function billsToApproveSignal(companyIds: string[], meta: Map<string, CompanyMeta>, today: Date): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT company_id, COUNT(*)::int AS cnt, MIN(due_date)::text AS earliest_due
      FROM supplier_invoices
     WHERE company_id = ANY(${companyIds})
       AND status = 'pending_approval'
     GROUP BY company_id
  `) as unknown as BillsRow[];
  return shapeBillsToApprove(rows, meta, today);
}
```

Add to the `Promise.all` array in `aggregateBureauWork`:

```ts
    safeSignal('bills', () => billsToApproveSignal(companyIds, meta, today)),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/bureau/services/bureauWorkAggregatorService.ts tests/unit/bureau/bureauSignalShapers.test.ts
git commit -m "feat(bureau): bills-to-approve signal"
```

---

### Task 5: VAT-due signal

Uses `expectedVatPeriodAsOf` (Task 1). "Due" = no `vat_returns` row covers the expected just-ended period for the company.

**Files:**
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts`
- Test: `tests/unit/bureau/bureauSignalShapers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `bureauSignalShapers.test.ts`:

```ts
import { shapeVatDue } from '@/modules/bureau/services/bureauWorkAggregatorService';

describe('shapeVatDue', () => {
  const today = new Date('2026-06-08T00:00:00Z'); // odd period expected: 2026-04-01..2026-05-31, due 2026-06-25

  it('emits an item when no return covers the expected period', () => {
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd' }], [], meta, today);
    expect(items[0]).toMatchObject({
      task: 'VAT return due', detail: 'Apr–May 2026', dueAt: '2026-06-25',
      href: '/accounting/reports/vat-return', severity: 'due_soon',
    });
  });

  it('suppresses the item when a covering return already exists', () => {
    const returns = [{ company_id: 'c1', period_start: '2026-04-01', period_end: '2026-05-31' }];
    expect(shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd' }], returns, meta, today)).toHaveLength(0);
  });

  it('drops companies not in the bureau meta map (tenant guard)', () => {
    const items = shapeVatDue([{ id: 'rogue', vat_period_alignment: 'odd' }], [], meta, today);
    expect(items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: FAIL — `shapeVatDue` is not exported.

- [ ] **Step 3: Implement shaper + wrapper, wire into orchestrator**

Add to `bureauWorkAggregatorService.ts` (note the `expectedVatPeriodAsOf` import):

```ts
import { expectedVatPeriodAsOf, type VatAlignment } from './vatPeriodHelper';

export interface CompanyVatRow { id: string; vat_period_alignment: string | null; }
export interface VatReturnRow { company_id: string; period_start: string; period_end: string; }

function vatDetail(periodStart: string, periodEnd: string): string {
  const s = new Date(`${periodStart}T00:00:00Z`);
  const e = new Date(`${periodEnd}T00:00:00Z`);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${M[s.getUTCMonth()]}–${M[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
}

export function shapeVatDue(
  companies: CompanyVatRow[],
  returns: VatReturnRow[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const c of companies) {
    const m = meta.get(c.id);
    if (!m) continue;
    const alignment: VatAlignment = c.vat_period_alignment === 'even' ? 'even' : 'odd';
    const period = expectedVatPeriodAsOf(alignment, today);
    const covered = returns.some(
      (r) => r.company_id === c.id && r.period_start <= period.periodStart && r.period_end >= period.periodEnd,
    );
    if (covered) continue;
    const due = new Date(`${period.dueDate}T00:00:00Z`);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: c.id, companyName: m.company_name,
      task: 'VAT return due', detail: vatDetail(period.periodStart, period.periodEnd),
      dueAt: period.dueDate, href: '/accounting/reports/vat-return', severity: severityForDate(due, today),
    });
  }
  return items;
}

async function vatDueSignal(companyIds: string[], meta: Map<string, CompanyMeta>, today: Date): Promise<WorkItem[]> {
  const sixMonthsAgo = new Date(today.getTime() - 183 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const [companies, returns] = await Promise.all([
    sql`
      SELECT id, vat_period_alignment
        FROM companies
       WHERE id = ANY(${companyIds})
    ` as unknown as Promise<CompanyVatRow[]>,
    sql`
      SELECT company_id, period_start::text, period_end::text
        FROM vat_returns
       WHERE company_id = ANY(${companyIds})
         AND period_end >= ${sixMonthsAgo}::date
    ` as unknown as Promise<VatReturnRow[]>,
  ]);
  return shapeVatDue(companies, returns, meta, today);
}
```

Add to the `Promise.all` array in `aggregateBureauWork`:

```ts
    safeSignal('vat', () => vatDueSignal(companyIds, meta, today)),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/bureau/services/bureauWorkAggregatorService.ts tests/unit/bureau/bureauSignalShapers.test.ts
git commit -m "feat(bureau): VAT-return-due signal"
```

---

### Task 6: Month-end progress stat

A stat, not a work item: "X of N client periods closed", from `fiscal_periods` joined to the bureau company set, taking the latest period per company.

**Files:**
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts`
- Test: `tests/unit/bureau/bureauSignalShapers.test.ts`

- [ ] **Step 1: Confirm the per-company close source (lookup, ~2 min)**

Run: `grep -niE "company_id|fiscal_year|period_number|status" scripts/migrations/sql/200_accounting_foundation.sql | head; grep -rniE "fiscal_periods|company_id" scripts/migrations/sql/*fiscal* scripts/migrations/sql/2*.sql | grep -i "ALTER TABLE fiscal_periods" | head`
Expected: identify the `company_id` column on `fiscal_periods` (added in a later migration if not in 200). If `fiscal_periods` has no `company_id`, use `periodCloseReadinessService`'s source table instead and adjust the wrapper query in Step 3 accordingly — the pure `reduceMonthEnd` shaper (below) is unaffected.

- [ ] **Step 2: Write the failing test**

Append to `bureauSignalShapers.test.ts`:

```ts
import { reduceMonthEnd } from '@/modules/bureau/services/bureauWorkAggregatorService';

describe('reduceMonthEnd', () => {
  it('counts companies whose latest period is closed/locked', () => {
    const rows = [
      { company_id: 'c1', status: 'closed' },
      { company_id: 'c2', status: 'open' },
      { company_id: 'c3', status: 'locked' },
    ];
    expect(reduceMonthEnd(rows, 4)).toEqual({ closed: 2, total: 4 });
  });

  it('reports zero closed when none are', () => {
    expect(reduceMonthEnd([{ company_id: 'c1', status: 'open' }], 3)).toEqual({ closed: 0, total: 3 });
  });
});
```

- [ ] **Step 3: Implement reducer + wrapper, wire into orchestrator**

Add to `bureauWorkAggregatorService.ts`:

```ts
export interface LatestPeriodRow { company_id: string; status: string; }

export function reduceMonthEnd(rows: LatestPeriodRow[], total: number): MonthEndStat {
  const closed = rows.filter((r) => r.status === 'closed' || r.status === 'locked').length;
  return { closed, total };
}

async function monthEndProgress(companyIds: string[], total: number): Promise<MonthEndStat> {
  // Latest period per company by end_date, then its close status.
  const rows = (await sql`
    SELECT DISTINCT ON (company_id) company_id, status
      FROM fiscal_periods
     WHERE company_id = ANY(${companyIds})
     ORDER BY company_id, end_date DESC
  `) as unknown as LatestPeriodRow[];
  return reduceMonthEnd(rows, total);
}
```

Update `aggregateBureauWork` to compute the real month-end stat (replace the placeholder return):

```ts
export async function aggregateBureauWork(
  companyIds: string[],
  meta: Map<string, CompanyMeta>,
  today: Date,
): Promise<AggregateResult> {
  const [groups, monthEnd] = await Promise.all([
    Promise.all([
      safeSignal('payroll', () => payrollSignals(companyIds, meta, today)),
      safeSignal('unreconciled', () => unreconciledSignal(companyIds, meta)),
      safeSignal('bills', () => billsToApproveSignal(companyIds, meta, today)),
      safeSignal('vat', () => vatDueSignal(companyIds, meta, today)),
    ]),
    monthEndProgress(companyIds, meta.size).catch((err) => {
      log.warn('bureau month-end stat failed', { message: err instanceof Error ? err.message : String(err) }, 'Bureau');
      return { closed: 0, total: meta.size };
    }),
  ]);
  const items = groups.flat();
  items.sort((a, b) => {
    const order: Record<Severity, number> = { overdue: 0, due_soon: 1, info: 2 };
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    if (!a.dueAt && !b.dueAt) return a.companyName.localeCompare(b.companyName);
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.localeCompare(b.dueAt);
  });
  return { items, monthEnd };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/bureau/services/bureauWorkAggregatorService.ts tests/unit/bureau/bureauSignalShapers.test.ts
git commit -m "feat(bureau): month-end close-progress stat"
```

---

### Task 7: Render the month-end stat in the cockpit

**Files:**
- Modify: `pages/bureau/index.tsx`

- [ ] **Step 1: Extend the DashboardData stats type**

In `pages/bureau/index.tsx`, change the `stats` field of `interface DashboardData`:

```ts
  stats: { overdue: number; dueSoon: number; info: number; total: number; monthEnd?: { closed: number; total: number } };
```

(`monthEnd` is optional so the empty/`zeroStats` payloads and any cached client stay type-safe.)

- [ ] **Step 2: Render it in the stats strip**

Find the stats strip (the row rendering `data.stats.overdue` / `dueSoon` / `info`). Add a fourth figure after the existing ones:

```tsx
{data.stats.monthEnd && (
  <div className="flex items-center gap-2">
    <Building2 className="h-4 w-4 text-slate-400" />
    <span className="text-sm text-slate-300">
      Month-end {data.stats.monthEnd.closed}/{data.stats.monthEnd.total} closed
    </span>
  </div>
)}
```

(`Building2` is already imported in this file. Match the exact wrapper/classNames of the adjacent stat figures — copy their structure so spacing is consistent.)

- [ ] **Step 3: Verify type-check passes**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add pages/bureau/index.tsx
git commit -m "feat(bureau): show month-end X/N closed in cockpit stats strip"
```

---

### Task 8: Module doc + final gates

**Files:**
- Create: `src/modules/bureau/services/.claude.md`

- [ ] **Step 1: Write the module doc with the tenant-safety invariant**

```markdown
# bureau/services

Cross-client cockpit for accounting firms (bureaus). `bureauService.ts` = bureau/company/user membership CRUD. `bureauWorkAggregatorService.ts` = the work-queue aggregator. `vatPeriodHelper.ts` = pure bi-monthly VAT period derivation.

## Caller contract
`pages/api/bureau/index.ts` authenticates with `withUserAuth` (user-scoped, NOT per-company `withAuth`), derives `companyIds` from `bureau_companies`, and calls `aggregateBureauWork(companyIds, meta, today)`.

## TENANT SAFETY (load-bearing)
The `@/lib/neon` pool bypasses RLS. Isolation rests entirely on `company_id = ANY(${companyIds})`, where `companyIds` comes ONLY from the caller's `bureau_companies`. Every signal wrapper MUST keep that filter. Pure shapers MUST drop any row whose `company_id` is absent from the supplied `companyMeta` map. Never widen the company set inside a signal.

## Signals
Payroll (pay runs, IRP5, tax directives, leave) + accounting (unreconciled txns, bills to approve, VAT due) emit `WorkItem[]`; month-end emits a `{ closed, total }` stat. Each signal degrades to empty on failure (`safeSignal`) so one bad query can't 500 the cockpit.

## Tests
`tests/unit/bureau/*` — pure shapers, the VAT helper, and the tenant guard (shapers drop unknown company_ids). No DB/RTL (repo vitest is `environment: 'node'`).
```

- [ ] **Step 2: Run the full unit suite and type-check**

Run: `bun run test:unit -- bureau && bun run type-check`
Expected: PASS — vatPeriodHelper (4) + bureauSignalShapers (all) green; no type errors.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: PASS (no new errors; no `console.log`, no empty catch).

- [ ] **Step 4: Commit**

```bash
git add src/modules/bureau/services/.claude.md
git commit -m "docs(bureau): module doc with tenant-safety invariant"
```

---

## Self-Review

- **Spec coverage:** §4 architecture → Task 2 (service extraction, thin handler, no SQL). §5 four signals → Tasks 3 (unreconciled), 4 (bills), 5 (VAT), 6 (month-end stat). §4 month-end response field → Tasks 6–7. §7 graceful degradation → `safeSignal` (Task 2) + per-stat catch (Task 6). §8 testing → Tasks 1,3,4,5,6 unit tests + tenant-guard cases. §9 "<300 lines / no SQL in handler" → Task 2; "every query filters ANY / unit test proves no out-of-set item" → tenant-guard tests in Tasks 3 & 5 + the shaper meta-drop in all. Module rule → Task 8.
- **Placeholder scan:** none — every step has full code or an exact command. Task 6 Step 1 is a genuine source-confirmation lookup with a stated fallback (use `periodCloseReadinessService`'s table), not a placeholder; the pure reducer is unaffected either way.
- **Type consistency:** `WorkItem`, `CompanyMeta`, `MonthEndStat`, `Severity`, `VatAlignment`/`VatPeriod` defined once and reused; shaper names (`shapeUnreconciled`, `shapeBillsToApprove`, `shapeVatDue`, `reduceMonthEnd`) match between tests and implementation; `aggregateBureauWork` signature stable from Task 2 and only its body changes in Task 6.

## Known simplifications (carried from spec, intentional)

- VAT treats all vendors as bi-monthly odd/even (the column only encodes parity). Monthly (Category C) vendors are out of scope this increment.
- "Bills to approve" deep-links to `/accounting/reports/ap-aging` (consistent with the month-end workbench). If a dedicated pending-approval list page is preferred, change the one `href` literal in `shapeBillsToApprove`.
- Unreconciled = `status NOT IN ('reconciled','excluded')`. If `matched` (auto-matched, awaiting batch reconcile) should be excluded, narrow the one `NOT IN` clause in `unreconciledSignal`.
