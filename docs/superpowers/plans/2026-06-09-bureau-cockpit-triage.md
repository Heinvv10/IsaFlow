# Bureau Cockpit Client Triage List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-client R/A/G+Blue triage board to the top of the `/bureau` cockpit, above the existing flat work feed, with each row linking into that client's Level 2 home.

**Architecture:** A pure, unit-tested roll-up shaper (`rollupClientTriage`) groups the already-aggregated cross-client work items by company into one R/A/G+Blue light + counts per client, reading the full bureau roster so clear clients appear green. The existing `/api/bureau` endpoint returns this alongside its current payload (no new SQL, no migration). A new presentational `ClientTriageBoard` component renders it on the cockpit; the flat feed and stat strip are untouched.

**Tech Stack:** Next.js 14 pages router, TypeScript, Vitest (node env), Tailwind + CSS-custom-property themes, `@/lib/neon` (pg) — all existing.

**Spec:** `docs/superpowers/specs/2026-06-09-bureau-cockpit-triage-design.md`

---

### Task 1: Pure roll-up shaper `rollupClientTriage`

**Files:**
- Create: `src/modules/bureau/services/bureauClientTriageService.ts`
- Test: `tests/unit/bureau/bureauClientTriage.test.ts`

Extracted into its own file (not added to `bureauWorkAggregatorService.ts`, which is ~247 lines and would breach the 300-line cap). Pure — no DB, no clock.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/bureau/bureauClientTriage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rollupClientTriage } from '@/modules/bureau/services/bureauClientTriageService';
import type { WorkItem, CompanyMeta } from '@/modules/bureau/services/bureauWorkTypes';

function meta(companyId: string, companyName: string, bureauId = 'b1', bureauName = 'Acme Bureau'): CompanyMeta {
  return { company_id: companyId, company_name: companyName, bureau_id: bureauId, bureau_name: bureauName };
}
function item(companyId: string, severity: WorkItem['severity'], companyName = 'X'): WorkItem {
  return {
    bureauId: 'b1', bureauName: 'Acme Bureau', companyId, companyName,
    task: 't', detail: 'd', dueAt: null, href: '/x', severity,
  };
}

describe('rollupClientTriage', () => {
  it('lights red when any item is overdue, with severity counts', () => {
    const rows = rollupClientTriage(
      [item('c1', 'overdue'), item('c1', 'due_soon'), item('c1', 'info')],
      [meta('c1', 'Brightsphere')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: 'c1', companyName: 'Brightsphere',
      light: 'red', overdue: 1, dueSoon: 1, info: 1, total: 3,
    });
  });

  it('lights amber when due_soon present and no overdue', () => {
    const rows = rollupClientTriage([item('c1', 'due_soon'), item('c1', 'info')], [meta('c1', 'H10')]);
    expect(rows[0]!.light).toBe('amber');
  });

  it('lights blue when only info items', () => {
    const rows = rollupClientTriage([item('c1', 'info'), item('c1', 'info')], [meta('c1', 'Acme')]);
    expect(rows[0]).toMatchObject({ light: 'blue', info: 2, total: 2 });
  });

  it('a roster client with no work items appears green', () => {
    const rows = rollupClientTriage([], [meta('c1', 'Velocity Fibre')]);
    expect(rows[0]).toMatchObject({ light: 'green', overdue: 0, dueSoon: 0, info: 0, total: 0 });
  });

  it('sorts by light rank, then overdue desc, then name', () => {
    const rows = rollupClientTriage(
      [
        item('green1', 'info'), // becomes blue
        item('red1', 'overdue'),
        item('red2', 'overdue'), item('red2', 'overdue'),
      ],
      [
        meta('clear1', 'Zeta'),     // green
        meta('green1', 'Acme'),     // blue
        meta('red1', 'Bravo'),      // red, 1 overdue
        meta('red2', 'Alpha'),      // red, 2 overdue
      ],
    );
    expect(rows.map((r) => r.companyName)).toEqual(['Alpha', 'Bravo', 'Acme', 'Zeta']);
  });

  it('carries the correct bureau id/name per row and ignores work for companies absent from the roster', () => {
    const rows = rollupClientTriage(
      [item('c1', 'overdue'), item('ghost', 'overdue')],
      [meta('c1', 'Brightsphere', 'b2', 'North Bureau')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ bureauId: 'b2', bureauName: 'North Bureau', light: 'red', overdue: 1 });
  });

  it('returns [] for an empty roster', () => {
    expect(rollupClientTriage([item('c1', 'overdue')], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test:unit -- bureauClientTriage`
Expected: FAIL — cannot resolve `bureauClientTriageService` / `rollupClientTriage` is not a function.

- [ ] **Step 3: Write minimal implementation**

Create `src/modules/bureau/services/bureauClientTriageService.ts`:

```ts
/**
 * Per-client triage roll-up for the /bureau cockpit board.
 *
 * Pure: no DB, no clock. Groups the already-aggregated cross-client work items
 * by company into a single R/A/G+Blue light + severity counts. Iterates the
 * roster so clear clients (zero work) still produce a green row. Work items
 * whose company is not in the roster are ignored (defence-in-depth, mirrors the
 * aggregator's meta.get guards).
 */
import type { WorkItem, CompanyMeta } from './bureauWorkTypes';

export type TriageLight = 'red' | 'amber' | 'blue' | 'green';

export interface ClientTriage {
  companyId: string;
  companyName: string;
  bureauId: string;
  bureauName: string;
  light: TriageLight;
  overdue: number;
  dueSoon: number;
  info: number;
  total: number;
}

const LIGHT_RANK: Record<TriageLight, number> = { red: 0, amber: 1, blue: 2, green: 3 };

function lightFor(overdue: number, dueSoon: number, info: number): TriageLight {
  if (overdue > 0) return 'red';
  if (dueSoon > 0) return 'amber';
  if (info > 0) return 'blue';
  return 'green';
}

export function rollupClientTriage(workItems: WorkItem[], roster: CompanyMeta[]): ClientTriage[] {
  const rosterIds = new Set(roster.map((r) => r.company_id));
  const counts = new Map<string, { overdue: number; dueSoon: number; info: number }>();
  for (const it of workItems) {
    if (!rosterIds.has(it.companyId)) continue;
    const c = counts.get(it.companyId) ?? { overdue: 0, dueSoon: 0, info: 0 };
    if (it.severity === 'overdue') c.overdue += 1;
    else if (it.severity === 'due_soon') c.dueSoon += 1;
    else c.info += 1;
    counts.set(it.companyId, c);
  }

  const rows: ClientTriage[] = roster.map((r) => {
    const c = counts.get(r.company_id) ?? { overdue: 0, dueSoon: 0, info: 0 };
    return {
      companyId: r.company_id,
      companyName: r.company_name,
      bureauId: r.bureau_id,
      bureauName: r.bureau_name,
      light: lightFor(c.overdue, c.dueSoon, c.info),
      overdue: c.overdue,
      dueSoon: c.dueSoon,
      info: c.info,
      total: c.overdue + c.dueSoon + c.info,
    };
  });

  rows.sort((a, b) => {
    if (LIGHT_RANK[a.light] !== LIGHT_RANK[b.light]) return LIGHT_RANK[a.light] - LIGHT_RANK[b.light];
    if (a.overdue !== b.overdue) return b.overdue - a.overdue;
    return a.companyName.localeCompare(b.companyName);
  });

  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test:unit -- bureauClientTriage`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/modules/bureau/services/bureauClientTriageService.ts tests/unit/bureau/bureauClientTriage.test.ts
git commit -m "feat(bureau): rollupClientTriage pure shaper + tests"
```

---

### Task 2: Return `clientTriage` from `/api/bureau`

**Files:**
- Modify: `pages/api/bureau/index.ts`

- [ ] **Step 1: Add the import**

At the existing import block (after the `aggregateBureauWork` import, lines 16-19), add:

```ts
import { rollupClientTriage } from '@/modules/bureau/services/bureauClientTriageService';
```

- [ ] **Step 2: Return an empty triage in the empty-roster branch**

The current empty-roster branch (line 47) is:

```ts
    return apiResponse.success(res, { bureaus, workItems: [], stats: zeroStats(), companyCount: 0 });
```

Replace with:

```ts
    return apiResponse.success(res, { bureaus, workItems: [], stats: zeroStats(), companyCount: 0, clientTriage: [] });
```

- [ ] **Step 3: Compute and return the roll-up in the main branch**

The current final success return (line 63) is:

```ts
  return apiResponse.success(res, { bureaus, workItems: items, stats, companyCount: companyRows.length });
```

Replace with:

```ts
  const clientTriage = rollupClientTriage(items, companyRows);

  return apiResponse.success(res, { bureaus, workItems: items, stats, companyCount: companyRows.length, clientTriage });
```

- [ ] **Step 4: Verify type-check passes**

Run: `bun run type-check`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add pages/api/bureau/index.ts
git commit -m "feat(bureau): return clientTriage roll-up from /api/bureau"
```

---

### Task 3: `ClientTriageBoard` component

**Files:**
- Create: `src/components/bureau/ClientTriageBoard.tsx`

Presentational only. Reuses the `Feed` card container; each row is a `next/link` (pure navigation — no `switchCompany`, since the Level 2 home is bureau-scoped and runs its own tenant gate). Colours reuse the cockpit's existing red/amber/sky vocabulary plus emerald for green; all on theme tokens.

- [ ] **Step 1: Write the component**

Create `src/components/bureau/ClientTriageBoard.tsx`:

```tsx
/**
 * ClientTriageBoard — the per-client R/A/G+Blue board at the top of the /bureau
 * cockpit. One row per client: a status light, the company name, terse severity
 * counts, and a chevron linking into that client's Level 2 home.
 *
 * Purely presentational — it renders the ClientTriage[] the endpoint already
 * computed (via rollupClientTriage). No data fetching, no company switching.
 */
import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { Feed } from '@/components/ui';
import type { ClientTriage, TriageLight } from '@/modules/bureau/services/bureauClientTriageService';

const LIGHT_DOT: Record<TriageLight, string> = {
  red: 'bg-red-500',
  amber: 'bg-amber-500',
  blue: 'bg-sky-500',
  green: 'bg-emerald-500',
};

/** Compose the terse count line, e.g. "3 overdue · 1 due soon", "8 open", "clear". */
function countLabel(t: ClientTriage): string {
  if (t.total === 0) return 'clear';
  const parts: string[] = [];
  if (t.overdue) parts.push(`${t.overdue} overdue`);
  if (t.dueSoon) parts.push(`${t.dueSoon} due soon`);
  if (t.info) parts.push(`${t.info} open`);
  return parts.join(' · ');
}

export interface ClientTriageBoardProps {
  items: ClientTriage[];
  /** Show the bureau name on each row (only when the user spans 2+ bureaus). */
  showBureau?: boolean;
}

export function ClientTriageBoard({ items, showBureau = false }: ClientTriageBoardProps) {
  return (
    <Feed title="Clients" empty="No clients linked to this bureau yet.">
      {items.map((t) => (
        <Link
          key={`${t.bureauId}-${t.companyId}`}
          href={`/bureau/clients/${t.companyId}`}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ff-bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500"
        >
          <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${LIGHT_DOT[t.light]}`} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-[var(--ff-text-primary)]">{t.companyName}</div>
            {showBureau && <div className="truncate text-xs text-[var(--ff-text-tertiary)]">{t.bureauName}</div>}
          </div>
          <span
            className={`flex-shrink-0 whitespace-nowrap text-xs ${
              t.total === 0 ? 'text-[var(--ff-text-tertiary)]' : 'text-[var(--ff-text-secondary)]'
            }`}
          >
            {countLabel(t)}
          </span>
          <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--ff-text-tertiary)]" aria-hidden="true" />
        </Link>
      ))}
    </Feed>
  );
}

ClientTriageBoard.displayName = 'ClientTriageBoard';
```

- [ ] **Step 2: Verify type-check passes**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/bureau/ClientTriageBoard.tsx
git commit -m "feat(bureau): ClientTriageBoard presentational component"
```

---

### Task 4: Render the board on the cockpit

**Files:**
- Modify: `pages/bureau/index.tsx`

- [ ] **Step 1: Import the component and its type**

After the existing `SEVERITY_BADGE` import (line 23) add:

```tsx
import { ClientTriageBoard } from '@/components/bureau/ClientTriageBoard';
import type { ClientTriage } from '@/modules/bureau/services/bureauClientTriageService';
```

- [ ] **Step 2: Add `clientTriage` to the `DashboardData` interface**

The current interface (lines 46-51) ends with `companyCount?: number;`. Add a field:

```tsx
interface DashboardData {
  bureaus: BureauRef[];
  workItems: WorkItem[];
  stats: { overdue: number; dueSoon: number; info: number; total: number; monthEnd?: { closed: number; total: number } };
  companyCount?: number;
  clientTriage?: ClientTriage[];
}
```

- [ ] **Step 3: Derive the bureau-filtered board items**

Immediately after the existing `visibleItems` `useMemo` (ends at line 91), add a sibling memo:

```tsx
  const visibleTriage = useMemo(() => {
    if (!data?.clientTriage) return [];
    return data.clientTriage.filter((t) => !bureauFilter || t.bureauId === bureauFilter);
  }, [data, bureauFilter]);
```

- [ ] **Step 4: Render the board between the stats strip and the flat feed**

In the JSX, the stats `grid` block ends at line 166 (`</div>`) and the bureau-filter block begins at line 169. The flat `<Feed title="Work owed today" …>` begins at line 191. Insert the board immediately before the `{/* Work queue */}` comment (line 190), so it sits below the bureau filter and above the flat feed:

```tsx
          {/* Per-client triage board */}
          <ClientTriageBoard items={visibleTriage} showBureau={data.bureaus.length > 1} />

          {/* Work queue */}
```

- [ ] **Step 5: Verify type-check and build pass**

Run: `bun run type-check && bun run build`
Expected: PASS — clean type-check, successful production build, `.next/standalone/` flat.

- [ ] **Step 6: Commit**

```bash
git add pages/bureau/index.tsx
git commit -m "feat(bureau): render ClientTriageBoard on the cockpit"
```

---

### Task 5: Module doc + full verification

**Files:**
- Modify: `src/modules/bureau/services/.claude.md`

- [ ] **Step 1: Document the new shaper in the module doc**

Add a short entry under the service list / recent-changes section of `src/modules/bureau/services/.claude.md` describing `bureauClientTriageService.ts` — purpose (pure roll-up of `WorkItem[]` + roster → `ClientTriage[]` for the cockpit board), the 4-tier light rule (red>amber>blue>green), and that it is consumed by `/api/bureau` (server-side) and rendered by `ClientTriageBoard`.

- [ ] **Step 2: Run the full unit suite + lint**

Run: `bun run test:unit -- bureau && bun run lint`
Expected: bureau tests green (including the 7 new triage tests), lint clean (no new warnings).

- [ ] **Step 3: Commit**

```bash
git add src/modules/bureau/services/.claude.md
git commit -m "docs(bureau): document bureauClientTriageService in module doc"
```

- [ ] **Step 4: Open the PR**

```bash
timeout 420 git push -u origin feat/bureau-cockpit-triage
gh pr create --title "feat(bureau): cockpit client triage board (Phase 2.4)" \
  --body "Per-client R/A/G+Blue triage board on /bureau, above the flat feed, linking into the Level 2 client home. Pure server-side roll-up, no migration. Spec: docs/superpowers/specs/2026-06-09-bureau-cockpit-triage-design.md"
```

- [ ] **Step 5: Post-merge (manual, not in this plan's automation):** live browser-verify in both themes via the seed-verify-revert recipe (`~/.claude/skills/browser/references/isaflow-auth-gated-verification.md`) — confirm a red/amber/blue/green spread renders and a row click lands on the correct Level 2 home. Revert the seed afterwards.

---

## Notes for the implementer

- **Branch:** work is on `feat/bureau-cockpit-triage` (already created). Do NOT edit on master.
- **`bun run test:unit -- <pattern>`** filters Vitest by filename substring.
- **No React component tests** — Vitest is `environment: 'node'`, `.test.ts` only. `ClientTriageBoard` is verified by type-check/build/browser, not a unit test. Do not fabricate one.
- **The flat feed, stat strip, and severity stat-card filter are unchanged** — only additive. If a diff touches `visibleItems`, `handleOpen`, or the `<Feed title="Work owed today">` block, that's out of scope for this increment.
- **Row key** uses `${bureauId}-${companyId}` because the same company could in principle be linked to two of the user's bureaus (two rows); company-id alone is not guaranteed unique across the roster.
