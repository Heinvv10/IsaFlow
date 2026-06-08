# UI Modernization — Phase 1 (Two-Theme Design System) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `practitioner | client` theme axis to IsaFlow's existing `--ff-*` token system so the same components render Dense (practitioner) or Warm (client), and prove it on existing primitives plus a new tested `<Money>` primitive.

**Architecture:** Extend the existing CSS-custom-property theming in `styles/globals.css` with a `[data-theme="client"]` override block (mirroring how `.dark` already works). A `ThemeModeContext` — modeled exactly on the existing `TableDensityContext` — sets `data-theme` on `<html>` and persists the choice. All *decision logic* (which mode, which tone string, how to format money) lives in pure `src/lib/` modules tested with the existing Vitest `node` setup. React components are thin token consumers, verified by `type-check` + `build`, not by fabricated component tests (the repo has no jsdom/RTL infra — `vitest.config.ts` is `environment: 'node'`).

**Tech Stack:** Next.js 14 (pages router), TypeScript, Tailwind + CSS custom properties, React Context, Vitest (node env), bun.

**Spec:** `docs/superpowers/specs/2026-06-08-ui-modernization-design.md` (§3.5 visual language, §4 Phase 1).

---

## Pre-flight

- [ ] **Step 0: Create the feature branch**

Never work on `master` or the `design/` branch. Run:

```bash
git checkout master && git pull --ff-only && git checkout -b feat/ui-theme-system
```

Expected: `Switched to a new branch 'feat/ui-theme-system'`.

---

## File Structure

| File | Responsibility | Created/Modified |
|------|----------------|------------------|
| `src/lib/theme/themeMode.ts` | Pure: the `ThemeMode` type + `resolveThemeMode()` decision logic + storage key | Create |
| `src/lib/theme/toneStrings.ts` | Pure: semantic-key → mode-specific copy ("Reconcile 14" vs "14 things to tidy up") | Create |
| `src/lib/money/formatMoney.ts` | Pure: format a number as a ZAR money string | Create |
| `src/contexts/ThemeModeContext.tsx` | React glue: provider that applies `data-theme` to `<html>` + persists | Create |
| `src/components/ui/Money.tsx` | Primitive: renders `formatMoney` output using the `--ff-num-font` token | Create |
| `styles/globals.css` | Add new token axis to `:root` (practitioner) + `[data-theme="client"]` overrides | Modify |
| `src/components/ui/Card.tsx` | Themetize: use `--ff-card-radius` token instead of hard-coded `rounded-xl` | Modify |
| `src/components/ui/index.ts` | Barrel-export `Money` | Modify |
| `pages/_app.tsx` | Mount `ThemeModeProvider` | Modify |
| `tests/unit/lib/theme/themeMode.test.ts` | Tests for `resolveThemeMode` | Create |
| `tests/unit/lib/theme/toneStrings.test.ts` | Tests for `toneString` | Create |
| `tests/unit/lib/money/formatMoney.test.ts` | Tests for `formatMoney` | Create |

---

## Task 1: `resolveThemeMode` — the mode decision (pure, TDD)

Decides whether a request renders the practitioner (Dense) or client (Warm) theme. Inputs that exist in the app today: hostname (a direct-client subdomain), the per-company role (`companyRole` from `CompanyContext`, e.g. `'owner' | 'admin' | 'member' | 'viewer'`), and an explicit user override.

**Files:**
- Create: `src/lib/theme/themeMode.ts`
- Test: `tests/unit/lib/theme/themeMode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/lib/theme/themeMode.test.ts
import { describe, it, expect } from 'vitest';
import { resolveThemeMode } from '@/lib/theme/themeMode';

describe('resolveThemeMode', () => {
  it('defaults to practitioner when nothing specified', () => {
    expect(resolveThemeMode({})).toBe('practitioner');
  });

  it('honours an explicit override above everything else', () => {
    expect(resolveThemeMode({ override: 'client', companyRole: 'admin' })).toBe('client');
    expect(resolveThemeMode({ override: 'practitioner', host: 'client.isaflow.co.za' })).toBe('practitioner');
  });

  it('ignores an invalid override and falls through to other signals', () => {
    expect(resolveThemeMode({ override: 'bogus' as never, companyRole: 'viewer' })).toBe('practitioner');
  });

  it('uses client theme for an owner role (a business owner, not a firm user)', () => {
    expect(resolveThemeMode({ companyRole: 'owner' })).toBe('client');
  });

  it('uses practitioner theme for firm-staff roles', () => {
    expect(resolveThemeMode({ companyRole: 'admin' })).toBe('practitioner');
    expect(resolveThemeMode({ companyRole: 'member' })).toBe('practitioner');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/lib/theme/themeMode.test.ts`
Expected: FAIL — `Cannot find module '@/lib/theme/themeMode'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/theme/themeMode.ts
/**
 * Theme mode — the practitioner/client visual axis.
 * 'practitioner' = Dense (firm staff). 'client' = Warm (business owner / portal).
 * Pure decision logic only; the React glue lives in ThemeModeContext.
 */

export type ThemeMode = 'practitioner' | 'client';

export const THEME_MODE_STORAGE_KEY = 'isaflow.themeMode';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'practitioner' || value === 'client';
}

interface ResolveInput {
  /** Explicit user/localStorage choice — wins when valid. */
  override?: ThemeMode;
  /** Per-company role from CompanyContext. */
  companyRole?: string | null;
  /** Hostname, for a future direct-client subdomain. */
  host?: string | null;
}

/** Roles that indicate a business owner rather than firm staff. */
const CLIENT_ROLES = new Set(['owner', 'client']);

export function resolveThemeMode({ override, companyRole }: ResolveInput): ThemeMode {
  if (isThemeMode(override)) return override;
  if (companyRole && CLIENT_ROLES.has(companyRole)) return 'client';
  return 'practitioner';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/lib/theme/themeMode.test.ts`
Expected: PASS — 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/theme/themeMode.ts tests/unit/lib/theme/themeMode.test.ts
git commit -m "feat(theme): add resolveThemeMode decision logic"
```

---

## Task 2: `toneString` — mode-specific copy (pure, TDD)

The same semantic action reads tersely for practitioners, warmly for clients. Keep keys narrow and real — only what Phase 1 surfaces use.

**Files:**
- Create: `src/lib/theme/toneStrings.ts`
- Test: `tests/unit/lib/theme/toneStrings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/lib/theme/toneStrings.test.ts
import { describe, it, expect } from 'vitest';
import { toneString } from '@/lib/theme/toneStrings';

describe('toneString', () => {
  it('renders terse copy for practitioner', () => {
    expect(toneString('reconcileCta', 'practitioner', { count: 14 })).toBe('Reconcile 14');
  });

  it('renders warm copy for client', () => {
    expect(toneString('reconcileCta', 'client', { count: 14 })).toBe('14 things to tidy up');
  });

  it('falls back to the key when an unknown key is requested', () => {
    expect(toneString('nope' as never, 'client', { count: 1 })).toBe('nope');
  });

  it('handles singular/plural via the count var', () => {
    expect(toneString('reconcileCta', 'client', { count: 1 })).toBe('1 thing to tidy up');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/lib/theme/toneStrings.test.ts`
Expected: FAIL — `Cannot find module '@/lib/theme/toneStrings'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/theme/toneStrings.ts
/**
 * Tone-of-voice copy keyed by semantic action and theme mode.
 * Practitioner = terse/operational. Client = warm/plain-language.
 */
import type { ThemeMode } from './themeMode';

export type ToneKey = 'reconcileCta';

interface ToneVars {
  count: number;
}

type ToneFn = (mode: ThemeMode, vars: ToneVars) => string;

const TONE: Record<ToneKey, ToneFn> = {
  reconcileCta: (mode, { count }) =>
    mode === 'client'
      ? `${count} thing${count === 1 ? '' : 's'} to tidy up`
      : `Reconcile ${count}`,
};

export function toneString(key: ToneKey, mode: ThemeMode, vars: ToneVars): string {
  const fn = TONE[key];
  if (!fn) return String(key);
  return fn(mode, vars);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/lib/theme/toneStrings.test.ts`
Expected: PASS — 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/theme/toneStrings.ts tests/unit/lib/theme/toneStrings.test.ts
git commit -m "feat(theme): add tone-of-voice copy map"
```

---

## Task 3: `formatMoney` — ZAR formatting (pure, TDD)

The `<Money>` primitive (Task 5) renders this. Logic is separated so it can be TDD'd in the node env.

**Files:**
- Create: `src/lib/money/formatMoney.ts`
- Test: `tests/unit/lib/money/formatMoney.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/lib/money/formatMoney.test.ts
import { describe, it, expect } from 'vitest';
import { formatMoney } from '@/lib/money/formatMoney';

describe('formatMoney', () => {
  it('formats a positive amount with the R symbol and thousands separators', () => {
    expect(formatMoney(318400)).toBe('R 318,400.00');
  });

  it('formats negatives with a leading minus before the symbol', () => {
    expect(formatMoney(-2300)).toBe('-R 2,300.00');
  });

  it('rounds to two decimals', () => {
    expect(formatMoney(42100.5)).toBe('R 42,100.50');
  });

  it('can omit decimals when asked', () => {
    expect(formatMoney(1200000, { decimals: 0 })).toBe('R 1,200,000');
  });

  it('renders zero cleanly', () => {
    expect(formatMoney(0)).toBe('R 0.00');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/lib/money/formatMoney.test.ts`
Expected: FAIL — `Cannot find module '@/lib/money/formatMoney'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/money/formatMoney.ts
/**
 * Format a number as a South African Rand string, e.g. "R 318,400.00".
 * Negative amounts render as "-R 2,300.00".
 *
 * Grouping is done manually (comma thousands, dot decimal) rather than via
 * toLocaleString — the 'en-ZA'/'af-ZA' ICU locales disagree on separators
 * across Node builds, and we want a deterministic, test-stable string.
 */

interface FormatMoneyOptions {
  /** Decimal places (default 2). */
  decimals?: number;
}

export function formatMoney(amount: number, options: FormatMoneyOptions = {}): string {
  const decimals = options.decimals ?? 2;
  const negative = amount < 0;
  const fixed = Math.abs(amount).toFixed(decimals); // e.g. "318400.00" or "1200000"
  const [intPart, fracPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fracPart ? `${grouped}.${fracPart}` : grouped;
  return `${negative ? '-' : ''}R ${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/lib/money/formatMoney.test.ts`
Expected: PASS — 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/money/formatMoney.ts tests/unit/lib/money/formatMoney.test.ts
git commit -m "feat(money): add ZAR formatMoney helper"
```

---

## Task 4: Token axis in CSS — the actual Dense/Warm difference

Add new tokens to `:root` (practitioner defaults) and override them in a `[data-theme="client"]` block. This is what makes the same component look different. No test (CSS); verified by build.

**Files:**
- Modify: `styles/globals.css` (inside the existing `@layer base { :root { … } }` and after the `.dark` block)

- [ ] **Step 1: Add practitioner-default tokens to `:root`**

In `styles/globals.css`, immediately after the existing `--ff-shadow-lg:` line (the last `--ff-*` declaration in `:root`, around line 82), add:

```css
    /* ── Theme axis: practitioner (Dense) defaults ──────────────────── */
    /* Numeral font — monospace tabular figures for fast column scanning. */
    --ff-num-font: ui-monospace, 'SF Mono', 'Roboto Mono', monospace;
    /* Display/heading font. */
    --ff-display-font: var(--ff-font-sans);
    /* Card corner radius. */
    --ff-card-radius: var(--ff-radius-md);
    /* Vertical rhythm unit used by feed/list rows. */
    --ff-density-y: 0.375rem;
    /* Base body font scale multiplier. */
    --ff-font-scale: 0.9375;
```

- [ ] **Step 2: Add the client (Warm) override block**

After the closing `}` of the `.dark { … }` block, add a new block. (It composes with `.dark` — a client tenant can still be in dark mode; only the axis tokens change here.)

```css
  /* ── Theme axis: client (Warm) overrides ──────────────────────────── */
  [data-theme='client'] {
    --ff-num-font: var(--ff-font-sans);
    --ff-display-font: Georgia, 'Times New Roman', serif;
    --ff-card-radius: var(--ff-radius-xl);
    --ff-density-y: 0.75rem;
    --ff-font-scale: 1;
  }
```

- [ ] **Step 3: Verify the stylesheet still builds**

Run: `bun run build 2>&1 | tail -20`
Expected: build completes with no CSS/PostCSS error. (If the full build is slow, `bun run lint` also parses the CSS import; either is acceptable as the gate.)

- [ ] **Step 4: Commit**

```bash
git add styles/globals.css
git commit -m "feat(theme): add practitioner/client token axis to globals.css"
```

---

## Task 5: `<Money>` primitive — first token consumer

A span that formats via `formatMoney` and renders in the active `--ff-num-font` (mono for practitioner, sans for client). No component test (no RTL infra); the formatting logic is already covered in Task 3. Verified by `type-check`.

**Files:**
- Create: `src/components/ui/Money.tsx`
- Modify: `src/components/ui/index.ts`

- [ ] **Step 1: Write the component**

```tsx
// src/components/ui/Money.tsx
/**
 * Money — renders a ZAR amount in the active theme's numeral font.
 * Formatting logic lives in @/lib/money/formatMoney (unit-tested).
 */
import * as React from 'react';
import { cn } from '@/utils/cn';
import { formatMoney } from '@/lib/money/formatMoney';

export interface MoneyProps extends React.HTMLAttributes<HTMLSpanElement> {
  amount: number;
  /** Decimal places (default 2). */
  decimals?: number;
}

export function Money({ amount, decimals, className, style, ...props }: MoneyProps) {
  return (
    <span
      className={cn('tabular-nums', className)}
      style={{ fontFamily: 'var(--ff-num-font)', ...style }}
      {...props}
    >
      {formatMoney(amount, { decimals })}
    </span>
  );
}

Money.displayName = 'Money';
```

- [ ] **Step 2: Barrel-export it**

In `src/components/ui/index.ts`, after the `Card` export block (around the `export type { CardProps }` line), add:

```typescript
export { Money } from './Money';
export type { MoneyProps } from './Money';
```

- [ ] **Step 3: Verify types compile**

Run: `bun run type-check`
Expected: PASS — no new errors mentioning `Money`.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/Money.tsx src/components/ui/index.ts
git commit -m "feat(ui): add Money primitive consuming --ff-num-font"
```

---

## Task 6: Themetize `Card` — prove an existing primitive flips

Replace the hard-coded `rounded-xl` with the `--ff-card-radius` token so `Card` corners soften under the client theme. Minimal, surgical — leave all other classes intact.

**Files:**
- Modify: `src/components/ui/Card.tsx` (the root `Card` function's `cn(...)` call, currently starting `'rounded-xl border border-gray-200 …'`)

- [ ] **Step 1: Destructure `style` so it can be merged safely**

In `src/components/ui/Card.tsx`, the root `Card` function currently destructures:

```tsx
function Card({
  className,
  header,
  footer,
  hoverable = false,
  noPadding = false,
  children,
  ...props
}: CardProps) {
```

Add `style` to the destructure so it is no longer swept into `...props` (otherwise an undefined `props.style` from the spread would clobber our token):

```tsx
function Card({
  className,
  header,
  footer,
  hoverable = false,
  noPadding = false,
  children,
  style,
  ...props
}: CardProps) {
```

- [ ] **Step 2: Apply the token to the root `<div>`**

Change the first class string from:

```tsx
        'rounded-xl border border-gray-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)]',
```

to (drop `rounded-xl`):

```tsx
        'border border-gray-200 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06)]',
```

and add a merged `style` prop to the same `<div>`, immediately before `{...props}`:

```tsx
      style={{ borderRadius: 'var(--ff-card-radius)', ...style }}
```

A caller-supplied `style.borderRadius` still wins (it spreads last).

- [ ] **Step 3: Verify types compile**

Run: `bun run type-check`
Expected: PASS — no errors in `Card.tsx`.

- [ ] **Step 4: Verify the build is clean**

Run: `bun run lint 2>&1 | tail -20`
Expected: no new lint errors for `Card.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/Card.tsx
git commit -m "feat(ui): Card corner radius now follows --ff-card-radius token"
```

---

## Task 7: `ThemeModeContext` — apply `data-theme` to `<html>`

Provider modeled exactly on `src/contexts/TableDensityContext.tsx`: holds the mode, persists to localStorage, and writes `data-theme` onto `document.documentElement` so the CSS overrides take effect. Thin glue; verified by `type-check` + `build`.

**Files:**
- Create: `src/contexts/ThemeModeContext.tsx`

- [ ] **Step 1: Write the provider**

```tsx
// src/contexts/ThemeModeContext.tsx
/**
 * ThemeModeContext — the practitioner/client visual axis.
 * Writes `data-theme` onto <html> so the CSS token overrides in globals.css
 * apply. Modeled on TableDensityContext (localStorage-persisted UI preference).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  type ThemeMode,
  THEME_MODE_STORAGE_KEY,
  isThemeMode,
  resolveThemeMode,
} from '@/lib/theme/themeMode';

interface ThemeModeContextType {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeContextType | undefined>(undefined);

export function ThemeModeProvider({
  children,
  companyRole,
}: {
  children: ReactNode;
  /** Optional role hint; the override in localStorage still wins. */
  companyRole?: string | null;
}) {
  const [mode, setModeState] = useState<ThemeMode>('practitioner');

  // Hydrate: explicit stored override wins, else derive from role.
  useEffect(() => {
    const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    const resolved = resolveThemeMode({
      override: isThemeMode(saved) ? saved : undefined,
      companyRole,
    });
    setModeState(resolved);
  }, [companyRole]);

  // Reflect onto <html> so CSS [data-theme='client'] applies.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', mode);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    localStorage.setItem(THEME_MODE_STORAGE_KEY, next);
  }, []);

  const value = useMemo<ThemeModeContextType>(() => ({ mode, setMode }), [mode, setMode]);

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
}

export function useThemeMode(): ThemeModeContextType {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode must be used within ThemeModeProvider');
  return ctx;
}
```

- [ ] **Step 2: Verify types compile**

Run: `bun run type-check`
Expected: PASS — no errors in `ThemeModeContext.tsx`.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/ThemeModeContext.tsx
git commit -m "feat(theme): add ThemeModeProvider that sets data-theme on <html>"
```

---

## Task 8: Wire the provider into the app

Mount `ThemeModeProvider` in `pages/_app.tsx` inside `CompanyProvider` (so a future role hint is reachable) and outside `TableDensityProvider`. Default `companyRole` omitted in Phase 1 — practitioner is the default, and the localStorage override drives any client preview.

**Files:**
- Modify: `pages/_app.tsx`

- [ ] **Step 1: Import the provider**

In `pages/_app.tsx`, after the existing `TableDensityProvider` import (line 7), add:

```typescript
import { ThemeModeProvider } from '@/contexts/ThemeModeContext';
```

- [ ] **Step 2: Wrap the tree**

In the JSX, wrap the existing `TableDensityProvider` with `ThemeModeProvider`. Change:

```tsx
        <CompanyProvider>
        <TableDensityProvider>
```

to:

```tsx
        <CompanyProvider>
        <ThemeModeProvider>
        <TableDensityProvider>
```

and add the matching closing tag — change:

```tsx
        </TableDensityProvider>
        </CompanyProvider>
```

to:

```tsx
        </TableDensityProvider>
        </ThemeModeProvider>
        </CompanyProvider>
```

- [ ] **Step 2b: Verify the JSX nesting is balanced**

Run: `bun run type-check`
Expected: PASS — no "unterminated JSX" / mismatched-tag errors.

- [ ] **Step 3: Manual verification in the running app**

Run: `bun run dev` (serves on :3200). Then in the browser devtools console:

```js
// Default should be practitioner:
document.documentElement.getAttribute('data-theme'); // → "practitioner"
// Force the client theme and watch a Card soften + numbers switch to sans:
localStorage.setItem('isaflow.themeMode', 'client'); location.reload();
document.documentElement.getAttribute('data-theme'); // → "client"
```

Expected: with `data-theme="client"`, any `<Card>` shows a larger corner radius and any `<Money>` renders in the sans font; resetting to `practitioner` restores tight radius + mono numerals. Reset afterwards:

```js
localStorage.removeItem('isaflow.themeMode'); location.reload();
```

- [ ] **Step 4: Commit**

```bash
git add pages/_app.tsx
git commit -m "feat(theme): mount ThemeModeProvider in _app"
```

---

## Final verification

- [ ] **Step 1: Full unit suite**

Run: `bun run test:unit`
Expected: PASS — including the 3 new files (14 new assertions across Tasks 1–3).

- [ ] **Step 2: Type-check + lint gate**

Run: `bun run type-check && bun run lint`
Expected: both clean (no new errors).

- [ ] **Step 3: Production build**

Run: `bun run build`
Expected: build succeeds.

- [ ] **Step 4: Open a PR**

```bash
git push -u origin feat/ui-theme-system
gh pr create --fill --base master
```

Then request review via the repo's `/review` skill (blind review — do not self-review).

---

## What Phase 1 deliberately does NOT do (deferred to later phases)

- The practice cockpit / cross-client feed shell (Phase 2 — needs its own spec because of the cross-tenant RLS access question).
- Reconciliation surface, side-panel create/edit, AI bar (Phases 3–6).
- A user-facing theme switcher in the header. Phase 1 ships the *engine*; the switcher and role-driven defaults land when the client portal does (Phase 5). For now the localStorage override is the preview mechanism.
- Themetizing every primitive. Phase 1 proves the pattern on `Card` + `Money`; the rest follow as surfaces are rebuilt.
