# Bureau Cockpit Reskin — Design (Phase 2, Increment 2)

**Date:** 2026-06-08
**Status:** Approved
**Predecessor:** Phase 2 Increment 1 (accounting signals, PR #141, merged `9adc3978`)
**Spec/plan siblings:** `docs/superpowers/specs/2026-06-08-ui-modernization-design.md`, `docs/superpowers/specs/2026-06-08-bureau-accounting-signals-design.md`

## Goal

Re-express the `/bureau` accountant cockpit using the Phase 1 shared token primitives so it follows the practitioner/client theme axis (today it is hand-rolled markup on raw `--ff-*` variables), plus a thin data-layer extension so the `<Money>` primitive has a real home in the cockpit.

**Behavior is preserved exactly.** No change to: severity filters, bureau filters, click-a-row to switch active company and navigate, direct-user redirect to `/accounting`, loading / error / empty states, or the redirect-when-no-bureaus guard.

## Non-goals

- No new signals (Increment 1 already added unreconciled / bills / VAT / month-end).
- No Level 2 client "needs you" feed, no Library demotion, no parallel-shell feature flag — those are later increments.
- No migration (the amount extension is read-only `SUM` over existing columns).
- No redesign of the page's information architecture — same sections, same order, same actions; only the rendering primitives change.

## Tenant-safety invariant (unchanged, load-bearing)

`/api/bureau` authenticates with `withUserAuth` (user-scoped, NOT per-company `withAuth`), derives `companyIds` from the caller's `bureau_companies`, and aggregates with `company_id = ANY(${companyIds})` on the RLS-bypassing `@/lib/neon` pool. Bureau membership IS the authorization boundary. **Every signal query keeps that filter; pure shapers additionally drop rows whose `company_id` isn't in the `companyMeta` map.** The amount extension adds only aggregate columns to existing, already-scoped queries — it introduces no new query and no new tenant surface. Documented in `src/modules/bureau/services/.claude.md`.

## Components

### 1. Card token reconciliation (shared primitive — `src/components/ui/Card.tsx`)

Card currently uses hardcoded surface/border colors that diverge from the rest of the bureau page and do not follow the theme axis:

| Current | Replace with |
|---|---|
| `bg-white` / `dark:bg-gray-900` (#111827) | `bg-[var(--ff-surface-primary)]` (#fff / #1e293b) |
| `border-gray-200` / `dark:border-white/[0.08]` | `border-[var(--ff-border-primary)]` |
| header/body/footer dividers `border-gray-100` / `dark:border-white/[0.06]` | `border-[var(--ff-border-primary)]` |

Radius already uses `--ff-card-radius`. The `hoverable` shadow/teal accent stays. After this change Card follows light/dark AND practitioner/client.

**Risk & verification:** ~20 pages render `Card`. Light mode is near-identical (#fff / #e5e7eb). Dark mode shifts card surface #111827 → #1e293b (lighter, on-system) — a deliberate, arguably-correcting change. Verify with `bun run build` + a browser spot-check of two or three existing Card-heavy pages (e.g. an accounting report) in dark mode, alongside the bureau page. If the shift reads as wrong on existing pages, fall back to scoping the token surfaces behind a `surface` variant prop and opt the bureau page in — but the default expectation is the direct reconciliation.

### 2. New primitives (`src/components/ui/`)

**`Feed`** — a titled list surface.
```
interface FeedProps {
  title: React.ReactNode;
  action?: React.ReactNode;   // e.g. a "Manage clients" link
  empty?: React.ReactNode;    // rendered when no children
  children?: React.ReactNode; // typically ActionRow[]
}
```
Renders a `Card` with `noPadding`, a header row (`title` left, `action` right) with a bottom divider, then a vertically divided list of children (`divide-y` on `--ff-border-primary`). When `children` is empty (or none), renders `empty` centered with muted text. Theme-aware via Card.

**`ActionRow`** — one clickable work row.
```
interface ActionRowProps {
  leading?: React.ReactNode;       // severity badge / icon
  title: React.ReactNode;          // primary line
  subtitle?: React.ReactNode;      // secondary line
  amount?: number | null;          // rendered via <Money> when present
  meta?: React.ReactNode;          // trailing context (e.g. due date)
  onClick?: () => void;
  className?: string;
}
```
Layout: `[leading] [title / subtitle stack, flex-1] [amount] [meta] [chevron]`. Full-row hover (`hover:bg-[var(--ff-bg-tertiary)]`) and full-row click. Rendered as a `<button>` (or `role="button"` + `tabIndex=0` + Enter/Space) for keyboard accessibility — replacing the current clickable `<tr>` which is not keyboard-focusable. Chevron (`ArrowRight`) is `aria-hidden`. When `amount` is a number, render `<Money amount={amount} />`; when null/undefined, render nothing in that slot.

### 3. Data-layer extension (Money's home)

`WorkItem` (`src/modules/bureau/services/bureauWorkTypes.ts`) gains:
```
amount?: number | null;   // ZAR value when the signal carries one; omitted otherwise
```

Two existing, already-tenant-scoped signal queries gain an aggregate (no migration, read-only):

- **Bills to approve** (`supplier_invoices`): add `SUM(total_amount)::float AS amount_total`. `shapeBillsToApprove` sets `amount: Number(r.amount_total)` = total value awaiting approval.
- **Bank reconciliation** (`bank_transactions`): add `SUM(ABS(amount))::float AS amount_total`. `shapeUnreconciled` sets `amount: Number(r.amount_total)` = total unreconciled value.
- **VAT return due, payroll signals, month-end:** `amount` stays undefined — no clean rand value to surface.

Driver-safety: like the existing `cnt`, the aggregate may arrive as a numeric string over some drivers; shapers call `Number()`. Row interfaces (`BillsRow`, `UnreconciledRow`) gain `amount_total: number | string`.

### 4. Page reskin (`pages/bureau/index.tsx`)

- **Stats strip:** the hand-rolled `StatCard` becomes a compact `Card`. Keep click-to-toggle-severity-filter behavior and the per-severity accent colors (red/amber/sky/purple) — those are semantic status colors, intentionally kept literal, not on the surface-token axis.
- **Work queue:** the `<table>` becomes `<Feed title="Work owed today">` containing one `<ActionRow>` per visible item:
  - `leading` = severity badge (existing `SEVERITY_BADGE` icon + label).
  - `title` = `{task}` · `{companyName}`.
  - `subtitle` = `{detail}`, plus `{bureauName}` when the user has 2+ bureaus.
  - `amount` = `it.amount ?? null` → `<Money>`.
  - `meta` = formatted `dueAt` or `—`.
  - `onClick` = existing `handleOpen(it)`.
  - Empty state = existing copy via `Feed`'s `empty` prop.
- **Bureau filter pills:** unchanged.
- **File size:** stays < 300 lines — extracting `Feed`/`ActionRow` removes the table + `StatCard` markup, net reduction.

## Data flow

`/api/bureau` (unchanged handler) → `aggregateBureauWork` runs the same per-signal queries, now two with an added `SUM` column → shapers attach `amount` to bills + unreconciled items → JSON `WorkItem[]` → page maps each to an `ActionRow` inside a `Feed`; `Money` renders the amount where present.

## Error handling

No new error surface. The page's existing try/catch on `apiFetch('/api/bureau')` and loading/error/empty branches are preserved. SUM over zero rows is handled by the existing `cnt === 0` continue in each shaper (a company with no pending bills produces no row at all). `amount` is defensively coalesced to `null` at the row boundary so a missing aggregate never renders `NaN`.

## Testing

- **Pure unit tests** (`tests/unit/bureau/`, node env — repo has no jsdom/RTL infra):
  - `shapeBillsToApprove` sets `amount` from `amount_total` (number and numeric-string inputs); count-only path still works.
  - `shapeUnreconciled` sets `amount` from `SUM(ABS(amount))`; numeric-string guard.
  - VAT / payroll shapers leave `amount` undefined.
- **type-check + lint + build** (`bun run type-check`, `bun run lint`, `bun run build`).
- **Browser spot-check** (local `:3200`, authed bureau user): bureau cards + rows themed correctly in practitioner and client themes; amounts render via `Money` (mono in practitioner, sans in client); click-a-row still switches company and navigates; two or three existing Card pages look correct in dark mode after the token reconciliation.

## Rollout

Single PR onto `master`, behind no flag (the cockpit already ships; this is a visual evolution). All CI gates green before merge. Production-deploy timing rules apply at merge time (human decision).
