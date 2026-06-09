# Bureau Client Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Level 2 client "needs you" home — a per-client triage page (5-metric strip + prioritised work feed) a firm user reaches from the bureau roster, fed by one new tenant-guarded bureau endpoint.

**Architecture:** A new `withUserAuth` endpoint re-derives the caller's bureau entitlement server-side (never trusting the URL `companyId`), then returns metrics + the existing cross-client aggregator scoped to a single company. The page composes Phase-1 primitives (`Card`/`Feed`/`ActionRow`/`Money`). The only mutation is the active-company switch that happens when a feed row is clicked to drop *into* the client to work.

**Tech Stack:** Next.js 14 (pages router), TypeScript, `sql` tagged template (`@/lib/neon`, pg-backed Supabase), Vitest (node env), Tailwind + `--ff-*` tokens.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/bureau/services/bureauService.ts` *(modify)* | + `getBureauClientForUser(userId, companyId)` — the tenant gate |
| `src/modules/bureau/services/bureauClientMetricsService.ts` *(create)* | `clientMetricsSnapshot(companyId)` + pure `shapeClientMetrics(rows)` |
| `tests/unit/bureau/bureauClientMetrics.test.ts` *(create)* | unit tests for `shapeClientMetrics` |
| `src/components/bureau/severityBadge.ts` *(create)* | shared `SEVERITY_BADGE` map (extracted from cockpit) |
| `pages/bureau/index.tsx` *(modify)* | import shared `SEVERITY_BADGE` instead of local copy |
| `pages/api/bureau/client/[companyId].ts` *(create)* | GET endpoint: gate → metrics + feed |
| `pages/bureau/clients/[companyId].tsx` *(create)* | the client home page |
| `pages/bureau/clients.tsx` *(modify)* | link each linked-client name to its home |
| `src/modules/bureau/services/.claude.md` *(modify)* | document the new endpoint + tenant invariant |

**Note on TDD scope:** the repo runs Vitest in `environment: 'node'` with no DB and no jsdom/RTL. Only the **pure** `shapeClientMetrics` is unit-tested (Task 2). DB-querying functions (`getBureauClientForUser`, `clientMetricsSnapshot` SQL) and React pages are verified by `bun run type-check` + `bun run build` and the browser spot-check — this matches how the existing cockpit signals are tested. **Do not fabricate DB-backed or component tests.**

---

### Task 1: Tenant gate — `getBureauClientForUser`

**Files:**
- Modify: `src/modules/bureau/services/bureauService.ts`

- [ ] **Step 1: Confirm `CompanyMeta` is importable in this file**

Run: `grep -n "CompanyMeta" src/modules/bureau/services/bureauService.ts`
If there is no import, add near the other type imports at the top of the file:

```typescript
import type { CompanyMeta } from './bureauWorkTypes';
```

- [ ] **Step 2: Add the gate function** at the end of `bureauService.ts`

```typescript
/**
 * Tenant gate for the client home. Re-derives the caller's bureau companies
 * server-side and returns the CompanyMeta for `companyId` ONLY if it is in
 * that set — otherwise null. Never trust a companyId from the URL; pass it
 * through here first. (Same authorization boundary as /api/bureau.)
 */
export async function getBureauClientForUser(
  userId: string,
  companyId: string,
): Promise<CompanyMeta | null> {
  const bureaus = await listBureausForUser(userId);
  if (bureaus.length === 0) return null;
  const bureauIds = bureaus.map((b) => b.id);
  const rows = (await sql`
    SELECT bc.bureau_id, b.name AS bureau_name, bc.company_id, c.name AS company_name
      FROM bureau_companies bc
      JOIN bureaus b ON b.id = bc.bureau_id
      JOIN companies c ON c.id = bc.company_id
     WHERE bc.bureau_id = ANY(${bureauIds}) AND bc.company_id = ${companyId}
     LIMIT 1
  `) as unknown as CompanyMeta[];
  return rows[0] ?? null;
}
```

- [ ] **Step 3: Type-check**

Run: `bun run type-check`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/modules/bureau/services/bureauService.ts
git commit -m "feat(bureau): getBureauClientForUser tenant gate for client home"
```

---

### Task 2: Metrics service + pure shaper (TDD)

**Files:**
- Create: `src/modules/bureau/services/bureauClientMetricsService.ts`
- Test: `tests/unit/bureau/bureauClientMetrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bureau/bureauClientMetrics.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shapeClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';

describe('shapeClientMetrics', () => {
  it('maps numeric inputs and computes profit = revenue - expenses', () => {
    const m = shapeClientMetrics({ cash: 142000, ar: 88000, ap: 31000, revenue: 210000, expenses: 146000 });
    expect(m).toEqual({ cash: 142000, ar: 88000, ap: 31000, revenueMtd: 210000, profitMtd: 64000 });
  });

  it('coerces numeric-string driver values (no NaN)', () => {
    const m = shapeClientMetrics({ cash: '100.50', ar: '0', ap: '25', revenue: '300', expenses: '120' });
    expect(m.cash).toBeCloseTo(100.5, 2);
    expect(m.profitMtd).toBeCloseTo(180, 2);
  });

  it('coalesces null / undefined / non-numeric to 0', () => {
    const m = shapeClientMetrics({ cash: null, ar: undefined, ap: 'x', revenue: null, expenses: null });
    expect(m).toEqual({ cash: 0, ar: 0, ap: 0, revenueMtd: 0, profitMtd: 0 });
  });

  it('profit goes negative when expenses exceed revenue', () => {
    const m = shapeClientMetrics({ cash: 0, ar: 0, ap: 0, revenue: 100, expenses: 250 });
    expect(m.profitMtd).toBe(-150);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- bureauClientMetrics`
Expected: FAIL — `shapeClientMetrics` is not exported / module not found.

- [ ] **Step 3: Write the implementation**

Create `src/modules/bureau/services/bureauClientMetricsService.ts`:

```typescript
/**
 * Client-home metric snapshot for the bureau Level 2 home.
 *
 * The query SHAPES are copied from pages/api/accounting/dashboard-stats.ts so
 * these numbers match the Trial Balance / aging reports. Reads on the
 * RLS-bypassing @/lib/neon pool — the CALLER must have already verified the
 * companyId via getBureauClientForUser (tenant gate). Every query is scoped to
 * the single companyId; this function adds no new tenant surface.
 */
import { sql } from '@/lib/neon';
import { AR_OPEN_STATUSES, AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';

type Scalar = number | string | null | undefined;

export interface ClientMetricsRows {
  cash: Scalar;
  ar: Scalar;
  ap: Scalar;
  revenue: Scalar;
  expenses: Scalar;
}

export interface ClientMetrics {
  cash: number;
  ar: number;
  ap: number;
  revenueMtd: number;
  profitMtd: number;
}

/** Driver-safe coercion: aggregates may arrive as numeric strings; null/NaN → 0. */
function num(v: Scalar): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Pure: maps raw aggregate rows to the metric set; profit = revenue − expenses. */
export function shapeClientMetrics(r: ClientMetricsRows): ClientMetrics {
  const revenueMtd = num(r.revenue);
  const expensesMtd = num(r.expenses);
  return {
    cash: num(r.cash),
    ar: num(r.ar),
    ap: num(r.ap),
    revenueMtd,
    profitMtd: revenueMtd - expensesMtd,
  };
}

export async function clientMetricsSnapshot(companyId: string): Promise<ClientMetrics> {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const [cash, ar, ap, revenue, expenses] = await Promise.all([
    // Cash: GL bank-account balances (matches Trial Balance, not raw bank_transactions)
    sql`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM gl_accounts ga
        LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
        LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          AND je.company_id = ${companyId}::UUID AND je.status = 'posted'
       WHERE ga.account_subtype = 'bank' AND ga.is_active = true AND ga.company_id = ${companyId}::UUID
    `,
    // AR open (same allowlist as arAgingService)
    sql`
      SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM customer_invoices
       WHERE company_id = ${companyId} AND status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
    `,
    // AP open (same allowlist as apAgingService)
    sql`
      SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM supplier_invoices
       WHERE company_id = ${companyId} AND status = ANY(${Array.from(AP_OPEN_STATUSES)}::text[])
    `,
    // Revenue MTD
    sql`
      SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE ga.account_type = 'revenue' AND je.status = 'posted'
         AND je.company_id = ${companyId} AND jl.company_id = ${companyId}::UUID AND je.entry_date >= ${monthStart}
    `,
    // Expenses MTD
    sql`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
       WHERE ga.account_type = 'expense' AND je.status = 'posted'
         AND je.company_id = ${companyId} AND jl.company_id = ${companyId}::UUID AND je.entry_date >= ${monthStart}
    `,
  ]);

  return shapeClientMetrics({
    cash: (cash as Array<{ total: Scalar }>)[0]?.total,
    ar: (ar as Array<{ total: Scalar }>)[0]?.total,
    ap: (ap as Array<{ total: Scalar }>)[0]?.total,
    revenue: (revenue as Array<{ total: Scalar }>)[0]?.total,
    expenses: (expenses as Array<{ total: Scalar }>)[0]?.total,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- bureauClientMetrics`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/bureau/services/bureauClientMetricsService.ts tests/unit/bureau/bureauClientMetrics.test.ts
git commit -m "feat(bureau): client metric snapshot service + pure shaper tests"
```

---

### Task 3: Extract shared `SEVERITY_BADGE`

**Files:**
- Create: `src/components/bureau/severityBadge.ts`
- Modify: `pages/bureau/index.tsx`

- [ ] **Step 1: Create the shared module**

Create `src/components/bureau/severityBadge.ts` (lifted verbatim from the cockpit — urgency colors, intentionally literal, not the StatusBadge set):

```typescript
import { AlertTriangle, Clock, Info } from 'lucide-react';
import type { Severity } from '@/modules/bureau/services/bureauWorkTypes';

// Urgency colors (not record-status tones) — intentionally literal.
export const SEVERITY_BADGE: Record<
  Severity,
  { bg: string; fg: string; icon: typeof AlertTriangle; label: string }
> = {
  overdue:  { bg: 'bg-red-500/10',   fg: 'text-red-400',   icon: AlertTriangle, label: 'Overdue' },
  due_soon: { bg: 'bg-amber-500/10', fg: 'text-amber-400', icon: Clock,         label: 'Due soon' },
  info:     { bg: 'bg-sky-500/10',   fg: 'text-sky-400',   icon: Info,          label: 'Open' },
};
```

- [ ] **Step 2: Use it in the cockpit** — in `pages/bureau/index.tsx`:

Delete the local `const SEVERITY_BADGE: Record<Severity, ...> = { ... };` block (lines ~53–58) and add this import alongside the other `@/components` imports:

```typescript
import { SEVERITY_BADGE } from '@/components/bureau/severityBadge';
```

Remove `AlertTriangle`, `Clock`, `Info` from the `lucide-react` import in this file **only if** they are no longer referenced elsewhere in it (check first: `grep -n "AlertTriangle\|Clock\|Info" pages/bureau/index.tsx`). The local `type Severity` declaration stays — `WorkItem` still uses it.

- [ ] **Step 3: Type-check + build**

Run: `bun run type-check && bun run build`
Expected: PASS. The cockpit renders identically (pure constant move).

- [ ] **Step 4: Commit**

```bash
git add src/components/bureau/severityBadge.ts pages/bureau/index.tsx
git commit -m "refactor(bureau): extract shared SEVERITY_BADGE for reuse by client home"
```

---

### Task 4: API endpoint — `GET /api/bureau/client/[companyId]`

**Files:**
- Create: `pages/api/bureau/client/[companyId].ts`

- [ ] **Step 1: Create the endpoint**

Create `pages/api/bureau/client/[companyId].ts`:

```typescript
/**
 * GET /api/bureau/client/[companyId]
 *
 * Level 2 client home payload: { company, metrics, workItems }.
 * Auth: withUserAuth (user-scoped). The path companyId is NEVER trusted —
 * getBureauClientForUser re-derives entitlement and returns 404 for any id
 * not in the caller's bureau set. Both reads are scoped to that one verified id.
 */
import type { NextApiResponse } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getBureauClientForUser } from '@/modules/bureau/services/bureauService';
import { clientMetricsSnapshot } from '@/modules/bureau/services/bureauClientMetricsService';
import { aggregateBureauWork } from '@/modules/bureau/services/bureauWorkAggregatorService';
import type { CompanyMeta } from '@/modules/bureau/services/bureauWorkTypes';

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req.query;
  if (typeof companyId !== 'string' || companyId.length === 0) {
    return apiResponse.badRequest(res, 'companyId is required');
  }

  const meta = await getBureauClientForUser(req.user.id, companyId);
  if (!meta) {
    return apiResponse.notFound(res, 'Client');
  }

  const [metrics, work] = await Promise.all([
    clientMetricsSnapshot(companyId),
    aggregateBureauWork([companyId], new Map<string, CompanyMeta>([[companyId, meta]]), new Date()),
  ]);

  return apiResponse.success(res, {
    company: { id: companyId, name: meta.company_name, bureauName: meta.bureau_name },
    metrics,
    workItems: work.items,
  });
}

export default withUserAuth(withErrorHandler(handler));
```

- [ ] **Step 2: Verify `methodNotAllowed` exists with this signature**

Run: `grep -n "methodNotAllowed" src/lib/apiResponse.ts`
Expected: a `static methodNotAllowed(res, method, allowed)` — matches the cockpit endpoint's usage. If the signature differs, mirror exactly what `pages/api/bureau/index.ts` does.

- [ ] **Step 3: Type-check + build**

Run: `bun run type-check && bun run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add pages/api/bureau/client/
git commit -m "feat(bureau): GET /api/bureau/client/[companyId] — gated metrics + feed"
```

---

### Task 5: Client home page

**Files:**
- Create: `pages/bureau/clients/[companyId].tsx`

- [ ] **Step 1: Create the page**

Create `pages/bureau/clients/[companyId].tsx`:

```tsx
/**
 * Bureau Client Home (Level 2) — per-client triage for firm users.
 *
 * Reached from the /bureau/clients roster. Shows a glanceable metric strip
 * + a "needs you" feed of this one client's outstanding work. Clicking a row
 * switches the active company and drops into the deep task page to act.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { ArrowLeft, AlertCircle, Loader2 } from 'lucide-react';
import { Card, Feed, ActionRow, Money } from '@/components/ui';
import { SEVERITY_BADGE } from '@/components/bureau/severityBadge';
import type { Severity } from '@/modules/bureau/services/bureauWorkTypes';

interface WorkItem {
  bureauId: string;
  bureauName: string;
  companyId: string;
  companyName: string;
  task: string;
  detail: string;
  dueAt: string | null;
  href: string;
  severity: Severity;
  amount?: number | null;
}

interface ClientMetrics {
  cash: number;
  ar: number;
  ap: number;
  revenueMtd: number;
  profitMtd: number;
}

interface ClientHomeData {
  company: { id: string; name: string; bureauName: string };
  metrics: ClientMetrics;
  workItems: WorkItem[];
}

const METRIC_CARDS: Array<{ key: keyof ClientMetrics; label: string }> = [
  { key: 'cash', label: 'Cash' },
  { key: 'ar', label: 'Accounts Receivable' },
  { key: 'ap', label: 'Accounts Payable' },
  { key: 'revenueMtd', label: 'Revenue MTD' },
  { key: 'profitMtd', label: 'Profit MTD' },
];

export default function BureauClientHomePage() {
  const router = useRouter();
  const companyId = typeof router.query.companyId === 'string' ? router.query.companyId : '';
  const { switchCompany, activeCompany } = useCompany();
  const [data, setData] = useState<ClientHomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setError('');
    try {
      const res = await apiFetch(`/api/bureau/client/${companyId}`);
      const json = await res.json() as { data?: ClientHomeData; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { void load(); }, [load]);

  const handleOpen = async (item: WorkItem) => {
    if (activeCompany?.id !== item.companyId) {
      await switchCompany(item.companyId);
    }
    void router.push(item.href);
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-teal-500" />
        </div>
      </AppLayout>
    );
  }

  if (error || !data) {
    return (
      <AppLayout>
        <div className="p-6 space-y-4">
          <Link href="/bureau/clients" className="inline-flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">
            <ArrowLeft className="h-4 w-4" /> Back to clients
          </Link>
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" /> {error || 'This client is not in your bureau.'}
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4 flex items-center gap-3">
            <Link href="/bureau/clients" className="p-2 rounded-lg hover:bg-[var(--ff-bg-tertiary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">{data.company.name}</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">{data.company.bureauName}</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Metric strip */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {METRIC_CARDS.map((m) => (
              <Card key={m.key}>
                <div className="text-xs text-[var(--ff-text-tertiary)]">{m.label}</div>
                <Money amount={data.metrics[m.key]} className="block text-2xl mt-1 text-[var(--ff-text-primary)]" />
              </Card>
            ))}
          </div>

          {/* Needs-you feed */}
          <Feed title="Needs you" empty="All caught up — nothing needs you.">
            {data.workItems.map((it) => {
              const badge = SEVERITY_BADGE[it.severity];
              const Icon = badge.icon;
              return (
                <ActionRow
                  key={`${it.task}-${it.href}`}
                  onClick={() => void handleOpen(it)}
                  leading={
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>
                      <Icon className="h-3 w-3" /> {badge.label}
                    </span>
                  }
                  title={<span className="font-medium">{it.task}</span>}
                  subtitle={it.detail}
                  amount={it.amount ?? null}
                  meta={it.dueAt ? new Date(it.dueAt).toLocaleDateString() : '—'}
                />
              );
            })}
          </Feed>
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Type-check + build**

Run: `bun run type-check && bun run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pages/bureau/clients/
git commit -m "feat(bureau): Level 2 client home page — metric strip + needs-you feed"
```

---

### Task 6: Wire the roster → client home

**Files:**
- Modify: `pages/bureau/clients.tsx`

- [ ] **Step 1: Make the linked-client name navigate**

In `pages/bureau/clients.tsx`, the **linked clients** table (the `clients.map(...)` block, ~line 198) renders each company name in the first `<td>`. Replace the static name with a `Link` to the home. The unlink button is in a separate `<td>`, so no propagation handling is needed.

Change the first cell of the linked-clients row from:

```tsx
<td className="py-2 px-4 text-[var(--ff-text-primary)] flex items-center gap-2">
  <Building2 className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
  {c.companyName}
</td>
```

to:

```tsx
<td className="py-2 px-4">
  <Link
    href={`/bureau/clients/${c.companyId}`}
    className="inline-flex items-center gap-2 text-[var(--ff-text-primary)] hover:text-teal-400"
  >
    <Building2 className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
    {c.companyName}
  </Link>
</td>
```

Leave the **"Available to link"** table (`linkable.map(...)`) unchanged — those companies aren't bureau clients yet, so they have no home. `Link` is already imported in this file (used for the back arrow and header).

- [ ] **Step 2: Type-check + build**

Run: `bun run type-check && bun run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pages/bureau/clients.tsx
git commit -m "feat(bureau): link roster client name to its Level 2 home"
```

---

### Task 7: Document the new endpoint + tenant invariant

**Files:**
- Modify: `src/modules/bureau/services/.claude.md`

- [ ] **Step 1: Add a note** under the existing tenant-safety / caller-contract section of `src/modules/bureau/services/.claude.md`:

```markdown
## Client home (Level 2)

`getBureauClientForUser(userId, companyId)` is the tenant gate for the per-client
home. It re-derives the caller's bureau companies and returns `CompanyMeta`
only when `companyId` is in that set, else `null`. `GET /api/bureau/client/[companyId]`
calls it first (→ 404 on a non-member id), then reads `clientMetricsSnapshot`
(`bureauClientMetricsService.ts`) + `aggregateBureauWork([companyId])`. Both reads
are scoped to the single verified id — no new tenant surface. The path companyId
is never trusted. Metric SQL shapes are copied from `dashboard-stats` so numbers
match the Trial Balance / aging reports.
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/bureau/services/.claude.md
git commit -m "docs(bureau): document client-home endpoint + tenant gate"
```

---

## Final Verification (after all tasks)

- [ ] `bun run test:unit -- bureauClientMetrics` → PASS
- [ ] `bun run type-check` → PASS
- [ ] `bun run lint` → PASS (no new warnings)
- [ ] `bun run build` → PASS (and `ls .next/standalone/` is FLAT — `server.js` at top; the PR #143 standalone-flat gotcha)
- [ ] Browser spot-check (both themes) via the seed-a-temp-bureau technique (see `project_ui_modernization.md`); then **fully revert the seed**. Verify:
  - roster client name navigates to `/bureau/clients/[id]`;
  - 5 metrics render via `Money` (mono numerals in practitioner, sans in client);
  - feed rows themed; clicking a row switches active company and lands on the deep page;
  - a non-member `companyId` typed into the URL returns the "not in your bureau" state (tenant gate).
- [ ] `/review` (blind) the full diff before PR.

---

## Self-Review (plan vs spec)

- **Spec §1 gate** → Task 1. **§2 metrics** → Task 2. **§3 endpoint** → Task 4. **§4 page** → Task 5. **§5 roster** → Task 6. **§6 badge extract** → Task 3. **Tenant invariant doc** → Task 7. All covered.
- **Types consistent:** `CompanyMeta`, `ClientMetrics`, `ClientMetricsRows`, `WorkItem`, `Severity`, `ClientHomeData` used identically across tasks; `clientMetricsSnapshot` / `shapeClientMetrics` / `getBureauClientForUser` / `SEVERITY_BADGE` names match every reference.
- **No placeholders:** every code step is complete and runnable.
- **TDD honesty:** only the pure shaper is unit-tested; DB + React verified by type-check/build/browser, matching repo convention (called out at the top so the executor doesn't fabricate tests).
