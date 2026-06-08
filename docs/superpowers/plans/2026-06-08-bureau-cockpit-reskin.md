# Bureau Cockpit Reskin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-express the `/bureau` cockpit on the Phase 1 shared token primitives (Card/Feed/ActionRow/Money) so it follows the practitioner/client theme axis, and extend two signals with a read-only `SUM` so `Money` has a real home.

**Architecture:** Reconcile `Card`'s hardcoded surfaces to `--ff-*` tokens; add two new theme-aware primitives (`Feed`, `ActionRow`); extend `WorkItem` with an optional `amount` populated by `SUM` on the already-tenant-scoped bills + unreconciled queries; rebuild `pages/bureau/index.tsx` to render a `Feed` of `ActionRow`s instead of a `<table>`. Behavior is preserved exactly.

**Tech Stack:** Next.js 14 pages router, TypeScript, Tailwind + `--ff-*` CSS-variable token system, Vitest (node env — no jsdom/RTL), pg via `@/lib/neon` `sql` tagged templates, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-06-08-bureau-cockpit-reskin-design.md`

---

## File Structure

- **Modify** `src/components/ui/Card.tsx` — surface/border colors → `--ff-*` tokens.
- **Create** `src/components/ui/Feed.tsx` — titled list surface (wraps Card).
- **Create** `src/components/ui/ActionRow.tsx` — one clickable work row (uses Money).
- **Modify** `src/components/ui/index.ts` — export Feed + ActionRow + their prop types.
- **Modify** `src/modules/bureau/services/bureauWorkTypes.ts` — add `amount?` to `WorkItem`.
- **Modify** `src/modules/bureau/services/bureauWorkAggregatorService.ts` — `amount_total` on `BillsRow`/`UnreconciledRow`; shapers set `amount`; both SQL queries add a `SUM`.
- **Modify** `tests/unit/bureau/bureauSignalShapers.test.ts` — add amount assertions.
- **Modify** `pages/bureau/index.tsx` — stats tiles onto token surface; work queue → `Feed`/`ActionRow`/`Money`.

No migration (read-only aggregates over existing columns `supplier_invoices.total_amount`, `bank_transactions.amount`).

---

## Task 1: Extend WorkItem and signal row types with `amount`

**Files:**
- Modify: `src/modules/bureau/services/bureauWorkTypes.ts:9-19`
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts:121` and `:151`

- [ ] **Step 1: Add `amount` to `WorkItem`**

In `bureauWorkTypes.ts`, inside the `WorkItem` interface, add the field after `severity`:

```typescript
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
  /** ZAR value when the signal carries one (bills, unreconciled); null/omitted otherwise. */
  amount?: number | null;
}
```

- [ ] **Step 2: Add `amount_total` to the two row interfaces**

In `bureauWorkAggregatorService.ts`, update `UnreconciledRow` (line ~121):

```typescript
export interface UnreconciledRow { company_id: string; cnt: number | string; amount_total?: number | string | null; }
```

and `BillsRow` (line ~151):

```typescript
export interface BillsRow { company_id: string; cnt: number | string; earliest_due: string | null; amount_total?: number | string | null; }
```

(Optional so the existing shaper tests that omit it still type-check; the SQL always supplies it at runtime.)

- [ ] **Step 3: Verify type-check passes**

Run: `bun run type-check`
Expected: PASS (no new errors — shapers don't yet read the field).

- [ ] **Step 4: Commit**

```bash
git add src/modules/bureau/services/bureauWorkTypes.ts src/modules/bureau/services/bureauWorkAggregatorService.ts
git commit -m "feat(bureau): add optional amount to WorkItem + signal rows"
```

---

## Task 2: TDD — `shapeBillsToApprove` populates `amount`

**Files:**
- Modify: `tests/unit/bureau/bureauSignalShapers.test.ts:40-78`
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts:153-168`

- [ ] **Step 1: Write the failing tests**

In `bureauSignalShapers.test.ts`, inside the existing `describe('shapeBillsToApprove', ...)` block, add:

```typescript
  it('sets amount from amount_total (total value awaiting approval)', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 3, earliest_due: null, amount_total: 12500.5 }], meta, today);
    expect(items[0]!.amount).toBe(12500.5);
  });

  it('coerces a string amount_total from the pg driver', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 2, earliest_due: null, amount_total: '900.00' }], meta, today);
    expect(items[0]!.amount).toBe(900);
  });

  it('sets amount to null when amount_total is absent', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 1, earliest_due: null }], meta, today);
    expect(items[0]!.amount).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: FAIL — the three new assertions fail (`amount` is currently `undefined`, not the expected value/null).

- [ ] **Step 3: Implement — set `amount` in the shaper**

In `bureauWorkAggregatorService.ts`, in `shapeBillsToApprove`, change the `items.push({...})` block to compute and include `amount`:

```typescript
export function shapeBillsToApprove(rows: BillsRow[], meta: Map<string, CompanyMeta>, today: Date): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    const cnt = Number(r.cnt);
    if (!m || cnt === 0) continue;
    const due = r.earliest_due ? new Date(`${r.earliest_due}T00:00:00Z`) : null;
    const amount = r.amount_total == null ? null : Number(r.amount_total);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Bills to approve', detail: `${cnt} awaiting approval`,
      dueAt: r.earliest_due, href: '/accounting/reports/ap-aging',
      severity: due ? severityForDate(due, today) : 'info',
      amount,
    });
  }
  return items;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: PASS (all `shapeBillsToApprove` tests green).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/bureau/bureauSignalShapers.test.ts src/modules/bureau/services/bureauWorkAggregatorService.ts
git commit -m "feat(bureau): bills-to-approve signal carries total value (amount)"
```

---

## Task 3: TDD — `shapeUnreconciled` populates `amount`

**Files:**
- Modify: `tests/unit/bureau/bureauSignalShapers.test.ts:14-38`
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts:123-136`

- [ ] **Step 1: Write the failing tests**

In `bureauSignalShapers.test.ts`, inside the existing `describe('shapeUnreconciled', ...)` block, add:

```typescript
  it('sets amount from amount_total (total unreconciled value)', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 14, amount_total: 48230.75 }], meta);
    expect(items[0]!.amount).toBe(48230.75);
  });

  it('coerces a string amount_total from the pg driver', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 7, amount_total: '1200.00' }], meta);
    expect(items[0]!.amount).toBe(1200);
  });

  it('sets amount to null when amount_total is absent', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 3 }], meta);
    expect(items[0]!.amount).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: FAIL — the three new `shapeUnreconciled` assertions fail (`amount` is `undefined`).

- [ ] **Step 3: Implement — set `amount` in the shaper**

In `bureauWorkAggregatorService.ts`, in `shapeUnreconciled`, change the loop body to compute and include `amount`:

```typescript
export function shapeUnreconciled(rows: UnreconciledRow[], meta: Map<string, CompanyMeta>): WorkItem[] {
  const items: WorkItem[] = [];
  for (const r of rows) {
    const m = meta.get(r.company_id);
    const cnt = Number(r.cnt);
    if (!m || cnt === 0) continue;
    const amount = r.amount_total == null ? null : Number(r.amount_total);
    items.push({
      bureauId: m.bureau_id, bureauName: m.bureau_name, companyId: r.company_id, companyName: m.company_name,
      task: 'Bank reconciliation', detail: `${cnt} unreconciled`, dueAt: null,
      href: '/accounting/reports/bank-transactions', severity: 'info',
      amount,
    });
  }
  return items;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test:unit -- bureauSignalShapers`
Expected: PASS (all shaper tests green, ~30 assertions).

- [ ] **Step 5: Commit**

```bash
git add tests/unit/bureau/bureauSignalShapers.test.ts src/modules/bureau/services/bureauWorkAggregatorService.ts
git commit -m "feat(bureau): unreconciled signal carries total value (amount)"
```

---

## Task 4: Add `SUM` to the two signal SQL queries

**Files:**
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts:138-147` (unreconciledSignal)
- Modify: `src/modules/bureau/services/bureauWorkAggregatorService.ts:170-179` (billsToApproveSignal)

No new unit test — these are DB-bound functions verified by build/type-check; the pure shapers (Tasks 2–3) already cover the amount math.

- [ ] **Step 1: Add `SUM(ABS(amount))` to `unreconciledSignal`**

Replace the query in `unreconciledSignal`:

```typescript
async function unreconciledSignal(companyIds: string[], meta: Map<string, CompanyMeta>): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT company_id, COUNT(*)::int AS cnt, SUM(ABS(amount))::float AS amount_total
      FROM bank_transactions
     WHERE company_id = ANY(${companyIds})
       AND status NOT IN ('reconciled','matched','excluded')
     GROUP BY company_id
  `) as unknown as UnreconciledRow[];
  return shapeUnreconciled(rows, meta);
}
```

- [ ] **Step 2: Add `SUM(total_amount)` to `billsToApproveSignal`**

Replace the query in `billsToApproveSignal`:

```typescript
async function billsToApproveSignal(companyIds: string[], meta: Map<string, CompanyMeta>, today: Date): Promise<WorkItem[]> {
  const rows = (await sql`
    SELECT company_id, COUNT(*)::int AS cnt, MIN(due_date)::text AS earliest_due, SUM(total_amount)::float AS amount_total
      FROM supplier_invoices
     WHERE company_id = ANY(${companyIds})
       AND status = 'pending_approval'
     GROUP BY company_id
  `) as unknown as BillsRow[];
  return shapeBillsToApprove(rows, meta, today);
}
```

- [ ] **Step 3: Verify type-check + unit tests**

Run: `bun run type-check && bun run test:unit -- bureauSignalShapers`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/bureau/services/bureauWorkAggregatorService.ts
git commit -m "feat(bureau): sum bill + unreconciled value in signal queries"
```

---

## Task 5: Reconcile Card surfaces to `--ff-*` tokens

**Files:**
- Modify: `src/components/ui/Card.tsx:46-66` (root), `:56`, `:64` (header/footer), `:115` (CardFooter)

No unit test (styling-only primitive; repo has no jsdom/RTL). Verified by build + browser spot-check.

- [ ] **Step 1: Replace root Card surface classes**

In `Card.tsx`, the root `cn(...)` first two lines become token-driven (drop the hardcoded gray/white and the dark: overrides — the tokens already encode both themes):

```typescript
    <div
      className={cn(
        'border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] shadow-[0_1px_3px_rgba(0,0,0,0.06)]',
        hoverable && 'cursor-pointer transition-shadow hover:shadow-[0_4px_12px_rgba(0,0,0,0.12)] hover:border-teal-500/30',
        className
      )}
      style={{ borderRadius: 'var(--ff-card-radius)', ...style }}
      {...props}
    >
```

- [ ] **Step 2: Replace header divider (in root Card)**

The header wrapper `div` (line ~56) divider class:

```typescript
      {header && (
        <div className="border-b border-[var(--ff-border-primary)] px-5 py-4">
          {header}
        </div>
      )}
```

- [ ] **Step 3: Replace footer divider (in root Card)**

The footer wrapper `div` (line ~64):

```typescript
      {footer && (
        <div className="border-t border-[var(--ff-border-primary)] px-5 py-4">
          {footer}
        </div>
      )}
```

- [ ] **Step 4: Replace `CardHeader` text colors**

In `CardHeader`, swap the hardcoded grays for tokens:

```typescript
      <div>
        <div className="text-base font-semibold text-[var(--ff-text-primary)]">
          {title}
        </div>
        {description && (
          <p className="mt-0.5 text-sm text-[var(--ff-text-secondary)]">{description}</p>
        )}
      </div>
```

- [ ] **Step 5: Replace `CardFooter` divider**

In `CardFooter` (line ~115):

```typescript
    <div
      className={cn(
        'border-t border-[var(--ff-border-primary)] px-5 py-4',
        className
      )}
      {...props}
    >
```

- [ ] **Step 6: Verify build**

Run: `bun run build`
Expected: PASS (compiles; no type errors).

- [ ] **Step 7: Browser spot-check (manual, before commit)**

Start `bun run dev` (`:3200`), open an existing Card-heavy page (e.g. `/accounting/reports/...`) in dark mode and confirm cards render on the on-system `#1e293b` surface (not the old darker `#111827`) and look correct. If acceptable, proceed.

- [ ] **Step 8: Commit**

```bash
git add src/components/ui/Card.tsx
git commit -m "refactor(ui): Card surfaces follow --ff-* token axis (light/dark + theme)"
```

---

## Task 6: Create the `Feed` primitive

**Files:**
- Create: `src/components/ui/Feed.tsx`
- Modify: `src/components/ui/index.ts:24` (after Card export)

No unit test (presentational; verified by build + page usage).

- [ ] **Step 1: Write `Feed.tsx`**

```typescript
/**
 * Feed — a titled list surface for a stream of rows (typically ActionRow).
 * Theme-aware via Card; renders an empty state when it has no children.
 *
 * Usage:
 *   <Feed title="Work owed today" empty="All caught up.">
 *     {items.map((i) => <ActionRow key={i.id} ... />)}
 *   </Feed>
 */
import * as React from 'react';
import { Card } from './Card';

export interface FeedProps {
  title: React.ReactNode;
  /** Optional control rendered on the right of the header (e.g. a link). */
  action?: React.ReactNode;
  /** Rendered centered when there are no children. */
  empty?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function Feed({ title, action, empty, children, className }: FeedProps) {
  const isEmpty = React.Children.count(children) === 0;
  return (
    <Card noPadding className={className}>
      <div className="flex items-center justify-between gap-4 border-b border-[var(--ff-border-primary)] px-4 py-3">
        <h2 className="text-sm font-medium text-[var(--ff-text-primary)]">{title}</h2>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
      {isEmpty ? (
        <div className="px-4 py-12 text-center text-sm text-[var(--ff-text-tertiary)]">{empty}</div>
      ) : (
        <div className="divide-y divide-[var(--ff-border-primary)]">{children}</div>
      )}
    </Card>
  );
}

Feed.displayName = 'Feed';
```

- [ ] **Step 2: Export from the barrel**

In `src/components/ui/index.ts`, after the Card export block, add:

```typescript
export { Feed } from './Feed';
export type { FeedProps } from './Feed';
```

- [ ] **Step 3: Verify type-check**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/Feed.tsx src/components/ui/index.ts
git commit -m "feat(ui): Feed primitive — titled list surface"
```

---

## Task 7: Create the `ActionRow` primitive

**Files:**
- Create: `src/components/ui/ActionRow.tsx`
- Modify: `src/components/ui/index.ts` (after Feed export)

No unit test (presentational; verified by build + page usage).

- [ ] **Step 1: Write `ActionRow.tsx`**

```typescript
/**
 * ActionRow — one clickable row inside a Feed: leading badge, title/subtitle
 * stack, optional ZAR amount (via Money), trailing meta + chevron.
 * Rendered as a <button> so it is keyboard-focusable and activatable.
 */
import * as React from 'react';
import { ArrowRight } from 'lucide-react';
import { Money } from './Money';
import { cn } from '@/utils/cn';

export interface ActionRowProps {
  /** Leading element — typically a severity badge or icon. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** ZAR amount; rendered via <Money> when a number, hidden when null/undefined. */
  amount?: number | null;
  /** Trailing context, e.g. a due date. */
  meta?: React.ReactNode;
  onClick?: () => void;
  className?: string;
}

export function ActionRow({ leading, title, subtitle, amount, meta, onClick, className }: ActionRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
        'hover:bg-[var(--ff-bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500/40',
        className,
      )}
    >
      {leading && <div className="flex-shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-[var(--ff-text-primary)]">{title}</div>
        {subtitle && <div className="truncate text-xs text-[var(--ff-text-tertiary)]">{subtitle}</div>}
      </div>
      {amount != null && (
        <Money amount={amount} className="flex-shrink-0 text-sm text-[var(--ff-text-secondary)]" />
      )}
      {meta && (
        <div className="flex-shrink-0 whitespace-nowrap text-sm text-[var(--ff-text-secondary)]">{meta}</div>
      )}
      <ArrowRight className="h-4 w-4 flex-shrink-0 text-[var(--ff-text-tertiary)]" aria-hidden="true" />
    </button>
  );
}

ActionRow.displayName = 'ActionRow';
```

- [ ] **Step 2: Export from the barrel**

In `src/components/ui/index.ts`, after the Feed export, add:

```typescript
export { ActionRow } from './ActionRow';
export type { ActionRowProps } from './ActionRow';
```

- [ ] **Step 3: Verify type-check**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/ActionRow.tsx src/components/ui/index.ts
git commit -m "feat(ui): ActionRow primitive — clickable work row with Money slot"
```

---

## Task 8: Reskin `pages/bureau/index.tsx`

**Files:**
- Modify: `pages/bureau/index.tsx` — imports, `WorkItem` interface, stats tiles, work queue, `StatCard`.

No unit test (page glue; the page's data shapers are unit-tested, React glue verified by build).

- [ ] **Step 1: Update imports + `WorkItem` interface**

Add the primitives to the imports near the top and drop `ArrowRight` (now owned by ActionRow) — keep the other lucide icons:

```typescript
import { Feed, ActionRow } from '@/components/ui';
import {
  Briefcase, AlertCircle, Loader2, Clock, AlertTriangle, Info,
  Building2, Filter,
} from 'lucide-react';
```

In the local `WorkItem` interface, add `amount` so the API field flows through:

```typescript
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
```

- [ ] **Step 2: Replace the work-queue block (the `<div>` wrapping the `<table>`)**

Replace the entire "Work queue" block (currently the `rounded-lg border ... overflow-hidden` div containing the header + table/empty branches) with a `Feed` of `ActionRow`s:

```tsx
          {/* Work queue */}
          <Feed
            title="Work owed today"
            empty={
              data.stats.total === 0
                ? 'No outstanding work — every client is up to date.'
                : 'No items match these filters.'
            }
          >
            {visibleItems.map((it, idx) => {
              const badge = SEVERITY_BADGE[it.severity];
              const Icon = badge.icon;
              return (
                <ActionRow
                  key={`${it.companyId}-${it.task}-${idx}`}
                  onClick={() => void handleOpen(it)}
                  leading={
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${badge.bg} ${badge.fg}`}>
                      <Icon className="h-3 w-3" /> {badge.label}
                    </span>
                  }
                  title={
                    <>
                      <span className="font-medium">{it.task}</span>
                      <span className="text-[var(--ff-text-tertiary)]"> · {it.companyName}</span>
                    </>
                  }
                  subtitle={
                    data.bureaus.length > 1
                      ? `${it.detail} · ${it.bureauName}`
                      : it.detail
                  }
                  amount={it.amount ?? null}
                  meta={it.dueAt ? new Date(it.dueAt).toLocaleDateString() : '—'}
                />
              );
            })}
          </Feed>
```

- [ ] **Step 3: Rewrite `StatCard` onto the shared token surface**

Replace the `StatCard` function at the bottom of the file. It stays a `<button>` (keyboard-accessible filter toggle) but adopts the Card token surface + radius so it is visually unified with the reconciled `Card`/`Feed`:

```tsx
function StatCard({ label, value, color, onClick, active, icon }: {
  label: string;
  value: number | string;
  color: string;
  onClick?: () => void;
  active?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{ borderRadius: 'var(--ff-card-radius)' }}
      className={`text-left p-4 border transition-colors ${active
        ? 'border-purple-500 bg-purple-500/5'
        : 'border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] ' + (onClick ? 'hover:bg-[var(--ff-bg-tertiary)] cursor-pointer' : 'cursor-default')}`}
    >
      <div className="text-xs text-[var(--ff-text-tertiary)]">{label}</div>
      <div className={`inline-flex items-center gap-1 text-2xl mt-1 ${color}`} style={{ fontFamily: 'var(--ff-num-font)' }}>
        {icon && <span aria-hidden="true">{icon}</span>}
        <span>{value}</span>
      </div>
    </button>
  );
}
```

(Drops the literal `font-mono` for the themed `--ff-num-font`, and `rounded-lg` for `--ff-card-radius`, matching Card/Feed.)

- [ ] **Step 4: Verify type-check, lint, build**

Run: `bun run type-check && bun run lint && bun run build`
Expected: PASS. Confirm the file is still under 300 lines: `wc -l pages/bureau/index.tsx`.

- [ ] **Step 5: Commit**

```bash
git add pages/bureau/index.tsx
git commit -m "feat(bureau): cockpit work queue on Feed/ActionRow/Money primitives"
```

---

## Task 9: Full verification + browser spot-check

**Files:** none (verification only).

- [ ] **Step 1: Run the unit suite**

Run: `bun run test:unit -- bureau`
Expected: PASS (all bureau shaper tests, including the new amount assertions).

- [ ] **Step 2: Full gates**

Run: `bun run type-check && bun run lint && bun run build`
Expected: all PASS.

- [ ] **Step 3: Browser spot-check (`:3200`, authed bureau user)**

Verify, in both themes (toggle `localStorage['isaflow.themeMode']` practitioner ↔ client, or via the in-app toggle):
- Stat tiles and the work-queue Feed render on the on-system `--ff-surface-primary` surface with the themed radius (6px practitioner / 12px client).
- `Money` amounts appear on Bills-to-approve and Bank-reconciliation rows (mono numerals in practitioner, sans in client); count-only rows (VAT, payroll) show no amount.
- Clicking a row still switches the active company and navigates to the row's `href`.
- Rows are keyboard-focusable (Tab) and activate on Enter/Space.
- Spot-check one existing Card page in dark mode for no visual regression from Task 5.

- [ ] **Step 4: Push branch + open PR**

```bash
git push -u origin feat/bureau-cockpit-reskin
gh pr create --title "feat(bureau): reskin cockpit onto Card/Feed/ActionRow/Money (Phase 2.2)" \
  --body "Reskins /bureau onto the Phase 1 token primitives. Reconciles Card surfaces to --ff-* tokens; adds Feed + ActionRow primitives; extends bills + unreconciled signals with a read-only SUM so Money has a home. Behavior preserved. Spec: docs/superpowers/specs/2026-06-08-bureau-cockpit-reskin-design.md"
```

(Note: `git push` may hang after the ref updates on this machine — verify success with `git ls-remote --heads origin feat/bureau-cockpit-reskin` and use `gh` for PR creation.)

---

## Self-Review

**Spec coverage:**
- Card token reconciliation → Task 5 ✓
- Feed primitive → Task 6 ✓
- ActionRow primitive → Task 7 ✓
- `WorkItem.amount` + bills SUM + unreconciled SUM → Tasks 1–4 ✓
- VAT/payroll leave amount undefined → no change to those shapers (Tasks 2–3 only touch bills/unreconciled) ✓
- Page reskin (stats + queue + Money) → Task 8 ✓
- Behavior preserved (filters, handleOpen, redirect, empty/loading/error) → Task 8 keeps `visibleItems`, `handleOpen`, `SEVERITY_BADGE`, the bureau pills, and the loading/error/redirect branches untouched ✓
- Tests (pure shaper amount math) → Tasks 2–3 ✓
- No migration → confirmed (Task 4 is read-only aggregates) ✓

**Type consistency:** `amount?: number | null` on both the service `WorkItem` (Task 1) and the page `WorkItem` (Task 8); `amount_total?: number | string | null` on `BillsRow`/`UnreconciledRow` (Task 1) read by shapers (Tasks 2–3) and supplied by SQL (Task 4). `FeedProps`/`ActionRowProps` names match between component, barrel export, and page usage. `Money`'s `amount: number` prop is fed a non-null number (ActionRow guards `amount != null`).

**Placeholder scan:** none — every code step shows full content.
