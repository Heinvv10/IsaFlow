# Library Demotion — Design

**Date:** 2026-06-09
**Status:** Approved (design) — ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-06-08-ui-modernization-design.md` §3.1 ("The 12 existing modules survive behind a 'Library' drill-down")
**Phase:** UI Modernization — the IA-landing increment that follows Phase 2.4 (cockpit triage board, PR #145).

---

## 1. Problem

The work-first IA built in Phase 2 (practice cockpit, Level-2 client home) does not actually land, because the **same 12-tab module nav still sits across the top of every accounting page** — including `/bureau`. `AppLayout` → `AccountingNav` → `ModuleNav(TABS)` renders the full Sage-style spine (Dashboard · Portfolio · Month-End · Sales · Purchases · Inventory · Banking · Accounting · Reports · Tax · Payroll · Practice) for every user on every page. The front door is still a filing cabinet; the centre of gravity has not shifted.

This increment demotes the module tabs into a single **Library** entry, so the front door becomes work-first and the modules become reference.

## 2. Decisions (locked with the user)

1. **Rollout: global, no flag.** The demotion applies to every user at once. No per-user/per-company feature flag and no client-side opt-in toggle. (The parallel-shell feature flag remains a separate, deprioritised increment.) **Implication:** this changes the primary nav for all live, feature-complete-product users in one deploy; the build must keep every existing route reachable and every active-state correct. Browser-verify before deploy.
2. **Front door = `Dashboard · Portfolio · Month-End · Banking · Library`.** The three work-first surfaces stay promoted; **Banking also stays promoted** as the daily reconciliation "heartbeat" (Phase 3 promotes recon properly anyway). The other **8 modules fold into Library**: Sales, Purchases, Inventory, Accounting, Reports, Tax, Payroll, Practice.
3. **Library shape: Hybrid (page + flyout + secondary nav).** Three affordances coexist:
   - a **landing page** grid (primary discovery),
   - a **hover flyout** on the Library tab (power-user quick-jump),
   - a **secondary in-module nav bar** (navigation while working inside a demoted module).
4. **Library tab UX: click = link, hover = flyout.** Clicking the Library tab navigates to the landing page; hovering opens the flyout automatically.

## 3. Architecture

Maximise reuse of the existing nav machinery; introduce the minimum new code.

### 3.1 Resolver split — `src/components/accounting/navSections/activeTab.ts`

The existing `getActiveTabId` body is a ~100-line route→module mapping that is the single source of truth for "which module owns this path" (and encodes real precedence, e.g. `/accounting/reports/sales-by-customer` → `sales`, not `reports`). **Preserve it verbatim**, renamed to `getActiveModuleId`. Add a thin wrapper:

```ts
const DEMOTED_MODULE_IDS = new Set([
  'sales', 'purchases', 'inventory', 'accounting', 'reports', 'tax', 'payroll', 'practice',
]);

export function getActiveTabId(pathname, query): string {
  const id = getActiveModuleId(pathname, query);
  return DEMOTED_MODULE_IDS.has(id) ? 'library' : id;
}
```

- `getActiveTabId` (top bar): demoted ids collapse to `'library'`; `dashboard` / `portfolio` / `workbench` / `banking` / `settings` pass through unchanged.
- `getActiveModuleId` (secondary nav): returns the real module id so the secondary bar knows which module's sub-pages to show.
- Both exported; `isLinkActive` unchanged.

### 3.2 Library config — `src/components/accounting/navSections/library.ts` (new)

Single source of truth for both the flyout and the landing grid.

- Imports the 8 existing module tab definitions (`salesTab`, `purchasesTab`, `inventoryTab`, `accountingTab`, `reportsTab`, `taxTab`, `payrollTab`, `practiceTab`).
- `libraryTab: Tab` — a **link+flyout** tab: `{ id: 'library', label: 'Library', href: '/accounting/library', items: [...] }` where `items` is one `FlyoutSection` per module: `{ section: moduleTab.label, items: moduleTab.items }`. Reuses the existing recursive flyout (Library → module section → its sub-sections → links). Module `topItems` (quick-create shortcuts like "Add a Customer") are **intentionally not folded in** — the global `CreateNewMenu` is the canonical quick-create surface, so duplicating them into nested flyout sections would be redundant.
- `LIBRARY_MODULES: LibraryModule[]` — landing-grid metadata: `{ id, label, icon, description, href }`. `href` = each module's primary home (Sales → `/accounting/customers`, Purchases → `/accounting/suppliers`, Inventory → `/accounting/items`, Accounting → `/accounting/chart-of-accounts`, Reports → `/accounting/reports/income-statement`, Tax → `/accounting/reports/vat-return`, Payroll → `/payroll`, Practice → `/accounting/practice/clients`). Icons from `lucide-react`, consistent with current usage.

### 3.3 Nav config — `src/components/accounting/accountingNavConfig.ts`

`TABS` becomes:
```ts
export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  { id: 'portfolio', label: 'Portfolio', href: '/accounting/portfolio-workbench' },
  { id: 'workbench', label: 'Month-End', href: '/accounting/month-end-workbench' },
  bankingTab,
  libraryTab,
];
```
`settingsTab` export unchanged (cog flyout). The 8 module tab modules remain on disk — they are now consumed *through* `libraryTab` and the secondary nav, not as top-level tabs.

### 3.4 Link+flyout tab support — `ModuleNav.tsx` and `SidebarNav.tsx`

Both currently render a tab as **either** a `<Link>` (when `href`, no dropdown) **or** a flyout button (when `items`). Add a third branch for a tab with **both** `href` and `items`:

- **`ModuleNav` (top bar):** the tab label is a `<Link href={t.href}>`; the wrapping element opens the flyout on `mouseenter` and closes on delayed `mouseleave` (matching the locked "click = link, hover = flyout" UX). A non-interactive `▾` chevron is shown as an affordance. The existing click-to-toggle path is unchanged for pure-dropdown tabs (Banking).
- **`SidebarNav`:** the existing `tab.href && !hasItems` branch renders a pure link; add a branch for `tab.href && hasItems` that renders the label as a `<Link>` while still opening the hover flyout via the existing portal machinery.

### 3.5 Secondary in-module nav — `SecondaryModuleNav.tsx` (new)

Reuses `ModuleNav`. Given the active module id (`getActiveModuleId`):
- find the module tab; transform each of its `FlyoutSection`s into a `Tab` (`{ id: section.section, label: section.section, items: section.items }`); flat `DropdownItem`s become `href` tabs. Module `topItems` are not surfaced here (same rationale as the Library flyout — `CreateNewMenu` owns quick-create). `isSetting` items keep their links but lose the gear-icon styling in the secondary bar's `FlatDropdown` rendering — an accepted cosmetic trade-off.
- a section is "active" when any of its (recursively nested) links matches `isLinkActive(href, asPath)` — no new route table needed.
- rendered with a subordinate accent (e.g. `slate`) to sit visually below the primary nav.

`AppLayout` renders `<SecondaryModuleNav moduleId={activeModuleId} />` directly under `<AccountingNav />`, **only in top-nav mode** and **only when `getActiveModuleId` returns a demoted module**. Sidebar mode already exposes the full tree via hover flyout, so no secondary bar there.

### 3.6 Landing page — `pages/accounting/library.tsx` (new)

Wrapped in `AppLayout`. Renders a responsive grid of `LIBRARY_MODULES` cards (icon, label, one-line description), each a `<Link>` to the module home. Pure presentational — **no API call, no `company_id` scoping, no data**. Uses existing theme tokens (`--ff-*`) and the `Card` primitive where it fits.

## 4. Data flow

None new. This is a presentation/IA change end-to-end: no migration, no API route, no service, no data-model change, no cross-tenant read. Multi-tenant scoping is untouched because no tenant data is read.

## 5. Build breakdown (TDD where logic is pure)

| # | Unit | Type | Tested by |
|---|------|------|-----------|
| 1 | Resolver split (`getActiveModuleId` + `getActiveTabId` wrapper) | pure | Vitest unit |
| 2 | `library.ts` (`libraryTab` assembly + `LIBRARY_MODULES`) | pure config | Vitest unit |
| 3 | Secondary-nav section→tab transform + section-active predicate | pure | Vitest unit |
| 4 | `TABS` restructure in `accountingNavConfig.ts` | config | type-check / build |
| 5 | `ModuleNav` + `SidebarNav` link+flyout branch | React | type-check / build / browser |
| 6 | `SecondaryModuleNav.tsx` | React | type-check / build / browser |
| 7 | `pages/accounting/library.tsx` landing grid | React | type-check / build / browser |
| 8 | `AppLayout` wires the secondary nav | React | type-check / build / browser |

## 6. Testing

- **Unit (Vitest, node env):** resolver resolution (every demoted route → `library`; `banking`/`dashboard`/`portfolio`/`workbench` pass through; report-sub-routes resolve to the correct owning module), `libraryTab`/`LIBRARY_MODULES` invariants (all 8 modules present, every home href non-empty and route-shaped, no duplicate ids), secondary transform + active predicate.
- **Type-check + build:** the React glue (ModuleNav/SidebarNav branches, SecondaryModuleNav, landing page, AppLayout wiring).
- **Browser (both themes, both nav modes):** front door shows the 5 tabs; clicking Library lands on the grid; hovering Library opens the flyout; entering a module (e.g. Sales) highlights Library on top + shows the Sales secondary bar with the correct active sub-page; Banking still behaves as today; sidebar mode nests the 8 modules under Library.

## 7. Out of scope (YAGNI)

- Per-user/per-company feature flag or opt-in toggle (separate increment).
- Rebuilding any of the 8 module pages' internals — only how they are reached changes.
- Promoting Reconciliation into its own first-class surface (Phase 3).
- The `/bureau` cockpit's own nav: it inherits the same demoted `AppLayout` nav automatically; no bespoke bureau nav work here.
- Adding a `g l` keyboard shortcut for Library (nice-to-have, not required).

## 8. Success criteria

- The accounting front door shows **5** tabs, not 12; the 8 modules are reachable only through Library.
- Every previously-reachable module route is still reachable via (a) the landing grid, (b) the Library flyout, and (c) the secondary in-module bar.
- Top-bar active state shows **Library** for any module route; the secondary bar shows the correct active sub-page.
- Banking, Dashboard, Portfolio, Month-End behave exactly as before.
- No migration, no API, no service change; build + type-check + lint green; browser-verified in both themes and both nav modes.

## 9. Risks

- **Global blast radius (decision §2.1).** Every live user's nav changes in one deploy. Mitigation: keep all routes reachable, verify active-state across a representative route sample, browser-verify before deploy, deploy after hours per the production time gate.
- **Active-state regressions.** The resolver wrapper must not alter any pass-through id. Mitigation: unit tests assert pass-through for `banking`/`dashboard`/`portfolio`/`workbench`/`settings` and collapse only for the 8 demoted ids.
- **Deep flyout nesting.** Folding a module into a Library `FlyoutSection` adds one nesting level (Library → module → section → links, up to 4). The existing recursive flyout supports it, but the landing page + secondary bar are the primary paths, so the deep flyout is the power-user fallback, not the main route.
