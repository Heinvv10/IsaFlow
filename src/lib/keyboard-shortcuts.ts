/**
 * Keyboard Shortcuts Registry
 * Defines the ShortcutConfig type and utilities for parsing + matching shortcuts.
 * Supports single-key, modifier, and two-key sequences (e.g. 'g d').
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type ShortcutCategory = 'global' | 'navigation' | 'actions' | 'table';

export interface ShortcutConfig {
  /** Key string: 'ctrl+k', '?', 'g d' (sequence), 'ctrl+n' */
  key: string;
  /** Human-readable label shown in the help overlay, e.g. 'Ctrl+K' */
  label: string;
  /** Explains what the shortcut does */
  description: string;
  category: ShortcutCategory;
  action: () => void;
  /** Defaults to true */
  enabled?: boolean;
}

// ─── Parsed shortcut ─────────────────────────────────────────────────────────

export interface ParsedShortcut {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  /** Individual key tokens (lowercased). For sequences, length > 1. */
  keys: string[];
  isSequence: boolean;
}

// ─── parseShortcut ────────────────────────────────────────────────────────────

/**
 * Parse a shortcut string into its component parts.
 *
 * Examples:
 *   'ctrl+k'  → { ctrl: true,  keys: ['k'],      isSequence: false }
 *   '?'       → { ctrl: false, keys: ['?'],      isSequence: false }
 *   'g d'     → { ctrl: false, keys: ['g', 'd'], isSequence: true  }
 */
export function parseShortcut(key: string): ParsedShortcut {
  // Sequences use a space separator and cannot have modifiers
  if (key.includes(' ')) {
    const parts = key.trim().toLowerCase().split(/\s+/);
    return { ctrl: false, meta: false, shift: false, alt: false, keys: parts, isSequence: true };
  }

  const tokens = key.toLowerCase().split('+');
  const ctrl  = tokens.includes('ctrl');
  const meta  = tokens.includes('meta') || tokens.includes('cmd');
  const shift = tokens.includes('shift');
  const alt   = tokens.includes('alt');

  // The actual key is the last token that is not a modifier name
  const modifiers = new Set(['ctrl', 'meta', 'cmd', 'shift', 'alt']);
  const keys = tokens.filter(t => !modifiers.has(t));

  return { ctrl, meta, shift, alt, keys, isSequence: false };
}

// ─── matchesShortcut ──────────────────────────────────────────────────────────

/**
 * Test whether a single KeyboardEvent matches a (non-sequence) ParsedShortcut.
 * For sequences, callers must track state themselves; this only checks the
 * current key press.
 */
export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: ParsedShortcut,
): boolean {
  if (shortcut.isSequence) return false;

  if (shortcut.ctrl  !== (event.ctrlKey  || event.metaKey)) return false;
  if (shortcut.shift !== event.shiftKey)                    return false;
  if (shortcut.alt   !== event.altKey)                      return false;

  const eventKey = event.key.toLowerCase();
  return shortcut.keys.length === 1 && shortcut.keys[0] === eventKey;
}

// ─── Category label helpers ───────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  global:     'Global',
  navigation: 'Navigation',
  actions:    'Actions',
  table:      'Table',
};

/** Sort order for categories in the help overlay */
export const CATEGORY_ORDER: ShortcutCategory[] = [
  'global',
  'navigation',
  'actions',
  'table',
];
