/**
 * Command Palette: Ctrl+K / Cmd+K. Pages (with the trail that leads to them), actions and records in one list.
 * Matching and ordering live in paletteRank.ts, the server search in usePaletteSearch.ts, the action list in
 * commandActions.ts. The input is a combobox over a listbox; the dialog traps focus.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Search, X } from 'lucide-react';
import { TABS } from '@/components/accounting/accountingNavConfig';
import { buildNavIndex } from '@/components/accounting/navSections/navIndex';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany } from '@/contexts/CompanyContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useVatRegistration } from '@/hooks/useVatRegistration';
import { PaletteOption } from '@/components/layout/CommandPaletteRows';
import { buildSections, type PaletteRow } from '@/components/layout/paletteRank';
import { saveRecentItem, usePaletteSearch } from '@/components/layout/usePaletteSearch';

export type { SearchResult } from '@/components/layout/paletteRank';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opens the shortcut overlay. Without it the palette sends the "?" key the overlay already listens for. */
  onShowShortcuts?: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  gl_account: 'Account', customer: 'Customer', supplier: 'Supplier', invoice: 'Invoice',
  journal_entry: 'Journal', bank_transaction: 'Bank', item: 'Item', employee: 'Employee', page: 'Page',
};

function sendQuestionMark(): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
}

export function CommandPalette({ isOpen, onClose, onShowShortcuts }: CommandPaletteProps) {
  const router = useRouter();
  const { toggleTheme } = useTheme();
  const { isRegistered } = useVatRegistration();
  const { user } = useAuth();
  const { activeCompany } = useCompany();
  const scope = user && activeCompany ? `${user.id}:${activeCompany.id}` : null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const [selected, setSelected] = useState(0);
  const { query, setQuery, server, loading, error, recent } = usePaletteSearch(isOpen, scope);

  useFocusTrap(dialogRef, isOpen, onClose);

  const index = useMemo(() => buildNavIndex(TABS, isRegistered), [isRegistered]);
  const sections = useMemo(() => buildSections({ query, index, recent, server }), [query, index, recent, server]);
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // Back to the top when the typing changes, not when a reply lands: the highlight must not jump under the arrow keys.
  useEffect(() => { setSelected(0); }, [query]);
  const current = Math.min(selected, Math.max(rows.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${current}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [current]);

  const showShortcuts = useCallback(() => {
    onClose();
    (onShowShortcuts ?? sendQuestionMark)();
  }, [onClose, onShowShortcuts]);

  const choose = useCallback((row: PaletteRow) => {
    if (row.kind === 'item') {
      saveRecentItem(scope, row.item);
      onClose();
      void router.push(row.item.url);
      return;
    }
    const { action } = row;
    if (action.kind === 'shortcuts') { showShortcuts(); return; }
    onClose();
    if (action.kind === 'theme') toggleTheme();
    else if (action.url) void router.push(action.url);
  }, [onClose, router, toggleTheme, showShortcuts, scope]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = rows.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(current >= last ? 0 : current + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(current <= 0 ? last : current - 1); }
    // Home/End belong to the caret once there is text; with an empty box they jump through the list.
    else if (e.key === 'Home' && !query && last >= 0) { e.preventDefault(); setSelected(0); }
    else if (e.key === 'End' && !query && last >= 0) { e.preventDefault(); setSelected(last); }
    else if (e.key === 'Enter') { e.preventDefault(); const row = rows[current]; if (row) choose(row); }
  };

  if (!isOpen) return null;

  const optionId = (i: number) => `${uid}-opt-${i}`;
  const positionOf = new Map(rows.map((r, n) => [r.key, n]));
  const showEmpty = query.trim().length > 0 && rows.length === 0 && !loading && !error;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl mx-4 bg-surface border border-line rounded-xl shadow-2xl flex flex-col overflow-hidden max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 border-b border-line">
          <Search className="w-5 h-5 text-ink-muted flex-shrink-0" aria-hidden="true" />
          <input
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={rows.length > 0 ? optionId(current) : undefined}
            aria-label="Search pages, actions and records"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search or jump to..."
            className="flex-1 py-4 text-base bg-transparent outline-none text-ink placeholder:text-ink-muted"
          />
          {loading && <div className="w-4 h-4 border-2 border-line border-t-teal-500 rounded-full animate-spin flex-shrink-0" aria-hidden="true" />}
          {query && !loading && (
            <button type="button" onClick={() => setQuery('')} className="p-1 rounded text-ink-muted hover:text-ink transition-colors" aria-label="Clear search">
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="hidden sm:flex items-center px-2 py-0.5 text-xs text-ink-muted bg-surface-sunken border border-line rounded">Esc</kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="overflow-y-auto flex-1">
          {sections.map((section) => (
            <div key={section.id} role="group" aria-labelledby={`${uid}-h-${section.id}`} className="py-2">
              <p id={`${uid}-h-${section.id}`} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {section.heading}
              </p>
              {section.rows.map((row) => {
                const i = positionOf.get(row.key) ?? 0;
                const common = { id: optionId(i), dataIdx: i, isSelected: current === i, onClick: () => choose(row) };
                return row.kind === 'action'
                  ? <PaletteOption key={row.key} {...common} icon={row.action.icon} title={row.action.label} badge="Action" />
                  : <PaletteOption
                      key={row.key} {...common} icon={row.item.icon} title={row.item.title}
                      subtitle={row.item.subtitle} trail={row.item.trail}
                      badge={TYPE_LABELS[row.item.type] ?? row.item.type}
                    />;
              })}
            </div>
          ))}
        </div>

        {error && <p role="alert" className="px-4 py-3 text-sm text-ink border-t border-line">{error}</p>}
        {showEmpty && <p className="px-4 py-8 text-center text-sm text-ink-muted">No results for &ldquo;{query}&rdquo;</p>}
        <p className="sr-only" role="status" aria-live="polite">{query.trim() ? `${rows.length} results` : ''}</p>

        <div className="border-t border-line px-4 py-2 flex items-center gap-4 text-xs text-ink-muted">
          {[['↑↓', 'navigate'], ['↵', 'open'], ['Esc', 'close']].map(([key, label]) => (
            <span key={key} className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-surface-sunken border border-line rounded text-xs">{key}</kbd>
              {label}
            </span>
          ))}
          <button
            type="button"
            onClick={showShortcuts}
            className="ml-auto flex items-center gap-1 hover:text-ink"
          >
            <kbd className="px-1.5 py-0.5 bg-surface-sunken border border-line rounded text-xs">?</kbd>
            shortcuts
          </button>
        </div>
      </div>
    </div>
  );
}
