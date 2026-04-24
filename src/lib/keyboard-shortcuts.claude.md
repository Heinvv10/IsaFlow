# keyboard-shortcuts.ts

## Purpose
Registry types and parser helpers for the global keyboard-shortcut system — single-key, modifier combos, and two-key sequences like `g d`.

## Key exports
- `type ShortcutCategory` — `'global' | 'navigation' | 'actions' | 'table'`
- `interface ShortcutConfig` — `{ key, label, description, category, action, enabled? }`
- `interface ParsedShortcut` — `{ ctrl, meta, shift, alt, keys[], isSequence }`
- `parseShortcut(key: string): ParsedShortcut` — parses `'ctrl+k'`, `'?'`, `'g d'`, `'cmd+n'`, etc.
- `matchesShortcut(event: KeyboardEvent, shortcut: ParsedShortcut): boolean` — tests a single keydown against a non-sequence shortcut
- `const CATEGORY_LABELS: Record<ShortcutCategory, string>` — human labels for the help overlay
- `const CATEGORY_ORDER: ShortcutCategory[]` — canonical sort order in the help overlay

## Dependencies
None.

## Critical notes
- Sequences use a **space separator** (`'g d'`). Sequences cannot include modifiers — `parseShortcut` treats the whole string as a keyword list.
- `matchesShortcut` treats `ctrl` and `meta`/`cmd` as equivalent (`event.ctrlKey || event.metaKey`) — so `'ctrl+k'` fires for both Ctrl+K on Windows/Linux and ⌘+K on macOS. Do not register `'meta+k'` separately.
- For sequences, `matchesShortcut` returns `false` immediately — callers must track the sequence state themselves (typically a hook that watches for the first key, then the second within a timeout).
- Parsing is case-insensitive. `enabled` defaults to `true` when omitted.

## Recent changes
- 2026-03-30: Added during the Marneweck roadmap rollout (22 features across 8 workstreams).
