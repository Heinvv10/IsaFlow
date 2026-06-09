# Library Demotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the 12-tab accounting nav into `Dashboard · Portfolio · Month-End · Banking · Library`, folding the other 8 modules behind a Hybrid Library (landing-page grid + hover flyout + secondary in-module nav bar), globally with no feature flag.

**Architecture:** Presentation/IA-only. Keep the existing route→module resolver verbatim (renamed `getActiveModuleId`) and wrap it so the 8 demoted ids collapse to `'library'` on the top bar while the secondary nav still resolves the real module. Reuse the existing `ModuleNav`/`SidebarNav` flyout machinery; add a "link+flyout" tab branch. New code is one config file, one pure transform, one landing page, one secondary-nav component, plus three small edits. No migration, API, service, or data-model change.

**Tech Stack:** Next.js 14 (pages router), TypeScript, Tailwind, lucide-react, Vitest (node env, `tests/unit/**/*.test.ts`).

**Ordering note:** Supporting pieces land first (Tasks 1–7, each additive and non-disruptive); the global switch (TABS restructure + AppLayout wiring) lands last in Task 8, so the only commit that changes what every user sees is the final, fully-supported one.

**Spec:** `docs/superpowers/specs/2026-06-09-library-demotion-design.md`

---

## File structure

| File | Responsibility | Task |
|------|----------------|------|
| `src/components/accounting/navSections/library.ts` (new) | `libraryTab` (link+flyout) + `LIBRARY_MODULES` landing metadata — single source of truth | 1 |
| `tests/unit/nav/library.test.ts` (new) | invariants on `libraryTab` + `LIBRARY_MODULES` | 1 |
| `src/components/layout/ModuleNav.tsx` (modify) | render a tab that is both a `<Link>` and a hover flyout | 2 |
| `src/components/layout/SidebarNav.tsx` (modify) | same link+flyout support in the sidebar | 3 |
| `src/components/accounting/navSections/secondaryNav.ts` (new) | pure: `moduleSectionsToTabs` + `isSectionActive` + `getActiveSectionId` | 4 |
| `tests/unit/nav/secondaryNav.test.ts` (new) | transform + active-section predicate | 4 |
| `src/components/accounting/SecondaryModuleNav.tsx` (new) | secondary in-module bar, reuses `ModuleNav` | 5 |
| `pages/accounting/library.tsx` (new) | landing-page grid of module cards | 6 |
| `src/components/accounting/navSections/activeTab.ts` (modify) | split into `getActiveModuleId` + `getActiveTabId` wrapper | 7 |
| `tests/unit/nav/activeTab.test.ts` (new) | resolver collapse + passthrough | 7 |
| `src/components/accounting/accountingNavConfig.ts` (modify) | `TABS` → 5 tabs | 8 |
| `src/components/layout/AppLayout.tsx` (modify) | render `<SecondaryModuleNav>` under `<AccountingNav>` | 8 |

---

### Task 1: Library config (`libraryTab` + `LIBRARY_MODULES`)

**Files:**
- Create: `src/components/accounting/navSections/library.ts`
- Test: `tests/unit/nav/library.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/nav/library.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { libraryTab, LIBRARY_MODULES } from '@/components/accounting/navSections/library';
import { isFlyout } from '@/components/accounting/navSections/types';

const DEMOTED = ['sales', 'purchases', 'inventory', 'accounting', 'reports', 'tax', 'payroll', 'practice'];

describe('libraryTab', () => {
  it('is a link+flyout tab pointing at the landing page', () => {
    expect(libraryTab.id).toBe('library');
    expect(libraryTab.label).toBe('Library');
    expect(libraryTab.href).toBe('/accounting/library');
    expect(libraryTab.items && libraryTab.items.length).toBe(8);
  });

  it('folds each demoted module into its own flyout section', () => {
    const sections = (libraryTab.items ?? []).filter(isFlyout).map((s) => s.section);
    expect(sections).toEqual(['Sales', 'Purchases', 'Inventory', 'Accounting', 'Reports', 'Tax', 'Payroll', 'Practice']);
  });
});

describe('LIBRARY_MODULES', () => {
  it('has one card per demoted module with a route-shaped href and no dupes', () => {
    expect(LIBRARY_MODULES.map((m) => m.id)).toEqual(DEMOTED);
    for (const m of LIBRARY_MODULES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.href.startsWith('/')).toBe(true);
      expect(typeof m.icon).toBe('object'); // a React element
    }
    expect(new Set(LIBRARY_MODULES.map((m) => m.href)).size).toBe(LIBRARY_MODULES.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/nav/library.test.ts`
Expected: FAIL — cannot resolve `@/components/accounting/navSections/library`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/accounting/navSections/library.ts`:

```ts
/**
 * Library config — single source of truth for the demoted-module surface.
 *
 * Used by both the Library top-tab flyout (`libraryTab`) and the
 * /accounting/library landing grid (`LIBRARY_MODULES`). The 8 modules
 * here are everything NOT promoted to the front door (Dashboard,
 * Portfolio, Month-End, Banking stay top-level).
 */
import React from 'react';
import {
  ShoppingCart, Truck, Package, BookOpen,
  BarChart3, Receipt, Users, Briefcase,
} from 'lucide-react';
import type { Tab, FlyoutSection } from './types';

import { salesTab } from './sales';
import { purchasesTab } from './purchases';
import { inventoryTab } from './inventory';
import { accountingTab } from './accounting';
import { reportsTab } from './reports';
import { taxTab } from './tax';
import { payrollTab } from './payroll';
import { practiceTab } from './practice';

const MODULE_TABS: Tab[] = [
  salesTab, purchasesTab, inventoryTab, accountingTab,
  reportsTab, taxTab, payrollTab, practiceTab,
];

/** Each demoted module becomes one flyout section holding its own nav tree. */
const moduleSection = (t: Tab): FlyoutSection => ({
  section: t.label,
  items: t.items ?? [],
});

export const libraryTab: Tab = {
  id: 'library',
  label: 'Library',
  href: '/accounting/library',
  items: MODULE_TABS.map(moduleSection),
};

export interface LibraryModule {
  id: string;
  label: string;
  description: string;
  href: string;
  icon: React.ReactNode;
}

const ICON = 'h-5 w-5';

export const LIBRARY_MODULES: LibraryModule[] = [
  { id: 'sales',      label: 'Sales',      description: 'Customers, invoices, quotes & receivables',     href: '/accounting/customers',                 icon: React.createElement(ShoppingCart, { className: ICON }) },
  { id: 'purchases',  label: 'Purchases',  description: 'Suppliers, bills, orders & payments',           href: '/accounting/suppliers',                 icon: React.createElement(Truck, { className: ICON }) },
  { id: 'inventory',  label: 'Inventory',  description: 'Items, stock levels & valuation',               href: '/accounting/items',                     icon: React.createElement(Package, { className: ICON }) },
  { id: 'accounting', label: 'Accounting', description: 'Chart of accounts, journals & periods',         href: '/accounting/chart-of-accounts',         icon: React.createElement(BookOpen, { className: ICON }) },
  { id: 'reports',    label: 'Reports',    description: 'Financial statements, AFS & management packs',  href: '/accounting/reports/income-statement',  icon: React.createElement(BarChart3, { className: ICON }) },
  { id: 'tax',        label: 'Tax',        description: 'VAT returns, SARS & tax submissions',           href: '/accounting/reports/vat-return',        icon: React.createElement(Receipt, { className: ICON }) },
  { id: 'payroll',    label: 'Payroll',    description: 'Employees, pay runs & leave',                   href: '/payroll',                              icon: React.createElement(Users, { className: ICON }) },
  { id: 'practice',   label: 'Practice',   description: 'Clients, jobs, time & WIP for your firm',       href: '/accounting/practice/clients',          icon: React.createElement(Briefcase, { className: ICON }) },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/nav/library.test.ts`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/navSections/library.ts tests/unit/nav/library.test.ts
git commit -m "feat(nav): Library config — libraryTab flyout + LIBRARY_MODULES grid metadata"
```

---

### Task 2: `ModuleNav` link+flyout tab support

**Files:**
- Modify: `src/components/layout/ModuleNav.tsx` (the tab-render block, ~lines 313–349)

No new test — verified by type-check/build (Task 8 browser-verifies behaviour). This change is additive: no tab in `TABS` uses href+items until Task 8, so existing tabs render unchanged.

- [ ] **Step 1: Add hover-close timer + the link+flyout branch**

In `src/components/layout/ModuleNav.tsx`, inside the `ModuleNav` component, after the existing `const accent = ...` line add a delayed-close timer:

```tsx
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHover = () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); };
  const delayedClose = () => { hoverTimer.current = setTimeout(() => setOpenTab(null), 150); };
  useEffect(() => () => clearHover(), []);
```

- [ ] **Step 2: Replace the tab-render map body**

Replace the `{(tabs ?? []).map(t => ( ... ))}` block with one that handles three cases — pure link, link+flyout (new), and dropdown:

```tsx
        {(tabs ?? []).map(t => {
          const linkFlyout = !!(t.href && t.items?.length);
          return (
          <div
            key={t.id}
            className="relative"
            data-tour={`nav-${t.id}`}
            onMouseEnter={linkFlyout ? () => { clearHover(); setOpenTab(t.id); } : undefined}
            onMouseLeave={linkFlyout ? delayedClose : undefined}
          >
            {t.href && !t.items?.length ? (
              <Link
                href={t.href}
                className={`block px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === t.id
                    ? `${accent.activeBorder} ${accent.activeText}`
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
              >
                {t.label}
              </Link>
            ) : linkFlyout ? (
              <Link
                href={t.href as string}
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors inline-flex items-center gap-1 ${
                  activeTab === t.id
                    ? `${accent.activeBorder} ${accent.activeText}`
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
              >
                {t.label}
                <ChevronDown className={`h-3 w-3 transition-transform ${openTab === t.id ? 'rotate-180' : ''}`} />
              </Link>
            ) : (
              <button
                onClick={() => setOpenTab(openTab === t.id ? null : t.id)}
                className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors inline-flex items-center gap-1 ${
                  activeTab === t.id
                    ? `${accent.activeBorder} ${accent.activeText}`
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
              >
                {t.label}
                <ChevronDown className={`h-3 w-3 transition-transform ${openTab === t.id ? 'rotate-180' : ''}`} />
              </button>
            )}

            {t.items && openTab === t.id && (
              hasFlyout(t)
                ? <FlyoutDropdown tab={t} asPath={router.asPath} onClose={() => setOpenTab(null)} accent={accent} />
                : <FlatDropdown items={t.items as DropdownItem[]} asPath={router.asPath} onClose={() => setOpenTab(null)} accent={accent} />
            )}
          </div>
          );
        })}
```

- [ ] **Step 3: Type-check**

Run: `bun run type-check`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/ModuleNav.tsx
git commit -m "feat(nav): ModuleNav supports link+flyout tabs (hover opens, click navigates)"
```

---

### Task 3: `SidebarNav` link+flyout tab support

**Files:**
- Modify: `src/components/layout/SidebarNav.tsx` (the `TABS.map` block, ~lines 186–219)

Additive; verified by type-check/build.

- [ ] **Step 1: Add the link+flyout branch**

In `src/components/layout/SidebarNav.tsx`, inside `TABS.map(tab => { ... })`, replace the existing `if (tab.href && !hasItems) { ... }` block (and keep the dropdown fallthrough below it) with:

```tsx
          if (tab.href && !hasItems) {
            return (
              <Link key={tab.id} href={tab.href}
                className={`flex items-center px-4 py-2 text-sm font-medium transition-colors border-l-[3px] ${
                  active
                    ? 'text-teal-700 dark:text-teal-300 bg-teal-500/[0.08] border-teal-500 dark:border-teal-400'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 border-transparent'
                } ${collapsed ? 'justify-center px-0' : ''}`}
                title={collapsed ? tab.label : undefined}>
                {collapsed ? tab.label.slice(0, 2) : tab.label}
              </Link>
            );
          }

          if (tab.href && hasItems) {
            return (
              <Link key={tab.id} href={tab.href}
                onMouseEnter={(e) => openFlyout(tab.id, e.currentTarget)}
                onMouseLeave={dl}
                className={`flex items-center justify-between px-4 py-2 text-sm font-medium transition-colors border-l-[3px] ${
                  active || isOpen
                    ? 'text-teal-700 dark:text-teal-300 bg-teal-500/[0.08] border-teal-500 dark:border-teal-400'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-white/5 border-transparent'
                } ${collapsed ? 'justify-center px-0' : ''}`}
                title={collapsed ? tab.label : undefined}>
                <span>{collapsed ? tab.label.slice(0, 2) : tab.label}</span>
                {!collapsed && <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 ${isOpen ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400 dark:text-slate-500'}`} />}
              </Link>
            );
          }
```

(The existing dropdown `return ( <div onMouseEnter=...> )` block stays unchanged as the final fallthrough.)

- [ ] **Step 2: Type-check**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/SidebarNav.tsx
git commit -m "feat(nav): SidebarNav supports link+flyout tabs"
```

---

### Task 4: Secondary-nav pure transform

**Files:**
- Create: `src/components/accounting/navSections/secondaryNav.ts`
- Test: `tests/unit/nav/secondaryNav.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/nav/secondaryNav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { moduleSectionsToTabs, isSectionActive } from '@/components/accounting/navSections/secondaryNav';
import { salesTab } from '@/components/accounting/navSections/sales';

describe('moduleSectionsToTabs', () => {
  it('turns each module flyout section into a dropdown tab', () => {
    const tabs = moduleSectionsToTabs(salesTab);
    expect(tabs.map((t) => t.label)).toEqual(['Customers', 'Transactions', 'Reports', 'Statement Run']);
    // each becomes a no-href dropdown carrying the section's items
    expect(tabs[0]!.href).toBeUndefined();
    expect(tabs[0]!.items!.length).toBeGreaterThan(0);
  });
});

describe('isSectionActive', () => {
  it('is active when any nested link matches the path', () => {
    const customers = moduleSectionsToTabs(salesTab)[0]!;
    expect(isSectionActive(customers, '/accounting/customers')).toBe(true);
    expect(isSectionActive(customers, '/accounting/items')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/nav/secondaryNav.test.ts`
Expected: FAIL — cannot resolve `secondaryNav`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/accounting/navSections/secondaryNav.ts`:

```ts
/**
 * Pure transforms that drive the secondary in-module nav bar.
 *
 * A demoted module (e.g. salesTab) is a Tab whose `items` are FlyoutSections.
 * The secondary bar renders each section as a ModuleNav dropdown tab; a section
 * is "active" when any of its (possibly nested) links matches the current path.
 */
import { isFlyout, isLinkActive, type Tab, type NavItem } from './types';

/** Each top-level section of a module → a dropdown tab for ModuleNav. */
export function moduleSectionsToTabs(moduleTab: Tab): Tab[] {
  return (moduleTab.items ?? []).map((item): Tab => {
    if (isFlyout(item)) {
      return { id: item.section, label: item.section, items: item.items };
    }
    return { id: item.href, label: item.label, href: item.href };
  });
}

function anyLinkActive(items: NavItem[], asPath: string): boolean {
  return items.some((item) =>
    isFlyout(item) ? anyLinkActive(item.items, asPath) : isLinkActive(item.href, asPath),
  );
}

/** A section tab is active when one of its nested links matches the path. */
export function isSectionActive(sectionTab: Tab, asPath: string): boolean {
  if (sectionTab.href) return isLinkActive(sectionTab.href, asPath);
  return anyLinkActive(sectionTab.items ?? [], asPath);
}

/** Active section id for the whole module bar (or '' when none match). */
export function getActiveSectionId(moduleTab: Tab, asPath: string): string {
  const tabs = moduleSectionsToTabs(moduleTab);
  return tabs.find((t) => isSectionActive(t, asPath))?.id ?? '';
}
```

Note: `isLinkActive` is re-exported from `./types`? It is defined in `./activeTab`. Re-export it from `types` is wrong — import from `./activeTab` instead. Use:

```ts
import { isFlyout, type Tab, type NavItem } from './types';
import { isLinkActive } from './activeTab';
```

(Replace the first import line accordingly; the test imports nothing from `activeTab` so this is internal.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/nav/secondaryNav.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/navSections/secondaryNav.ts tests/unit/nav/secondaryNav.test.ts
git commit -m "feat(nav): pure secondary-nav transform (sections→tabs + active predicate)"
```

---

### Task 5: `SecondaryModuleNav` component

**Files:**
- Create: `src/components/accounting/SecondaryModuleNav.tsx`

Verified by type-check/build.

- [ ] **Step 1: Write the component**

Create `src/components/accounting/SecondaryModuleNav.tsx`:

```tsx
/**
 * Secondary in-module nav bar. Rendered under the primary nav while the user
 * is inside a demoted module (Sales, Purchases, …). Reuses ModuleNav with a
 * subordinate accent, presenting that module's sections as dropdown tabs.
 */
import { useRouter } from 'next/router';
import { ModuleNav } from '@/components/layout/ModuleNav';
import { moduleSectionsToTabs, getActiveSectionId } from './navSections/secondaryNav';
import type { Tab } from './navSections/types';

import { salesTab } from './navSections/sales';
import { purchasesTab } from './navSections/purchases';
import { inventoryTab } from './navSections/inventory';
import { accountingTab } from './navSections/accounting';
import { reportsTab } from './navSections/reports';
import { taxTab } from './navSections/tax';
import { payrollTab } from './navSections/payroll';
import { practiceTab } from './navSections/practice';

const MODULE_BY_ID: Record<string, Tab> = {
  sales: salesTab, purchases: purchasesTab, inventory: inventoryTab, accounting: accountingTab,
  reports: reportsTab, tax: taxTab, payroll: payrollTab, practice: practiceTab,
};

export function SecondaryModuleNav({ moduleId }: { moduleId: string }) {
  const router = useRouter();
  const moduleTab = MODULE_BY_ID[moduleId];
  if (!moduleTab) return null;

  const tabs = moduleSectionsToTabs(moduleTab);
  const activeId = getActiveSectionId(moduleTab, router.asPath);

  return (
    <div className="border-b border-gray-200 dark:border-gray-800 bg-[var(--ff-canvas-mid)]">
      <div className="flex items-center gap-2 px-4 text-xs font-semibold uppercase tracking-wide text-[var(--ff-text-tertiary)]">
        <span className="py-2">{moduleTab.label}</span>
        <ModuleNav tabs={tabs} getActiveTabId={() => activeId} accentColor="slate" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/accounting/SecondaryModuleNav.tsx
git commit -m "feat(nav): SecondaryModuleNav — in-module section bar reusing ModuleNav"
```

---

### Task 6: Library landing page

**Files:**
- Create: `pages/accounting/library.tsx`

Verified by type-check/build/browser.

- [ ] **Step 1: Write the page**

Create `pages/accounting/library.tsx`:

```tsx
/**
 * Library — the demoted-module directory. A calm grid of the 8 modules that
 * used to be top-level tabs. Pure presentational: no API, no company scoping.
 */
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { LIBRARY_MODULES } from '@/components/accounting/navSections/library';

export default function LibraryPage() {
  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-xl font-semibold text-[var(--ff-text-primary)]">Library</h1>
          <p className="text-sm text-[var(--ff-text-secondary)]">
            Full-ledger modules. Your day-to-day work lives on the Dashboard, Portfolio, Month-End and Banking.
          </p>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {LIBRARY_MODULES.map((m) => (
            <Link
              key={m.id}
              href={m.href}
              style={{ borderRadius: 'var(--ff-card-radius)' }}
              className="group flex items-start gap-3 p-4 border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] hover:bg-[var(--ff-bg-tertiary)] hover:border-teal-400 transition-colors"
            >
              <span className="mt-0.5 text-teal-500" aria-hidden="true">{m.icon}</span>
              <span className="flex-1 min-w-0">
                <span className="flex items-center justify-between">
                  <span className="font-medium text-[var(--ff-text-primary)]">{m.label}</span>
                  <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)] group-hover:text-teal-500 transition-colors" />
                </span>
                <span className="block text-sm text-[var(--ff-text-secondary)] mt-0.5">{m.description}</span>
              </span>
            </Link>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bun run type-check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pages/accounting/library.tsx
git commit -m "feat(nav): /accounting/library landing-page grid"
```

---

### Task 7: Resolver split (`getActiveModuleId` + `getActiveTabId` wrapper)

**Files:**
- Modify: `src/components/accounting/navSections/activeTab.ts`
- Test: `tests/unit/nav/activeTab.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/nav/activeTab.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getActiveTabId, getActiveModuleId } from '@/components/accounting/navSections/activeTab';

const q = {} as Record<string, string | string[] | undefined>;

describe('getActiveModuleId (unchanged route mapping)', () => {
  it('resolves module routes to their module id', () => {
    expect(getActiveModuleId('/accounting/customers', q)).toBe('sales');
    expect(getActiveModuleId('/accounting/suppliers', q)).toBe('purchases');
    expect(getActiveModuleId('/accounting/items', q)).toBe('inventory');
    expect(getActiveModuleId('/accounting/chart-of-accounts', q)).toBe('accounting');
    expect(getActiveModuleId('/accounting/afs', q)).toBe('reports');
    expect(getActiveModuleId('/accounting/vat-201', q)).toBe('tax');
    expect(getActiveModuleId('/payroll', q)).toBe('payroll');
  });
  it('keeps the sales precedence over reports for shared report routes', () => {
    expect(getActiveModuleId('/accounting/reports/sales-by-customer', q)).toBe('sales');
  });
});

describe('getActiveTabId (top-bar wrapper)', () => {
  it('collapses demoted modules to "library"', () => {
    expect(getActiveTabId('/accounting/customers', q)).toBe('library');
    expect(getActiveTabId('/accounting/chart-of-accounts', q)).toBe('library');
    expect(getActiveTabId('/payroll', q)).toBe('library');
    expect(getActiveTabId('/accounting/library', q)).toBe('library');
  });
  it('passes through promoted + non-module ids unchanged', () => {
    expect(getActiveTabId('/accounting', q)).toBe('dashboard');
    expect(getActiveTabId('/accounting/portfolio-workbench', q)).toBe('portfolio');
    expect(getActiveTabId('/accounting/month-end-workbench', q)).toBe('workbench');
    expect(getActiveTabId('/accounting/bank-transactions', q)).toBe('banking');
    expect(getActiveTabId('/accounting/company-settings', q)).toBe('settings');
  });
});
```

Note: `getActiveModuleId('/accounting/library', q)` falls through to `'dashboard'` (no rule matches), so `getActiveTabId` returns `'dashboard'` — but the test asserts `'library'`. Handle `/accounting/library` explicitly in the wrapper (Step 3) so the Library tab self-highlights.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/nav/activeTab.test.ts`
Expected: FAIL — `getActiveModuleId` not exported.

- [ ] **Step 3: Implement the split**

In `src/components/accounting/navSections/activeTab.ts`, rename the existing exported `getActiveTabId` function to `getActiveModuleId` (keep its entire body verbatim), then add the wrapper above `isLinkActive`:

```ts
export function getActiveModuleId(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
): string {
  // ... existing body, unchanged ...
}

const DEMOTED_MODULE_IDS = new Set([
  'sales', 'purchases', 'inventory', 'accounting', 'reports', 'tax', 'payroll', 'practice',
]);

/** Top-bar resolver: demoted modules collapse onto the Library tab. */
export function getActiveTabId(
  pathname: string,
  query: Record<string, string | string[] | undefined>,
): string {
  if (pathname.startsWith('/accounting/library')) return 'library';
  const id = getActiveModuleId(pathname, query);
  return DEMOTED_MODULE_IDS.has(id) ? 'library' : id;
}
```

`getActiveTabId` keeps the same signature, so `ModuleNav` / `SidebarNav` / `accountingNavConfig` re-export continue to work with no caller changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run tests/unit/nav/activeTab.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole nav unit suite**

Run: `bunx vitest run tests/unit/nav/`
Expected: PASS (library + secondaryNav + activeTab).

- [ ] **Step 6: Commit**

```bash
git add src/components/accounting/navSections/activeTab.ts tests/unit/nav/activeTab.test.ts
git commit -m "feat(nav): split resolver — getActiveModuleId + getActiveTabId collapses to library"
```

---

### Task 8: The switch — `TABS` restructure + `AppLayout` secondary-nav wiring

**Files:**
- Modify: `src/components/accounting/accountingNavConfig.ts`
- Modify: `src/components/layout/AppLayout.tsx`

This is the only commit that changes what every user sees. Land it last.

- [ ] **Step 1: Restructure `TABS`**

In `src/components/accounting/accountingNavConfig.ts`, replace the per-module imports + `TABS` array so only promoted tabs + Library remain. Replace the import block (lines importing salesTab…practiceTab) and the `TABS` definition with:

```ts
import { bankingTab } from './navSections/banking';
import { libraryTab } from './navSections/library';
import { settingsTab } from './navSections/settings';

export const TABS: Tab[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/accounting' },
  { id: 'portfolio', label: 'Portfolio', href: '/accounting/portfolio-workbench' },
  { id: 'workbench', label: 'Month-End', href: '/accounting/month-end-workbench' },
  bankingTab,
  libraryTab,
];

export { settingsTab };
```

Remove the now-unused imports (`salesTab`, `purchasesTab`, `inventoryTab`, `accountingTab`, `reportsTab`, `taxTab`, `payrollTab`, `practiceTab`, `practice`). Keep the type re-exports and `getActiveTabId`/`isLinkActive`/`getActiveModuleId` re-exports. Add `getActiveModuleId` to the `activeTab` re-export line:

```ts
export { getActiveTabId, getActiveModuleId, isLinkActive } from './navSections/activeTab';
```

- [ ] **Step 2: Wire the secondary nav into `AppLayout`**

In `src/components/layout/AppLayout.tsx`:

Add imports near the other component imports:

```tsx
import { SecondaryModuleNav } from '@/components/accounting/SecondaryModuleNav';
import { getActiveModuleId } from '@/components/accounting/accountingNavConfig';
```

Compute the active module id near the top of the component body (after `const router = useRouter();`):

```tsx
  const activeModuleId = getActiveModuleId(router.pathname, router.query as Record<string, string | string[] | undefined>);
  const DEMOTED = ['sales', 'purchases', 'inventory', 'accounting', 'reports', 'tax', 'payroll', 'practice'];
  const showSecondaryNav = DEMOTED.includes(activeModuleId);
```

Then in the JSX, in the top-nav block, render the secondary bar directly under `<AccountingNav />`:

```tsx
        {!showSidebar && !isAdminHost && (
          <div className="relative z-40">
            <AccountingNav />
            {showSecondaryNav && <SecondaryModuleNav moduleId={activeModuleId} />}
          </div>
        )}
```

- [ ] **Step 3: Type-check + lint + nav tests**

Run: `bun run type-check && bun run lint && bunx vitest run tests/unit/nav/`
Expected: all PASS. (Lint will flag any leftover unused module-tab imports in `accountingNavConfig.ts` — remove them.)

- [ ] **Step 4: Build**

Run: `bun run build`
Expected: build succeeds; `/accounting/library` appears in the route manifest.

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/accountingNavConfig.ts src/components/layout/AppLayout.tsx
git commit -m "feat(nav): demote 12 module tabs to Library; wire secondary in-module nav"
```

---

### Task 9: Whole-branch verification gate

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite + type-check + lint**

Run: `bun run type-check && bun run lint && bun run test:unit`
Expected: all green.

- [ ] **Step 2: Manual browser pass (dev server)**

Run: `bun run dev` (port 3200), then verify in **both themes** and **both nav modes**:
- Front door shows exactly 5 tabs: Dashboard · Portfolio · Month-End · Banking · Library.
- Click **Library** → lands on `/accounting/library` grid (8 cards).
- Hover **Library** → flyout lists the 8 modules → their sub-pages.
- Click a card (e.g. Sales) → lands on `/accounting/customers`; top bar highlights **Library**; a **Sales** secondary bar appears with Customers/Transactions/Reports/Statement Run; the active section is highlighted.
- **Banking** still opens its own dropdown and highlights normally (no secondary bar).
- Switch to **sidebar** nav mode → Library nests the 8 modules on hover; clicking Library navigates to the grid.

- [ ] **Step 3: Update module doc if present**

If `src/components/accounting/navSections/.claude.md` or `src/components/layout/.claude.md` exists, add a line documenting the demotion (Library tab + secondary nav). Otherwise skip.

Run: `ls src/components/accounting/navSections/.claude.md src/components/layout/.claude.md 2>/dev/null`

- [ ] **Step 4: Commit any doc change**

```bash
git add -A && git commit -m "docs(nav): record Library demotion in module docs" || echo "no doc change"
```

---

## Self-review

**Spec coverage:**
- §2.1 global no-flag → Task 8 changes `TABS` globally, no flag anywhere. ✓
- §2.2 front door = 5 tabs, Banking promoted, 8 demoted → Task 8 `TABS`; Task 1 `MODULE_TABS` = the 8. ✓
- §2.3 Hybrid (page + flyout + secondary) → landing page Task 6; flyout Tasks 1+2+3; secondary Tasks 4+5+8. ✓
- §2.4 click=link, hover=flyout → Task 2 ModuleNav branch (Link label + onMouseEnter flyout). ✓
- §3.1 resolver split → Task 7. ✓
- §3.2 library config single source → Task 1. ✓
- §3.5 secondary reuses ModuleNav, slate accent, top-mode only, demoted-only → Tasks 5 + 8. ✓
- §3.6 landing page, no API/scoping → Task 6. ✓
- §6 testing (unit pure logic; build/browser for React) → Tasks 1,4,7 unit; Task 9 browser. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `getActiveModuleId`/`getActiveTabId` signatures identical across Tasks 7/8/secondaryNav; `LibraryModule`/`libraryTab` used consistently in Tasks 1/6; `moduleSectionsToTabs`/`getActiveSectionId`/`isSectionActive` consistent across Tasks 4/5; `MODULE_BY_ID` keys match `DEMOTED_MODULE_IDS`. ✓
