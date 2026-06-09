# Reconciliation Keyboard Row-Stream — Design (Phase 3, Increment 1)

**Date:** 2026-06-09
**Status:** Approved
**Parent roadmap:** `docs/superpowers/specs/2026-06-08-ui-modernization-design.md` §3.2 (Reconciliation — the heartbeat)

## Goal

Make the daily bank-reconciliation grind keyboard-fast. Add a keyboard-navigation layer over the **existing** `/accounting/bank-transactions` "New" (imported) queue so a bookkeeper can clear transactions without the mouse: arrow between rows, **Enter** to accept the suggested allocation, **E** edit, **X** exclude, **S** split. This is the spec's "row-stream with one-key accept" — the first of Phase 3's three sub-features.

## Why this first

Exploration confirmed Phase 3's machinery already exists: the full `bank_transactions` model with `suggested_*` fields + `suggested_confidence`, the `BankTxTable` UI, the rules→patterns→history smart-categorize pipeline, the `allocate → createJournalEntry → postJournalEntry` posting flow, and **learn-from-corrections** (`learnFromAllocation` fires on every accept). The single biggest gap is that there is **zero keyboard navigation** in the table — every accept needs a mouse. This increment fills exactly that gap with maximum reuse and no data/API/service change.

## Non-goals (YAGNI)

- **No confidence auto-post** — auto-accepting suggestions above a threshold so the queue shrinks to only uncertain items is Phase 3 Increment 2 (it carries a trust/correctness decision of its own).
- **No spreadsheet-grid toggle** — the bulk Excel-style power view is Increment 3.
- **No LLM categorization tier** — wiring the written-but-unused `aiCategorizationService` is a separate, cost-bearing increment.
- **No vim aliases (J/K) or a `?` help overlay** — keep the first cut to the spec's named keys.
- **Only the "New"/imported tab** gets the keyboard stream (that is the reconciliation queue). The Reviewed/Excluded tabs are unchanged.
- **No new route, no API, no migration, no service change** — purely a presentation/interaction layer over the shipped surface.

## Architecture

A keyboard layer that drives the **existing** `useBankTxActions` handlers. The only new logic is (a) a pure key→action resolver and (b) a hook that owns row focus and dispatches. The existing allocate/exclude/split flows — and the JE posting and the learn-from-corrections side effect — are reused verbatim.

```
keydown (on table container)
  → resolveBankTxKey(key, ctx)            // pure, ctx = { isEditingCell, hasSuggestion }
  → action | null                         // 'next'|'prev'|'accept'|'edit'|'exclude'|'split'|'blur-to-row'|null
  → useBankTxKeyboardNav dispatch
      → existing useBankTxActions handler (allocate / exclude / split)  // accept/exclude/split
      → or focus move (next/prev/edit/blur-to-row)
  → on accept SUCCESS: auto-advance focus to the next row
```

## Components

### 1. `resolveBankTxKey(key, ctx)` — pure resolver (the tested seam)

Location: `src/modules/accounting/services/bank/bankTxKeyboard.ts` (pure, no React/DOM imports).

```ts
export type BankTxKeyAction =
  | 'next' | 'prev' | 'accept' | 'edit' | 'exclude' | 'split' | 'blur-to-row';

export interface BankTxKeyContext {
  /** True when focus is inside a cell input/select/textarea (typing). */
  isEditingCell: boolean;
  /** True when the focused row has a suggested allocation to accept. */
  hasSuggestion: boolean;
}

export function resolveBankTxKey(key: string, ctx: BankTxKeyContext): BankTxKeyAction | null {
  if (ctx.isEditingCell) {
    // While typing in a cell, only Escape is ours (return focus to the row); let everything else be native.
    return key === 'Escape' ? 'blur-to-row' : null;
  }
  switch (key) {
    case 'ArrowDown': return 'next';
    case 'ArrowUp':   return 'prev';
    case 'Enter':     return ctx.hasSuggestion ? 'accept' : 'edit';
    case 'e': case 'E': return 'edit';
    case 'x': case 'X': return 'exclude';
    case 's': case 'S': return 'split';
    default: return null;
  }
}
```

Decisions baked in:
- **Enter on a no-suggestion row → `edit`** (focus the entity selector) rather than a no-op — pressing Enter always moves the user forward.
- **Hotkeys suppressed while typing** (`isEditingCell`) — the correctness guard that prevents `e`/`x`/`s` firing inside a description/search field. Only `Escape` is intercepted there, to pop focus back to the row.

### 2. `useBankTxKeyboardNav(...)` — focus + dispatch hook

Location: `src/components/accounting/bank-transactions/useBankTxKeyboardNav.ts`.

Owns `focusedRowIndex` (number | null). Attaches one `keydown` listener to the table container. On each key:
1. Derive `isEditingCell` from `document.activeElement` tag (`INPUT`/`TEXTAREA`/`SELECT` or `[contenteditable]`).
2. Look up the focused row's `hasSuggestion` (a row has a suggestion when `suggested_gl_account_id` / `suggested_supplier_id` / `suggested_client_id` is set — the same fields the table already reads).
3. `action = resolveBankTxKey(e.key, { isEditingCell, hasSuggestion })`. If `null`, return (native handling). Otherwise `e.preventDefault()` and dispatch:
   - `next`/`prev` → clamp + set `focusedRowIndex`, scroll the row into view.
   - `edit` → focus the focused row's entity/account selector (a ref the row exposes).
   - `accept` → call the existing accept/allocate handler for that row; **on the returned promise's success, advance to the next row**; on failure, stay (the existing toast explains why, e.g. closed period).
   - `exclude` / `split` → call the existing handlers (which open their modals); focus moves into the modal.
   - `blur-to-row` → blur the active cell input, return focus to the row container.

Inputs: the visible rows array, the focused index state, and the existing action callbacks from `useBankTxActions` (passed in — the hook does not re-implement them). Refs for row elements + the per-row "edit" target are provided by `BankTxTable`.

### 3. `BankTxTable` wiring

- Each row: `tabIndex={focusedRowIndex === i ? 0 : -1}`, a forwarded `ref`, and a visible **focused-row highlight** (a `--ff-*`-token ring/background) so the keyboard position is obvious.
- A **keyboard-hint footer** under the table: `↑↓ move · Enter accept · E edit · X exclude · S split` (tokenised, subtle).
- The existing Accept / Exclude / Split button handlers are passed into `useBankTxKeyboardNav` unchanged — the keyboard path and the mouse path invoke the same callbacks.
- Clicking a row also sets `focusedRowIndex` (mouse and keyboard stay in sync).

## Data flow & tenant safety

No data-layer change. Accept reuses `allocate` (which already scopes by `company_id` and posts a balanced JE via `postJournalEntry`); exclude/split reuse their existing company-scoped handlers. No new query, no URL-supplied id, no new endpoint — so no new tenant surface.

## Error handling

- Accept failure (e.g. closed fiscal period — the existing `allocate` surfaces this): the existing toast fires and focus **stays on the row** (no advance), so the user can act on it. No new error path.
- Empty queue: `focusedRowIndex = null`, listener is a no-op.
- Focused row leaving the list after accept/exclude: advance to the next index, clamped to the new length (or `null` if the list is now empty).

## Testing

- **Unit (pure):** `resolveBankTxKey` truth table — every key in both `isEditingCell` states, the `Enter → accept` vs `Enter → edit` (no-suggestion) branch, and that arbitrary keys / hotkeys-while-editing return `null`. This is the load-bearing logic and is fully covered without a DOM.
- **Type-check / lint / build:** the hook + `BankTxTable` focus wiring (React/DOM glue) is covered here, consistent with the repo's no-jsdom convention — do not fabricate component tests.
- **Browser (local dev, real DB):** keyboard a real imported queue — ↓ moves the highlight, Enter on a suggested row posts the allocation and advances, E focuses the selector, X opens exclude, S opens split, Esc pops back from a cell; hotkeys do not fire while typing in a cell; console clean.

## Success criteria

- A bookkeeper can clear a suggested transaction with a single `Enter` and the focus advances — no mouse.
- Typing in a cell never triggers a hotkey (the `isEditingCell` guard).
- The mouse path is unchanged; existing actions, JE posting, and learn-from-corrections are reused, not duplicated.
- Zero data-model / API / service / tenant change.

## Open questions for planning

- Exact ref plumbing for the per-row "edit" target (which selector E focuses — the type selector vs the entity selector) — confirm against `BankTxTable`'s current row JSX during planning.
- Whether the keydown listener lives on the table container or the page (scope of capture vs. interfering with the filter bar / batch panel inputs) — favour the table container so the filter inputs keep native behaviour.
- The focused-row highlight token (reuse an existing `--ff-*` ring/background already used elsewhere for selection).
