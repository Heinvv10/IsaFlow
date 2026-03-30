/**
 * Command Palette — WS-3.1
 * Ctrl+K / Cmd+K global search overlay with keyboard navigation.
 * Sub-components (rows, icons) live in CommandPaletteRows.tsx.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { useRouter } from 'next/router';
import { Search, X, Clock, Zap } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { ResultRow, ActionRow } from '@/components/layout/CommandPaletteRows';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  url: string;
  icon: string;
}

export interface QuickAction {
  label: string;
  url: string;
  shortcut?: string;
  icon: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RECENT_KEY = 'isaflow_recent_items';
const MAX_RECENT = 10;

const TYPE_LABELS: Record<string, string> = {
  gl_account: 'Account',
  customer: 'Customer',
  supplier: 'Supplier',
  invoice: 'Invoice',
  journal_entry: 'Journal',
  bank_transaction: 'Bank',
  item: 'Item',
};

// ─── Recent items helpers ─────────────────────────────────────────────────────

function loadRecentItems(): SearchResult[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as SearchResult[]) : [];
  } catch {
    return [];
  }
}

function saveRecentItem(item: SearchResult): void {
  if (typeof window === 'undefined') return;
  try {
    const existing = loadRecentItems().filter(r => r.url !== item.url);
    const updated = [item, ...existing].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
  } catch {
    // Storage errors are non-fatal
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [actions, setActions] = useState<QuickAction[]>([]);
  const [recentItems, setRecentItems] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchActions = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/global-search?q=');
      if (res.ok) {
        const data = await res.json() as { success: boolean; data: { actions: QuickAction[] } };
        if (data.success) setActions(data.data.actions);
      }
    } catch {
      // Non-fatal — actions are cosmetic
    }
  }, []);

  const runSearch = useCallback(async (q: string) => {
    try {
      const res = await apiFetch(`/api/accounting/global-search?q=${encodeURIComponent(q)}&limit=12`);
      if (res.ok) {
        const data = await res.json() as {
          success: boolean;
          data: { results: SearchResult[]; actions: QuickAction[] };
        };
        if (data.success) {
          setResults(data.data.results);
          setActions(data.data.actions);
        }
      }
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
      setSelectedIndex(0);
    }
  }, []);

  // Reset + load on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setRecentItems(loadRecentItems());
      void fetchActions();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, fetchActions]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => { void runSearch(query); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  const navigate = useCallback((url: string, result?: SearchResult) => {
    if (result) saveRecentItem(result);
    onClose();
    void router.push(url);
  }, [onClose, router]);

  const showSearch = query.length >= 2;
  const visibleRecent = recentItems.slice(0, 5);

  const flatItems: Array<{ url: string; asResult?: SearchResult; asAction?: QuickAction }> =
    showSearch
      ? results.map(r => ({ url: r.url, asResult: r }))
      : [
          ...visibleRecent.map(r => ({ url: r.url, asResult: r })),
          ...actions.map(a => ({ url: a.url, asAction: a })),
        ];

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, flatItems.length - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); }
      if (e.key === 'Enter') { e.preventDefault(); const item = flatItems[selectedIndex]; if (item) navigate(item.url, item.asResult); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, flatItems, selectedIndex, navigate, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div
        className="w-full max-w-xl mx-4 bg-[var(--ff-bg-primary)] border border-[var(--ff-border-primary)] rounded-xl shadow-2xl flex flex-col overflow-hidden max-h-[70vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 border-b border-[var(--ff-border-primary)]">
          <Search className="w-5 h-5 text-[var(--ff-text-tertiary)] flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search or jump to..."
            className="flex-1 py-4 text-base bg-transparent outline-none text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)]"
          />
          {loading && <div className="w-4 h-4 border-2 border-[var(--ff-border-primary)] border-t-teal-500 rounded-full animate-spin flex-shrink-0" />}
          {query && !loading && (
            <button onClick={() => setQuery('')} className="p-1 rounded text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)] transition-colors" aria-label="Clear search">
              <X className="w-4 h-4" />
            </button>
          )}
          <kbd className="hidden sm:flex items-center px-2 py-0.5 text-xs text-[var(--ff-text-tertiary)] bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] rounded">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto flex-1">
          {showSearch && results.length > 0 && (
            <div className="py-2">
              <p className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-tertiary)]">Results</p>
              {results.map((result, i) => (
                <ResultRow
                  key={`${result.type}-${result.id}`}
                  dataIdx={i} icon={result.icon} title={result.title}
                  subtitle={result.subtitle} badge={TYPE_LABELS[result.type] ?? result.type}
                  isSelected={selectedIndex === i} onClick={() => navigate(result.url, result)}
                />
              ))}
            </div>
          )}

          {showSearch && !loading && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-[var(--ff-text-tertiary)]">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {!showSearch && (
            <>
              {visibleRecent.length > 0 && (
                <div className="py-2">
                  <p className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-tertiary)] flex items-center gap-1.5">
                    <Clock className="w-3 h-3" /> Recent
                  </p>
                  {visibleRecent.map((item, i) => (
                    <ResultRow
                      key={`recent-${item.url}`} dataIdx={i} icon={item.icon}
                      title={item.title} subtitle={item.subtitle}
                      badge={TYPE_LABELS[item.type] ?? item.type}
                      isSelected={selectedIndex === i} onClick={() => navigate(item.url, item)}
                    />
                  ))}
                </div>
              )}

              {actions.length > 0 && (
                <div className="py-2 border-t border-[var(--ff-border-primary)]">
                  <p className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--ff-text-tertiary)] flex items-center gap-1.5">
                    <Zap className="w-3 h-3" /> Quick Actions
                  </p>
                  {actions.map((action, i) => {
                    const idx = visibleRecent.length + i;
                    return (
                      <ActionRow
                        key={action.url} dataIdx={idx} icon={action.icon} label={action.label}
                        shortcut={action.shortcut} isSelected={selectedIndex === idx}
                        onClick={() => navigate(action.url)}
                      />
                    );
                  })}
                </div>
              )}

              {visibleRecent.length === 0 && actions.length === 0 && (
                <div className="px-4 py-8 text-center text-sm text-[var(--ff-text-tertiary)]">Start typing to search...</div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--ff-border-primary)] px-4 py-2 flex items-center gap-4 text-xs text-[var(--ff-text-tertiary)]">
          {[['↑↓', 'navigate'], ['↵', 'open'], ['Esc', 'close']].map(([key, label]) => (
            <span key={key} className="flex items-center gap-1">
              <kbd className="px-1.5 py-0.5 bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] rounded text-[10px]">{key}</kbd>
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
