# Direct-Client Landing Redirect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A direct (non-bureau) client lands, on login, on a new calm Level-2 home at `/home` showing their company's metric strip + "needs-you" feed; firm-user and onboarding routing are unchanged.

**Architecture:** A pure landing resolver decides the post-login target from two booleans (has-companies, is-bureau-member). The `/home` surface reuses the Phase-2.3 metrics + work-aggregator services and is gated natively by `withAuth` (the active company's `company_users` membership IS the ownership check — no new gate). The metric-strip + feed body is extracted from the bureau client page into a shared `<ClientHomeView>` consumed by both surfaces.

**Tech Stack:** Next.js 14 (pages router), TypeScript, Vitest (node-env, pure-logic only), `@/lib/auth` middleware (`withAuth` / `withUserAuth`), `@/components/ui` primitives.

**Branch:** `feat/direct-client-redirect` (already created; spec committed at `1ad0a9f0`).

**Spec:** `docs/superpowers/specs/2026-06-09-direct-client-redirect-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/auth/resolveLanding.ts` (create) | Pure `resolveDefaultLanding({hasCompanies, isBureauMember})` → path. The tested decision seam. |
| `tests/unit/auth/resolveLanding.test.ts` (create) | Truth-table unit test for the resolver. |
| `pages/api/auth/landing.ts` (create) | `GET`, `withUserAuth`. Computes the two booleans server-side, returns `{ defaultTarget }`. |
| `pages/api/home.ts` (create) | `GET`, `withAuth`. Returns `{ metrics, workItems }` for the active company. |
| `src/components/bureau/ClientHomeView.tsx` (create) | Presentational metric strip + needs-you feed; props `{ metrics, workItems, onOpenItem }`. |
| `pages/bureau/clients/[companyId].tsx` (modify) | Refactor to render `<ClientHomeView>`; keep its own header/back-link/error chrome. |
| `pages/home.tsx` (create) | Direct-client landing page: loads `/api/home`, renders `<ClientHomeView>`. |
| `pages/login.tsx` (modify) | `postLoginRedirect` calls `/api/auth/landing`. |

**Note on nav:** `/home` is intentionally NOT added to `accountingNavConfig.ts`. It is the post-login landing surface, not an accounting module tab; adding it would clutter the 5-tab front door shipped in PR #146. This is a deliberate deviation from the "update nav for every new page" rule, recorded here.

---

## Task 1: Landing resolver (pure)

**Files:**
- Create: `src/lib/auth/resolveLanding.ts`
- Test: `tests/unit/auth/resolveLanding.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/auth/resolveLanding.test.ts
import { describe, it, expect } from 'vitest';
import { resolveDefaultLanding } from '@/lib/auth/resolveLanding';

describe('resolveDefaultLanding', () => {
  it('sends users with no companies to onboarding', () => {
    expect(resolveDefaultLanding({ hasCompanies: false, isBureauMember: false })).toBe('/onboarding');
    expect(resolveDefaultLanding({ hasCompanies: false, isBureauMember: true })).toBe('/onboarding');
  });

  it('sends firm users (a bureau member with companies) to /accounting', () => {
    expect(resolveDefaultLanding({ hasCompanies: true, isBureauMember: true })).toBe('/accounting');
  });

  it('sends direct clients (companies but no bureau) to /home', () => {
    expect(resolveDefaultLanding({ hasCompanies: true, isBureauMember: false })).toBe('/home');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/auth/resolveLanding.test.ts`
Expected: FAIL — `Cannot find module '@/lib/auth/resolveLanding'` / `resolveDefaultLanding is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/auth/resolveLanding.ts
/**
 * Pure post-login landing decision. No I/O — the endpoint that calls this
 * supplies the two booleans (derived from getUserCompanies / listBureausForUser).
 *
 * - No companies        → /onboarding
 * - Bureau member        → /accounting (firm users; unchanged default)
 * - Direct client        → /home (companies but no bureau)
 */
export interface LandingInput {
  hasCompanies: boolean;
  isBureauMember: boolean;
}

export function resolveDefaultLanding(input: LandingInput): string {
  if (!input.hasCompanies) return '/onboarding';
  if (input.isBureauMember) return '/accounting';
  return '/home';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/auth/resolveLanding.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/resolveLanding.ts tests/unit/auth/resolveLanding.test.ts
git commit -m "feat(auth): pure resolveDefaultLanding seam for post-login routing"
```

---

## Task 2: Landing endpoint `GET /api/auth/landing`

**Files:**
- Create: `pages/api/auth/landing.ts`

- [ ] **Step 1: Write the implementation**

```ts
// pages/api/auth/landing.ts
/**
 * GET /api/auth/landing
 *
 * Returns the post-login default landing path for the authenticated user.
 * Auth: withUserAuth (user-scoped — no active company required). The user id
 * comes only from the verified session; no URL input is trusted.
 */
import type { NextApiResponse } from 'next';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { listBureausForUser } from '@/modules/bureau/services/bureauService';
import { resolveDefaultLanding } from '@/lib/auth/resolveLanding';

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const [companies, bureaus] = await Promise.all([
    getUserCompanies(req.user.id),
    listBureausForUser(req.user.id),
  ]);

  const defaultTarget = resolveDefaultLanding({
    hasCompanies: companies.length > 0,
    isBureauMember: bureaus.length > 0,
  });

  return apiResponse.success(res, { defaultTarget });
}

export default withUserAuth(withErrorHandler(handler));
```

- [ ] **Step 2: Verify it type-checks**

Run: `bun run type-check`
Expected: PASS (no errors referencing `pages/api/auth/landing.ts`).

> Verify the exact import names against the bureau client API (`pages/api/bureau/client/[companyId].ts`): it uses `import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth'`. Either path works (`@/lib/auth` re-exports both); match the surrounding convention if type-check complains.

- [ ] **Step 3: Commit**

```bash
git add pages/api/auth/landing.ts
git commit -m "feat(auth): GET /api/auth/landing resolves post-login target"
```

---

## Task 3: Home payload `GET /api/home`

**Files:**
- Create: `pages/api/home.ts`

- [ ] **Step 1: Write the implementation**

```ts
// pages/api/home.ts
/**
 * GET /api/home
 *
 * Level-2 client-home payload for a DIRECT client: { metrics, workItems } for
 * the caller's active company. Auth: withAuth — the active company's
 * company_users membership IS the ownership gate (no URL-supplied id, RLS GUC
 * set). Reuses the bureau metrics + work-aggregator services scoped to the one
 * verified company; the synthetic CompanyMeta has empty bureau labels (the feed
 * SQL is company_id-only and the single-company home ignores the labels).
 */
import type { NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { clientMetricsSnapshot } from '@/modules/bureau/services/bureauClientMetricsService';
import { aggregateBureauWork, type CompanyMeta } from '@/modules/bureau/services/bureauWorkAggregatorService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const companyId = req.companyId;

  const [metrics, work] = await Promise.all([
    clientMetricsSnapshot(companyId),
    aggregateBureauWork(
      [companyId],
      new Map<string, CompanyMeta>([
        [companyId, { bureau_id: '', bureau_name: '', company_id: companyId, company_name: '' }],
      ]),
      new Date(),
    ),
  ]);

  return apiResponse.success(res, { metrics, workItems: work.items });
}

export default withAuth(withErrorHandler(handler as any));
```

- [ ] **Step 2: Verify it type-checks**

Run: `bun run type-check`
Expected: PASS. (`handler as any` matches the project's documented `withAuth(withErrorHandler(handler as any))` pattern; `req.companyId` is set by `withAuth`.)

- [ ] **Step 3: Commit**

```bash
git add pages/api/home.ts
git commit -m "feat(home): GET /api/home returns active-company metrics + work feed"
```

---

## Task 4: Extract `<ClientHomeView>` and refactor the bureau page

This task is a pure presentational refactor of the shipped bureau page plus a new shared component. No behaviour change to the bureau page.

**Files:**
- Create: `src/components/bureau/ClientHomeView.tsx`
- Modify: `pages/bureau/clients/[companyId].tsx`

- [ ] **Step 1: Create the shared component**

```tsx
// src/components/bureau/ClientHomeView.tsx
/**
 * Level-2 client-home BODY: a glanceable metric strip + a "needs you" feed.
 * Presentational only — each consuming page owns its header / error / loading
 * chrome and supplies onOpenItem (the bureau page switches the active company
 * first; the direct /home page is already on its own company).
 */
import { Card, Feed, ActionRow, Money } from '@/components/ui';
import { SEVERITY_BADGE } from '@/components/bureau/severityBadge';
import type { WorkItem } from '@/modules/bureau/services/bureauWorkTypes';
import type { ClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';

const METRIC_CARDS: Array<{ key: keyof ClientMetrics; label: string }> = [
  { key: 'cash', label: 'Cash' },
  { key: 'ar', label: 'Accounts Receivable' },
  { key: 'ap', label: 'Accounts Payable' },
  { key: 'revenueMtd', label: 'Revenue MTD' },
  { key: 'profitMtd', label: 'Profit MTD' },
];

interface ClientHomeViewProps {
  metrics: ClientMetrics;
  workItems: WorkItem[];
  onOpenItem: (item: WorkItem) => void;
}

export function ClientHomeView({ metrics, workItems, onOpenItem }: ClientHomeViewProps) {
  return (
    <div className="p-6 space-y-6">
      {/* Metric strip */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {METRIC_CARDS.map((m) => (
          <Card key={m.key}>
            <div className="text-xs text-[var(--ff-text-tertiary)]">{m.label}</div>
            <Money amount={metrics[m.key]} className="block text-2xl mt-1 text-[var(--ff-text-primary)]" />
          </Card>
        ))}
      </div>

      {/* Needs-you feed */}
      <Feed title="Needs you" empty="All caught up — nothing needs you.">
        {workItems.map((it) => {
          const badge = SEVERITY_BADGE[it.severity];
          const Icon = badge.icon;
          return (
            <ActionRow
              key={`${it.task}-${it.href}`}
              onClick={() => onOpenItem(it)}
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
  );
}
```

- [ ] **Step 2: Refactor the bureau page to consume it**

In `pages/bureau/clients/[companyId].tsx`:

(a) Replace the local `WorkItem` and `ClientMetrics` interface declarations and the `METRIC_CARDS` constant with shared imports. The top-of-file imports become:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { ArrowLeft, AlertCircle, Loader2 } from 'lucide-react';
import { ClientHomeView } from '@/components/bureau/ClientHomeView';
import type { WorkItem } from '@/modules/bureau/services/bureauWorkTypes';
import type { ClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';
```

Delete the in-file `interface WorkItem { … }`, `interface ClientMetrics { … }`, and the `const METRIC_CARDS = [ … ]` block. Keep `interface ClientHomeData { company: { id: string; name: string; bureauName: string }; metrics: ClientMetrics; workItems: WorkItem[]; }` (it now references the imported types).

(b) Remove the now-unused `Card, Feed, ActionRow, Money` and `SEVERITY_BADGE` / `Severity` imports (they moved into `<ClientHomeView>`).

(c) Replace the success-return JSX block `<div className="p-6 space-y-6"> … </div>` (the metric strip + feed) with:

```tsx
        <ClientHomeView
          metrics={data.metrics}
          workItems={data.workItems}
          onOpenItem={(it) => void handleOpen(it)}
        />
```

Leave the header (`<h1>{data.company.name}</h1>` + bureauName), the back-link, and the loading/error branches exactly as they are.

- [ ] **Step 3: Verify it type-checks and lints**

Run: `bun run type-check && bun run lint`
Expected: PASS, no unused-import warnings for the removed `Card`/`Feed`/`ActionRow`/`Money`/`SEVERITY_BADGE`/`Severity` symbols.

- [ ] **Step 4: Commit**

```bash
git add src/components/bureau/ClientHomeView.tsx "pages/bureau/clients/[companyId].tsx"
git commit -m "refactor(bureau): extract shared <ClientHomeView> body from client page"
```

---

## Task 5: The `/home` page

**Files:**
- Create: `pages/home.tsx`

- [ ] **Step 1: Write the page**

```tsx
// pages/home.tsx
/**
 * Direct-Client Home (Level 2) — the post-login landing for a non-bureau client.
 *
 * Shows the active company's glanceable metric strip + "needs you" feed via
 * /api/home (withAuth — the active company is the ownership gate). The active
 * company comes from CompanyContext; a multi-company direct client switches it
 * with the existing company switcher and this page re-fetches.
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { useCompany } from '@/contexts/CompanyContext';
import { apiFetch } from '@/lib/apiFetch';
import { AlertCircle, Loader2 } from 'lucide-react';
import { ClientHomeView } from '@/components/bureau/ClientHomeView';
import type { WorkItem } from '@/modules/bureau/services/bureauWorkTypes';
import type { ClientMetrics } from '@/modules/bureau/services/bureauClientMetricsService';

interface HomeData {
  metrics: ClientMetrics;
  workItems: WorkItem[];
}

export default function HomePage() {
  const router = useRouter();
  const { activeCompany, loading: companiesLoading } = useCompany();
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true); setError('');
    try {
      const res = await apiFetch('/api/home');
      const json = await res.json() as { data?: HomeData; message?: string };
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { void load(); }, [load]);

  if (companiesLoading || (loading && !data)) {
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
        <div className="p-6">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" /> {error || 'We couldn’t load your home right now. Please try again.'}
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">
              {activeCompany?.companyName ?? 'My business'}
            </h1>
            <p className="text-sm text-[var(--ff-text-secondary)]">Here’s what needs you today.</p>
          </div>
        </div>

        <ClientHomeView
          metrics={data.metrics}
          workItems={data.workItems}
          onOpenItem={(it) => void router.push(it.href)}
        />
      </div>
    </AppLayout>
  );
}
```

> `activeCompany.companyName` matches the `CompanyUser`/active-company shape used elsewhere (`getUserCompanies` returns `companyName`). If `useCompany()`'s active-company field differs (e.g. `name`), match the field the bureau page reads — the bureau page uses `activeCompany?.id` for comparisons, so confirm the name field on `CompanyContext`'s active company and use it verbatim.

- [ ] **Step 2: Verify it type-checks, lints, and builds**

Run: `bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pages/home.tsx
git commit -m "feat(home): /home direct-client landing rendering metrics + work feed"
```

---

## Task 6: Wire login to the landing resolver

**Files:**
- Modify: `pages/login.tsx` (the `postLoginRedirect` function, ~line 270)

- [ ] **Step 1: Replace `postLoginRedirect`**

Find the existing function:

```tsx
  // Post-auth redirect: send users with no companies to /onboarding
  const postLoginRedirect = async (): Promise<string> => {
    if (isAdminHost) return returnTo;
    try {
      const res = await fetch('/api/accounting/companies?action=user-companies', {
        credentials: 'include',
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: { items?: unknown[] } };
        const items = body.data?.items;
        if (Array.isArray(items) && items.length === 0) return '/onboarding';
      }
    } catch {
      // Non-fatal — fall through to the configured returnTo
    }
    return returnTo;
  };
```

Replace it with:

```tsx
  // Post-auth redirect. The server resolver decides the default landing
  // (onboarding / firm /accounting / direct /home); an explicit deep-link
  // returnTo still wins, and no-companies always forces onboarding.
  const postLoginRedirect = async (): Promise<string> => {
    if (isAdminHost) return returnTo;
    try {
      const res = await fetch('/api/auth/landing', { credentials: 'include' });
      if (res.ok) {
        const body = (await res.json()) as { data?: { defaultTarget?: string } };
        const target = body.data?.defaultTarget;
        if (target === '/onboarding') return '/onboarding';
        if (returnTo && returnTo !== '/accounting') return returnTo;
        if (target) return target;
      }
    } catch {
      // Non-fatal — fall through to the configured returnTo
    }
    return returnTo;
  };
```

- [ ] **Step 2: Verify it type-checks and lints**

Run: `bun run type-check && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pages/login.tsx
git commit -m "feat(login): route post-login via /api/auth/landing (direct -> /home)"
```

---

## Task 7: Full gate + browser verification

- [ ] **Step 1: Run the full unit suite + build**

Run: `bunx vitest run tests/unit/auth/resolveLanding.test.ts && bun run type-check && bun run lint && bun run build`
Expected: all PASS. (`bun run build` is what the pre-push hook runs; getting it green here avoids a push-time surprise.)

- [ ] **Step 2: Browser verification (record findings)**

Start dev (`bun run dev`, :3200) or verify against the deploy. Confirm:
- A **direct** user (no bureau membership, ≥1 company) logging in lands on `/home`; the metric strip + "needs you" feed render for their company.
- A **firm** user (≥1 bureau) logging in still lands on `/accounting`.
- A user with **no companies** still lands on `/onboarding`.
- `/bureau/clients/[companyId]` renders identically to before the extract (metric strip + feed unchanged; row click still switches company and opens the deep page).
- A deep-link `returnTo` (e.g. `/login?returnTo=/accounting/customers`) for a user with companies still lands on `/accounting/customers`.

> Browser auth gotcha (recurring): the chrome-devtools session may be expired and boss-ghost auto-login can't run while chrome-devtools holds the shared Chrome profile locked. Expect to log in manually. A direct-client test user may need seeding (a user with `company_users` rows but no `bureau_users` row) — coordinate with the user if no such account exists.

- [ ] **Step 3: Commit any verification fixes, then open the PR**

```bash
git push -u origin feat/direct-client-redirect   # pre-push hook runs next build (~3-4 min); use: timeout 420 git push ...
gh pr create --fill --base master
```

---

## Self-Review

**Spec coverage:**
- §Identity model → Task 1 (resolver) + Task 2 (endpoint computes `hasCompanies`/`isBureauMember` from `getUserCompanies`/`listBureausForUser`). ✓
- §Component 1 resolver → Task 1. ✓
- §Component 2 landing endpoint → Task 2. ✓
- §Component 3 login wiring (precedence: admin host / force onboarding / deep-link / default) → Task 6. ✓
- §Component 4 `/api/home` (withAuth gate, synthetic meta, reuse services) → Task 3. ✓
- §Component 5 `/home` page (active-company gating, header from context, own error copy) → Task 5. ✓
- §Component 6 `<ClientHomeView>` extract + bureau refactor → Task 4. ✓
- §Tenant safety (withAuth single-company gate, no URL id, bureau gate untouched) → Tasks 3 & 4 leave the bureau endpoint and its gate untouched. ✓
- §Testing (resolver unit test; build/type-check for glue; browser matrix) → Tasks 1 & 7. ✓
- §Non-goals → nothing in the plan touches firm→cockpit routing, themes, company picker, non-login entry points, or inline actions. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. The two `>` callouts (import-path / active-company field name) are verification prompts against real existing code, not placeholders.

**Type consistency:** `resolveDefaultLanding(LandingInput)` used identically in Tasks 1, 2. `ClientMetrics`/`WorkItem` imported from the same service paths in Tasks 3, 4, 5. `defaultTarget` is the response key in Task 2 and read in Task 6. `req.companyId` (CompanyAuthedRequest) in Task 3 matches the `@/lib/auth` export. `ClientHomeView` props `{ metrics, workItems, onOpenItem }` defined in Task 4, consumed identically in Tasks 4 & 5.
