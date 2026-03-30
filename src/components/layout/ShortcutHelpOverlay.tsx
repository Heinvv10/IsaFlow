/**
 * ShortcutHelpOverlay
 *
 * Modal showing all registered keyboard shortcuts grouped by category.
 * Triggered by pressing '?' from anywhere in the app.
 * Closes on Esc or backdrop click.
 */

import { useEffect, useCallback } from 'react';
import { X } from 'lucide-react';
import type { ShortcutConfig, ShortcutCategory } from '@/lib/keyboard-shortcuts';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '@/lib/keyboard-shortcuts';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ShortcutHelpOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  shortcuts: ShortcutConfig[];
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Render a single key token as a keyboard badge */
function KeyBadge({ token }: { token: string }) {
  return (
    <kbd className="inline-flex items-center px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 text-xs font-mono text-gray-700 dark:text-gray-200 leading-none">
      {token}
    </kbd>
  );
}

/** Parse the label string into displayable tokens for KeyBadge rendering */
function ShortcutLabel({ label }: { label: string }) {
  // Labels like 'Ctrl+K', 'G then D', '?'
  // Split on ' then ' for sequences, else on '+' for modifier combos
  let tokens: string[];

  if (label.toLowerCase().includes(' then ')) {
    tokens = label.split(/\s+then\s+/i);
  } else {
    tokens = label.split('+').filter(Boolean);
  }

  return (
    <span className="flex items-center gap-1 flex-shrink-0">
      {tokens.map((token, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && (
            <span className="text-gray-400 dark:text-gray-500 text-xs mx-0.5">
              {label.toLowerCase().includes(' then ') ? 'then' : '+'}
            </span>
          )}
          <KeyBadge token={token} />
        </span>
      ))}
    </span>
  );
}

/** One grouped section of shortcuts */
function CategorySection({
  category,
  items,
}: {
  category: ShortcutCategory;
  items: ShortcutConfig[];
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-2">
        {CATEGORY_LABELS[category]}
      </h3>
      <ul className="space-y-1.5">
        {items.map(s => (
          <li key={s.key} className="flex items-center justify-between gap-4">
            <span className="text-sm text-gray-700 dark:text-gray-300 min-w-0 truncate">
              {s.description}
            </span>
            <ShortcutLabel label={s.label} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ShortcutHelpOverlay({
  isOpen,
  onClose,
  shortcuts,
}: ShortcutHelpOverlayProps) {
  // Close on Esc
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!isOpen) return;
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  // Group shortcuts by category in display order, skip disabled
  const grouped = CATEGORY_ORDER.reduce<Partial<Record<ShortcutCategory, ShortcutConfig[]>>>(
    (acc, cat) => {
      const items = shortcuts.filter(s => s.category === cat && s.enabled !== false);
      if (items.length > 0) acc[cat] = items;
      return acc;
    },
    {},
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      aria-modal="true"
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div className="relative z-10 w-full max-w-lg bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">
              Keyboard Shortcuts
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Press <KeyBadge token="?" /> anytime to open this panel
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
            aria-label="Close shortcuts panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto space-y-5">
          {(Object.entries(grouped) as [ShortcutCategory, ShortcutConfig[]][]).map(
            ([cat, items]) => (
              <CategorySection key={cat} category={cat} items={items} />
            ),
          )}

          {Object.keys(grouped).length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
              No shortcuts registered.
            </p>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Shortcuts with <KeyBadge token="Ctrl" /> work while typing. All others require focus outside a text field.
          </p>
        </div>
      </div>
    </div>
  );
}
