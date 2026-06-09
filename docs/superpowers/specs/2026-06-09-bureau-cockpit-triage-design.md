# Bureau Cockpit — Client Triage List — Design

**Date:** 2026-06-09
**Status:** Approved (design) — ready for implementation planning
**Phase:** UI Modernization Phase 2 / Increment 4 (cockpit client triage list)
**Predecessor:** Increment 3 (Level 2 client home, PR #144 / `75622f33`) — this increment's click destination.

---

## 1. Problem

The `/bureau` cockpit today lands firm users on a **flat, cross-client work queue** ("Work owed today") with a severity stat strip above it. It answers "what's the next task across all my clients?" well, but it does **not** answer the practice-level question the modernization spec (§3.1) calls for: *"which clients need me, and which are clear?"* There is no per-client roll-up — a bookkeeper can't scan the roster and see Brightsphere is on fire while Velocity Fibre is fine.

The Level 2 client home (`/bureau/clients/[companyId]`) shipped in Increment 3 is the natural destination for "drill into this client", but nothing on the cockpit points at it as a triage entry point.

## 2. Goal

Add a **per-client R/A/G(+Blue) triage board** to the top of the cockpit, above the existing flat feed. Each row summarises one client's outstanding work as a single light + terse counts, and links into that client's Level 2 home. The flat feed is retained below — both surfaces coexist (faithful to modernization spec §3.1, which lists status strip + triage list + work queue together).

## 3. Design decisions (locked with user)

1. **Layout:** triage board **on top**, existing flat "Work owed today" feed **retained below**. Nothing removed.
2. **Board shows ALL clients** — including clear/green ones with zero work (the "scan the board, see who's clear" value). This requires the endpoint to return the full bureau roster, not just a count.
3. **4-tier light rule**, reusing the cockpit's existing stat-strip colour vocabulary (Overdue/Due-soon/Open/Total):
   - 🔴 `red` = any overdue item
   - 🟡 `amber` = any due-soon item (and no overdue)
   - 🔵 `blue` = only info-severity items (e.g. unreconciled txns, IRP5 readiness, leave approvals — no deadline)
   - 🟢 `green` = zero outstanding items
4. **Roll-up happens server-side** as a pure, unit-tested shaper (matches the node-only Vitest infra and Increment 3's `shapeClientMetrics` pattern). The page just renders.
5. **Filter interaction:**
   - The **bureau filter** (shown when the user has 2+ bureaus) filters **both** the board and the flat feed.
   - The **severity stat-card filter** stays scoped to the **flat feed only**. The board is the always-on overview; filtering it by severity would fight its at-a-glance purpose.

## 4. Architecture

### 4.1 Pure shaper — `rollupClientTriage(workItems, roster)`
New export in `src/modules/bureau/services/bureauWorkAggregatorService.ts` (or a small sibling if the file approaches the 300-line cap — see §7).

```ts
interface ClientTriage {
  companyId: string;
  companyName: string;
  bureauId: string;
  bureauName: string;
  light: 'red' | 'amber' | 'blue' | 'green';
  overdue: number;   // count of overdue work items
  dueSoon: number;   // count of due_soon work items
  info: number;      // count of info work items
  total: number;     // overdue + dueSoon + info
}

function rollupClientTriage(
  workItems: WorkItem[],
  roster: CompanyMeta[],
): ClientTriage[];
```

- Iterates `roster` so **every** client produces a row (clear clients → green). `workItems` are grouped by `companyId` and counted by severity.
- `light` precedence: `overdue>0 → red`; else `dueSoon>0 → amber`; else `info>0 → blue`; else `green`.
- Sort: light rank (red=0, amber=1, blue=2, green=3), then `overdue` desc, then `companyName` asc.
- Pure: no DB, no clock. Reads only its two inputs. Drops/ignores work items whose `companyId` is not in `roster` (defence-in-depth, mirrors the existing `meta.get` guards).

### 4.2 Endpoint — `pages/api/bureau/index.ts`
The handler already builds `companyRows` (the full roster) and the aggregated `items`. Add one line to the success payload:

```ts
clientTriage: rollupClientTriage(items, companyRows)
```

`bureaus`, `workItems`, `stats`, `companyCount` are unchanged (the flat feed and stat strip still consume them). The empty-roster branch returns `clientTriage: []`. **No new SQL, no migration.**

### 4.3 Page + component
- New `src/components/bureau/ClientTriageBoard.tsx` — renders the board section.
  - Props: `{ items: ClientTriage[] }`.
  - Each row: a light dot (colour by `light`) + company name + a terse count line + a chevron, wrapped in `Link href={/bureau/clients/${companyId}}`.
  - Count copy: red/amber/blue compose from non-zero counts (e.g. "3 overdue · 1 due soon", "8 to reconcile"); green → "clear".
  - Bureau name shown on the subtitle only when the user has 2+ bureaus (same convention as the flat feed).
  - Colours reuse the existing tokens: red-400 / amber-400 / sky-400 / text-primary, on `var(--ff-surface-primary)` cards — inherits both themes automatically.
- `pages/bureau/index.tsx` — add `clientTriage` to the `DashboardData` interface; render `<ClientTriageBoard>` between the stats strip and the flat `<Feed>`. Apply the bureau filter to the board's items (client-side `filter` on `bureauId`, same as the feed). The board is a `Link`-based navigation (no `switchCompany` needed — the Level 2 home is bureau-scoped and does its own tenant gate).

## 5. Data flow

```
GET /api/bureau
  → listBureausForUser(userId)                    [existing]
  → SELECT roster (companyRows)                    [existing]
  → aggregateBureauWork(companyIds, meta, now)     [existing] → items
  → rollupClientTriage(items, companyRows)         [NEW, pure] → clientTriage
  → { bureaus, workItems: items, stats, companyCount, clientTriage }

Page:
  board   ← clientTriage  (filtered by selected bureau)
  feed    ← workItems     (filtered by selected bureau AND severity stat-card)
  click row → /bureau/clients/[companyId]  (Level 2 home; own tenant gate)
```

## 6. Error handling

- `rollupClientTriage` is pure and total — it never throws; an empty roster yields `[]`, an empty `workItems` yields all-green rows.
- The endpoint inherits the existing `withErrorHandler` + `safeSignal` degradation: if a work signal fails, its items are simply absent, so the affected client shows a lower light (worst case green when it should be amber). This is acceptable graceful degradation, identical to the flat feed's existing behaviour — no new failure surface.
- The page's existing load/error/loading states are unchanged; `clientTriage` defaults to `[]` if absent.

## 7. Testing

- **Unit tests** (`tests/unit/bureau/`) for `rollupClientTriage`:
  - light precedence: overdue beats due_soon beats info beats clear;
  - a roster client with no work items appears as green;
  - sort order (light rank, then overdue desc, then name);
  - multi-bureau grouping carries the right `bureauId`/`bureauName`;
  - work item with a companyId absent from roster is ignored;
  - empty roster → `[]`.
- **Type-check + build.**
- **Live browser-verify** in both themes via the seed-verify-revert recipe (`~/.claude/skills/browser/references/isaflow-auth-gated-verification.md`), as Increment 3. Confirm a red/amber/blue/green spread renders and a row click lands on the correct Level 2 home.
- **No React component tests** — Vitest is node-only (`environment: 'node'`, `.test.ts`). Glue is verified by type-check/build/browser. Do not fabricate component tests.

**File-size note:** `bureauWorkAggregatorService.ts` is currently ~247 lines. Adding `rollupClientTriage` + its types must stay under the 300-line cap; if it would exceed, extract the shaper into `bureauClientTriageService.ts` (pure, importing `WorkItem`/`CompanyMeta` from `bureauWorkTypes`).

## 8. Out of scope (YAGNI)

- No change to `aggregateBureauWork` SQL or any work signal.
- No new severity types, no per-task drill-down on the board (the board summarises; the flat feed and Level 2 home carry the detail).
- No persistence of board sort/filter preferences.
- No migration, no data-model change.

## 9. Success criteria

- A firm user lands on `/bureau` and sees, above the flat queue, a board of every client with a single R/A/G+Blue light and terse counts, sorted worst-first.
- Clear clients appear green (proving "I'm on top of these"); a client with only no-deadline tidy-up appears blue, not falsely green or alarmingly amber.
- Clicking a client row lands on that client's Level 2 home.
- Both cockpit themes render the board correctly with no new colour tokens.
- `workItems`/flat feed/stat strip behaviour is unchanged.
