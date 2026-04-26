# UI Card System Consolidation Roadmap

Last updated: 2026-04-26

## Goal

Reduce the card-heavy feel without flattening the product into a generic table app. ISAFlow should feel broad, credible, and operationally dense: page structure should come from headers, bands, strips, tables, forms, and drawers, with cards reserved for genuinely bounded objects.

This roadmap is planning-only. It does not authorize functional UI changes, route changes, API changes, middleware changes, or package changes.

## Current Baseline

Shared primitives exist but still encode a mostly card-first system:

- `src/components/ui/Card.tsx` is a rounded, bordered, shadowed white/dark panel with optional header and footer.
- `src/components/ui/KpiStrip.tsx` renders each KPI as a compact bordered mini-card.
- `src/components/ui/PageHeader.tsx` is already a better page-level surface: identity, subtitle, actions, and bottom border without a floating card.

Representative screens show the main problem:

- Dashboard overview uses separate bordered panels for quick actions, alerts, KPIs, charts, and tables, giving unrelated content equal visual weight.
- Customers detail tabs use card-like containers for add forms, empty states, contacts, and activity feed items.
- Reports dashboard uses navigation cards and a full bordered trial-balance panel; report builder preview already behaves more like a work surface/table shell.
- Payroll has a strong `PayrollPeriodBar` context strip, but employee edit areas still use repeated card sections.

## Strict Surface Types

Use these names as the design contract before changing code. A component should fit one surface type. If it does not, the design is probably over-framed.

| Surface | Purpose | Visual Rules | Current Targets |
| --- | --- | --- | --- |
| `PageHeader` | Page identity, subtitle, primary actions, optional back link | Full-width header band with bottom border. No surrounding card. One action cluster only. | Keep and expand usage across list/detail screens. |
| `ContextStrip` | Active company, period, status, scoped filters that affect the whole page | Thin full-width row. Border-bottom only. Compact status pills allowed. | Formalize from `PayrollPeriodBar`; reuse for fiscal period/report context. |
| `KpiStrip` | 2-6 high-signal metrics that support scanning | Compact row, no shadow, lighter border than cards. Avoid nesting inside cards. | Refactor away from mini-card dominance; use on list dashboards only. |
| `DataTableShell` | Filters, count, bulk actions, table, pagination, empty state | One table work surface. Header/filter area may be a band; table rows carry density. No card per row. | Dashboard tables, reports trial balance, customer lists. |
| `FormSection` | Editable grouped fields with save/cancel or local validation | Section with title, description, field grid, and footer actions. Border or divider is allowed; no shadow. | Customer add forms, payroll employee profile/components. |
| `DetailPanel` | Read-only record facts, audit metadata, balances, status | Low-emphasis panel or divided list. Use for facts, not every page section. | Customer profile facts, payroll employee facts, report metadata. |
| `ActionPanel` | High-priority next action, warning, approval, or exception | Strong semantic tone, single CTA cluster, can be bordered. Never used for normal navigation. | Dashboard provisional/missing-invoice alerts, payroll run blockers. |
| `NavigationTile` | Small set of task/report destinations | Flat link row/list preferred. Tile grid only when comparing categories. No shadows. | Reports links, dashboard quick actions. |
| `ObjectCard` | A genuinely bounded object users compare or open | Allowed for repeated business objects with summary + action, max 8px radius. | Bank feeds, widgets, marketplace-like catalogues. Use sparingly. |
| `ModalDrawerSurface` | Temporary contained workflow | Framed by modal/drawer chrome. Internal content should use sections, not nested cards. | Report builder sidebars, merge modals, setup flows. |

## Hard Rules

- Do not put cards inside cards.
- Do not use `Card` as the default page layout primitive.
- Do not use card grids for navigation when a list, segmented control, tabs, or command action would scan faster.
- Do not use shadows for normal accounting work surfaces. Elevation is reserved for modals, drawers, menus, and hover affordances on truly clickable objects.
- Keep page-level grouping full-width and structural: border-bottom, dividers, table bands, sticky bars, and section spacing.
- A screen should usually have one primary work surface after the `PageHeader`, not five equally framed panels.
- Empty states belong inside the relevant `DataTableShell`, `FormSection`, or workflow surface; they should not become decorative standalone cards.
- Repeated timeline/feed items may use separators and icon chips before cards. Use cards only when each item has independent actions and dense metadata.
- KPI surfaces must be compact and subordinate to the main workflow, not the dominant visual system.

## Migration Phases

### Phase 0 - Inventory And Guardrails

Target: 1-2 days

- Inventory all `Card`, `rounded-lg`, `rounded-xl`, `bg-white`, `bg-[var(--ff-bg-secondary)]`, `shadow`, and repeated panel usages in accounting, customers, reports, and payroll UI.
- Tag each usage as one strict surface type from this document.
- Add a short component decision note to `Card.tsx`: use only for `ObjectCard` or temporary legacy surfaces.
- Define visual tokens for border-only surfaces, table shells, strips, and section dividers before broad migration.

Exit criteria:

- Every major card-heavy surface has a target type.
- No migration starts without a surface mapping.

### Phase 1 - Primitive Consolidation

Target: 2-4 days

- Keep `PageHeader` as the page identity primitive.
- Split card concerns into named primitives instead of expanding `Card` variants indefinitely:
  - `ContextStrip`
  - `DataTableShell`
  - `FormSection`
  - `DetailPanel`
  - `ActionPanel`
  - `NavigationTile`
- Tune `KpiStrip` to read as a strip, not a row of prominent cards: lighter border, no shadow, tighter density.
- Mark `Card` as legacy/default-off in documentation once replacement primitives exist.

Exit criteria:

- New screens can be built without importing `Card`.
- Existing `Card` remains available for safe incremental migration.

### Phase 2 - Dashboard First Pass

Target: 3-5 days

- Replace dashboard quick-action cards with `NavigationTile` or a compact action list.
- Convert provisional and missing-invoice alerts into `ActionPanel` surfaces with stronger priority hierarchy.
- Convert KPI blocks to `KpiStrip`.
- Move charts and summary tables toward `DataTableShell` or low-emphasis work surfaces.
- Keep one clear primary workflow area visible above the fold.

Exit criteria:

- Dashboard no longer reads as a grid of equal cards.
- Alerts, KPIs, charts, and tables each have distinct visual weight.

### Phase 3 - Customers And Customer Detail

Target: 3-5 days

- Convert contact and activity add forms to `FormSection`.
- Replace contact rows and activity feed cards with divided list/timeline rows unless an item has complex independent actions.
- Put empty states inside their owning section or table shell.
- Use `DetailPanel` only for stable customer facts and audit metadata.

Exit criteria:

- Customer tabs scan as workflows and lists, not stacked cards.
- Add/edit actions are visually obvious without surrounding every row.

### Phase 4 - Reports

Target: 3-5 days

- Replace report navigation card grids with grouped `NavigationTile` lists or category tables.
- Standardize report output containers as `DataTableShell`.
- Treat report builder preview as the model for dense, table-first work surfaces.
- Use `ContextStrip` for fiscal period/entity/report scope.

Exit criteria:

- Reports feel like analytical workspaces, not a brochure of report cards.
- Period selection and output state are structurally tied to the table surface.

### Phase 5 - Payroll

Target: 4-6 days

- Promote `PayrollPeriodBar` into canonical `ContextStrip`.
- Convert employee profile, components, history, termination, pay scale, and cost-centre cards into `FormSection` or `DetailPanel`.
- Use `ActionPanel` only for payroll blockers, approvals, validation issues, and locked-run warnings.
- Avoid nested sections inside modal/drawer workflows.

Exit criteria:

- Payroll keeps its strong period context while reducing repeated framed edit cards.
- Payroll run pages distinguish status, validation, and editable fields at a glance.

### Phase 6 - Enforcement And Visual QA

Target: ongoing

- Add a design-system checklist to PR review for surface type, nesting, shadows, and empty states.
- Add before/after screenshots for dashboard, customers, reports, and payroll desktop/mobile.
- Track remaining legacy `Card` imports and bespoke panel classes.
- Treat new `shadow`, `rounded-xl`, and `bg-white` work surfaces as design review triggers.

Exit criteria:

- New UI work starts from strict surfaces.
- Card-heavy regressions are caught in review before implementation spreads.

## Measurement

Use these signals to decide whether the migration is working:

- A representative screen has no more than one dominant framed work surface above the fold.
- Repeated rows use tables, divided lists, or timelines before cards.
- `Card` imports trend down release over release.
- KPI and alert surfaces are visually distinct from normal content.
- Desktop and mobile screenshots show no nested cards, awkward stacking, or equal-weight panel soup.

