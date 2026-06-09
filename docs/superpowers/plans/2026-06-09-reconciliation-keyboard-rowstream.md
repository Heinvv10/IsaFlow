# Reconciliation Keyboard Row-Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a keyboard-navigation layer to the existing `/accounting/bank-transactions` "New" queue so a bookkeeper clears transactions without the mouse: ↑↓ between rows, Enter accepts the selected allocation (and the queue advances), E edit, X exclude, S split.

**Architecture:** A pure `resolveBankTxKey(key, ctx)` resolver decides the action; a `useBankTxKeyboardNav` hook owns row focus and dispatches to the **existing** `BankTxTable` callbacks (`onAccept`/`onExclude`/`onSplit`) — no new actions, no API/migration/service change. `BankTxTable` gains minimal wiring (a keydown container, per-row `tabIndex`/`ref`/highlight, a hint footer). A successful accept reloads the queue and the accepted row drops out, so a fixed `focusedIndex` naturally lands on the next row; a failed accept leaves the row in place.

**Tech Stack:** Next.js 14 (pages router), TypeScript, React 18, Vitest (node-env, pure logic only).

**Branch / worktree:** `feat/recon-keyboard-rowstream` (worktree `.claude/worktrees/recon-rowstream`, off master `5a22c8f7`). Spec committed at `909fab49`.

**Spec:** `docs/superpowers/specs/2026-06-09-reconciliation-keyboard-rowstream-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/components/accounting/bankTxKeyboard.ts` (create) | Pure `resolveBankTxKey(key, ctx)` — the tested decision seam. Co-located with `BankTxTable.tsx`. |
| `tests/unit/bank/bankTxKeyboard.test.ts` (create) | Truth-table unit tests for the resolver. |
| `src/components/accounting/useBankTxKeyboardNav.ts` (create) | Hook: owns `focusedIndex`, keydown handler, focus management; dispatches to the passed-in callbacks. Returns `containerProps` + `getRowProps`. |
| `src/components/accounting/BankTxTable.tsx` (modify) | Call the hook; spread `containerProps` on the table wrapper; spread `getRowProps` per `<tr>`; render a keyboard-hint footer. Minimal additions only — do NOT refactor this already-large file. |

> **Note (resolver location):** the spec proposed `src/modules/accounting/services/bank/bankTxKeyboard.ts`, but this is pure UI-interaction logic, so it co-locates with `BankTxTable.tsx` under `src/components/accounting/`. Refinement recorded.

> **Note (accept gate):** the spec says "Enter accepts the suggested allocation." `BankTxTable`'s Accept button is disabled unless `rowSelections[txId]?.entityId` is set (BankTxTable.tsx:565). Suggestions seed `rowSelections` on load, so this is realized as `canAccept = !!rowSelections[txId]?.entityId` — Enter accepts whenever the row has a selected allocation (suggested or user-picked), matching the button's own enabled state.

---

## Task 1: Pure key resolver

**Files:**
- Create: `src/components/accounting/bankTxKeyboard.ts`
- Test: `tests/unit/bank/bankTxKeyboard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/bank/bankTxKeyboard.test.ts
import { describe, it, expect } from 'vitest';
import { resolveBankTxKey } from '@/components/accounting/bankTxKeyboard';

describe('resolveBankTxKey', () => {
  const row = { isEditingCell: false, canAccept: true };

  it('navigates with arrows', () => {
    expect(resolveBankTxKey('ArrowDown', row)).toBe('next');
    expect(resolveBankTxKey('ArrowUp', row)).toBe('prev');
  });

  it('Enter accepts when the row has a selected allocation', () => {
    expect(resolveBankTxKey('Enter', { isEditingCell: false, canAccept: true })).toBe('accept');
  });

  it('Enter edits when the row has no selected allocation', () => {
    expect(resolveBankTxKey('Enter', { isEditingCell: false, canAccept: false })).toBe('edit');
  });

  it('maps the hotkeys (case-insensitive)', () => {
    expect(resolveBankTxKey('e', row)).toBe('edit');
    expect(resolveBankTxKey('E', row)).toBe('edit');
    expect(resolveBankTxKey('x', row)).toBe('exclude');
    expect(resolveBankTxKey('X', row)).toBe('exclude');
    expect(resolveBankTxKey('s', row)).toBe('split');
    expect(resolveBankTxKey('S', row)).toBe('split');
  });

  it('ignores unmapped keys', () => {
    expect(resolveBankTxKey('a', row)).toBeNull();
    expect(resolveBankTxKey('Tab', row)).toBeNull();
  });

  it('while editing a cell, only Escape is intercepted (returns blur-to-row); everything else is native', () => {
    const editing = { isEditingCell: true, canAccept: true };
    expect(resolveBankTxKey('Escape', editing)).toBe('blur-to-row');
    expect(resolveBankTxKey('Enter', editing)).toBeNull();
    expect(resolveBankTxKey('e', editing)).toBeNull();
    expect(resolveBankTxKey('x', editing)).toBeNull();
    expect(resolveBankTxKey('ArrowDown', editing)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run tests/unit/bank/bankTxKeyboard.test.ts`
Expected: FAIL — `Cannot find module '@/components/accounting/bankTxKeyboard'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/components/accounting/bankTxKeyboard.ts
/**
 * Pure key→action resolver for the bank-transactions keyboard row-stream.
 * No React/DOM imports — the hook supplies the context and performs the effects.
 *
 * While a cell input/select/textarea is focused (isEditingCell), only Escape is
 * ours (pop focus back to the row); every other key is left to native handling
 * so typing in a field never triggers a hotkey.
 */
export type BankTxKeyAction =
  | 'next' | 'prev' | 'accept' | 'edit' | 'exclude' | 'split' | 'blur-to-row';

export interface BankTxKeyContext {
  /** Focus is inside a cell input/select/textarea (i.e. the user is typing). */
  isEditingCell: boolean;
  /** The focused row has a selected allocation (suggested or user-picked) ready to post. */
  canAccept: boolean;
}

export function resolveBankTxKey(key: string, ctx: BankTxKeyContext): BankTxKeyAction | null {
  if (ctx.isEditingCell) {
    return key === 'Escape' ? 'blur-to-row' : null;
  }
  switch (key) {
    case 'ArrowDown': return 'next';
    case 'ArrowUp':   return 'prev';
    case 'Enter':     return ctx.canAccept ? 'accept' : 'edit';
    case 'e': case 'E': return 'edit';
    case 'x': case 'X': return 'exclude';
    case 's': case 'S': return 'split';
    default: return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run tests/unit/bank/bankTxKeyboard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/bankTxKeyboard.ts tests/unit/bank/bankTxKeyboard.test.ts
git commit -m "feat(bank): pure resolveBankTxKey resolver for keyboard row-stream"
```

---

## Task 2: The `useBankTxKeyboardNav` hook

**Files:**
- Create: `src/components/accounting/useBankTxKeyboardNav.ts`

This hook owns the focused row index, listens for keydown on the table container, and dispatches to the existing callbacks. It returns props the table spreads onto its container and rows. It does not await the accept callback: on a successful accept the page reloads the queue and the accepted row leaves the list, so keeping `focusedIndex` fixed lands on the next row; on failure the row stays.

- [ ] **Step 1: Write the implementation**

```ts
// src/components/accounting/useBankTxKeyboardNav.ts
/**
 * Keyboard row-stream navigation for BankTxTable. Owns the focused row index,
 * derives the key context, and dispatches to the table's existing callbacks
 * (onAccept/onExclude/onSplit). Hotkeys are suppressed while a cell input is
 * focused (see resolveBankTxKey). 'edit' opens the row's entity dropdown via the
 * [data-bank-toggle] button; 'blur-to-row' returns focus from a cell to the row.
 *
 * No explicit advance after accept: a successful accept reloads the queue and the
 * accepted row drops out, so a fixed index naturally points at the next row.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveBankTxKey } from '@/components/accounting/bankTxKeyboard';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

interface UseBankTxKeyboardNavArgs {
  transactions: BankTx[];
  rowSelections: Record<string, RowSelection>;
  onAccept: (txId: string) => void;
  onExclude: (txId: string) => void;
  onSplit: (txId: string) => void;
}

function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}

export function useBankTxKeyboardNav({
  transactions, rowSelections, onAccept, onExclude, onSplit,
}: UseBankTxKeyboardNavArgs) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

  // Keep the index in range as the queue shrinks (e.g. after accept/exclude reload).
  useEffect(() => {
    setFocusedIndex(prev => {
      if (prev === null) return prev;
      if (transactions.length === 0) return null;
      return Math.min(prev, transactions.length - 1);
    });
  }, [transactions.length]);

  const focusRow = useCallback((index: number) => {
    rowRefs.current[index]?.focus();
    rowRefs.current[index]?.scrollIntoView({ block: 'nearest' });
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (transactions.length === 0) return;
    const index = focusedIndex ?? 0;
    const tx = transactions[index];
    if (!tx) return;

    const ctx = {
      isEditingCell: isTypingTarget(document.activeElement),
      canAccept: !!rowSelections[tx.id]?.entityId,
    };
    const action = resolveBankTxKey(e.key, ctx);
    if (!action) return;
    e.preventDefault();

    switch (action) {
      case 'next': {
        const ni = Math.min(index + 1, transactions.length - 1);
        setFocusedIndex(ni); focusRow(ni); break;
      }
      case 'prev': {
        const pi = Math.max(index - 1, 0);
        setFocusedIndex(pi); focusRow(pi); break;
      }
      case 'accept':  onAccept(tx.id); break;
      case 'exclude': onExclude(tx.id); break;
      case 'split':   onSplit(tx.id); break;
      case 'edit': {
        const row = rowRefs.current[index];
        const toggle = row?.querySelector<HTMLElement>('[data-bank-toggle]');
        toggle?.click();
        break;
      }
      case 'blur-to-row': {
        (document.activeElement as HTMLElement | null)?.blur();
        focusRow(index);
        break;
      }
    }
  }, [transactions, rowSelections, focusedIndex, focusRow, onAccept, onExclude, onSplit]);

  const containerProps = { onKeyDown };

  const getRowProps = (index: number) => ({
    ref: (el: HTMLTableRowElement | null) => { rowRefs.current[index] = el; },
    tabIndex: -1,
    'data-focused': focusedIndex === index ? true : undefined,
    onClick: () => setFocusedIndex(index),
  });

  return { focusedIndex, containerProps, getRowProps };
}
```

- [ ] **Step 2: Verify it type-checks and lints**

Run: `bun run type-check && bun run lint`
Expected: PASS. (`BankTx`/`RowSelection` are exported from `BankTxTable.tsx`; confirm the import resolves.)

- [ ] **Step 3: Commit**

```bash
git add src/components/accounting/useBankTxKeyboardNav.ts
git commit -m "feat(bank): useBankTxKeyboardNav hook — focus + dispatch for the row-stream"
```

---

## Task 3: Wire the keyboard layer into `BankTxTable`

**Files:**
- Modify: `src/components/accounting/BankTxTable.tsx`

Minimal additions only. Do NOT refactor the file.

- [ ] **Step 1: Call the hook and wire the container**

At the top of the `BankTxTable` component body (after props are destructured), add:

```tsx
  const { containerProps, getRowProps } = useBankTxKeyboardNav({
    transactions, rowSelections, onAccept, onExclude, onSplit,
  });
```

Add the import near the other imports at the top of the file:

```tsx
import { useBankTxKeyboardNav } from '@/components/accounting/useBankTxKeyboardNav';
```

Wrap the existing `<table>...</table>` in a focusable div that carries the keydown handler. Find the table's current outer wrapper (the element directly enclosing `<table>`); add `{...containerProps}` and `tabIndex={0}` to it (or introduce a `<div {...containerProps} tabIndex={0}>` immediately around the `<table>` if there is no suitable wrapper). Example:

```tsx
      <div {...containerProps} tabIndex={0} className="outline-none">
        <table className="w-full text-sm">
          {/* ...unchanged... */}
        </table>
      </div>
```

- [ ] **Step 2: Add per-row focus props + highlight**

Change the row open tag (BankTxTable.tsx:288-291) from:

```tsx
              <tr key={tx.id} className={`border-b border-[var(--ff-border-light)]/50 hover:bg-[var(--ff-bg-secondary)]/50 ${
                isOpen ? 'bg-blue-500/5' : isAllocated ? 'bg-teal-500/5' : ''
              } ${isExcluded ? 'opacity-60' : ''}`}>
```

to (note `index` — add it to the `.map` at line 275: `transactions.map((tx, index) => {`):

```tsx
              <tr
                key={tx.id}
                {...getRowProps(index)}
                className={`border-b border-[var(--ff-border-light)]/50 hover:bg-[var(--ff-bg-secondary)]/50 outline-none data-[focused]:bg-[var(--ff-bg-tertiary)] data-[focused]:ring-1 data-[focused]:ring-inset data-[focused]:ring-[var(--ff-border-strong)] ${
                  isOpen ? 'bg-blue-500/5' : isAllocated ? 'bg-teal-500/5' : ''
                } ${isExcluded ? 'opacity-60' : ''}`}
              >
```

> If `--ff-border-strong` is not a defined token, use `--ff-border-primary` (verify against `styles/globals.css` during implementation; pick an existing token used for selection/active emphasis — do NOT invent one).

- [ ] **Step 3: Add the keyboard-hint footer**

Immediately after the closing `</table>` (inside the wrapper div from Step 1), only on the `new` tab, add:

```tsx
        {tab === 'new' && transactions.length > 0 && (
          <div className="px-3 py-2 text-xs text-[var(--ff-text-tertiary)] border-t border-[var(--ff-border-light)]/50 flex gap-4">
            <span><kbd className="font-mono">↑↓</kbd> move</span>
            <span><kbd className="font-mono">Enter</kbd> accept</span>
            <span><kbd className="font-mono">E</kbd> edit</span>
            <span><kbd className="font-mono">X</kbd> exclude</span>
            <span><kbd className="font-mono">S</kbd> split</span>
          </div>
        )}
```

- [ ] **Step 4: Verify it type-checks, lints, and builds**

Run: `bun run type-check && bun run lint && bun run build`
Expected: PASS. (`index` added to the map; `getRowProps`/`containerProps` spread correctly; `data-[focused]:` Tailwind variant compiles.)

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/BankTxTable.tsx
git commit -m "feat(bank): wire keyboard row-stream into BankTxTable (focus, hotkeys, hint)"
```

---

## Task 4: Full gate + browser verification

- [ ] **Step 1: Run the full unit suite + build**

Run: `bunx vitest run tests/unit/bank/bankTxKeyboard.test.ts && bun run type-check && bun run lint && bun run build`
Expected: all PASS.

- [ ] **Step 2: Browser verification (record findings)**

Against a dev server on the worktree (with a bank account that has imported transactions). Confirm on the `/accounting/bank-transactions` "New" tab:
- ↓/↑ moves a visible focused-row highlight; the focused row scrolls into view.
- On a row with a suggestion (selected allocation), **Enter** posts the allocation and the highlight lands on the next row (the accepted row drops out of "New").
- On a row with no selection, **Enter** and **E** open the entity dropdown.
- **X** opens the exclude-reason modal; **S** opens the split modal.
- Typing in the inline notes field or the dropdown search does NOT trigger hotkeys; **Esc** returns focus from a cell to the row.
- Console clean.

- [ ] **Step 3: Commit any verification fixes, then push + PR**

```bash
git push -u origin feat/recon-keyboard-rowstream   # pre-push hook runs next build (~3-4 min); use: timeout 420 git push ...
gh pr create --fill --base master
```

---

## Self-Review

**Spec coverage:**
- §Component 1 resolver (`resolveBankTxKey`, isEditingCell guard, Enter→accept/edit) → Task 1. ✓
- §Component 2 hook (focusedRowIndex, isEditingCell from activeElement, dispatch to existing handlers, advance behaviour) → Task 2. ✓ (advance realised by fixed-index-after-reload + the length-clamp effect, not an awaited promise — documented.)
- §Component 3 BankTxTable wiring (tabIndex/ref, focused highlight, hint footer, reuse existing handlers) → Task 3. ✓
- §Keymap (↑↓/Enter/E/X/S/Esc) → Task 1 resolver + Task 2 dispatch. ✓
- §Scope: only the "new" tab gets the hint; no auto-post/grid/LLM/vim; no API/migration/service change. ✓
- §Tenant safety: reuses `onAccept`→`handleAccept`→`allocate` (company-scoped); no new query/endpoint. ✓
- §Testing: resolver unit-tested (Task 1); hook+wiring via type-check/lint/build + browser (Tasks 2-4). ✓

**Placeholder scan:** No TBD/TODO. Every code step shows full code. The two `>` callouts (resolver location refinement; the `--ff-border-strong` token check) are real verification prompts against existing code, not placeholders.

**Type consistency:** `BankTxKeyAction`/`BankTxKeyContext` defined in Task 1, consumed in Task 2. `resolveBankTxKey(key, ctx)` signature identical across tasks. `useBankTxKeyboardNav({transactions, rowSelections, onAccept, onExclude, onSplit})` returns `{ focusedIndex, containerProps, getRowProps }` — consumed exactly in Task 3. `canAccept = !!rowSelections[txId]?.entityId` matches BankTxTable's Accept-button gate (`!sel?.entityId`). `getRowProps(index)` matches the `(tx, index)` map change. Props `onAccept`/`onExclude`/`onSplit` match BankTxTable's existing Props (BankTxTable.tsx:101,102,104).
