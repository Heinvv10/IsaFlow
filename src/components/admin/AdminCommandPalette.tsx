/**
 * Ctrl+K on the admin host: admin pages (adminNavConfig.ts), companies and users. The tenant palette searches the
 * active company's ledger and offers /accounting/* pages, which are 404s here (admin audit 2026-11-14, item 4.3).
 *
 * Same shape as the tenant palette: a modal dialog with a combobox over a listbox, focus trapped, Escape closes.
 * Pages are ranked on the client with the tenant palette's ranker; records come from useAdminPaletteSearch.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Search } from 'lucide-react';
import { useFocusTrap } from '@/components/ui/useFocusTrap';
import { PaletteOption } from '@/components/layout/CommandPaletteRows';
import { pageResult, rankPages, type SearchResult } from '@/components/layout/paletteRank';
import { useAdminHref } from '@/hooks/useAdminPrefix';
import { adminPageIndex } from './adminNavConfig';
import { useAdminPaletteSearch } from './useAdminPaletteSearch';

interface AdminCommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Section { id: 'pages' | 'records'; heading: string; rows: SearchResult[] }

const BADGES: Record<string, string> = { page: 'Page', company: 'Company', user: 'User' };
const MAX_PAGES = 8;

export function AdminCommandPalette({ isOpen, onClose }: AdminCommandPaletteProps) {
  const router = useRouter();
  const href = useAdminHref();
  const dialogRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const [selected, setSelected] = useState(0);
  const { query, setQuery, records, loading, error } = useAdminPaletteSearch(isOpen, href);

  useFocusTrap(dialogRef, isOpen, onClose);

  const index = useMemo(() => adminPageIndex(href), [href]);
  const sections = useMemo<Section[]>(() => {
    const q = query.trim();
    const pages = q ? rankPages(index, q, MAX_PAGES) : index.filter(e => e.trail.length === 0);
    return [
      { id: 'pages' as const, heading: 'Pages', rows: pages.map(e => pageResult(e, q)) },
      { id: 'records' as const, heading: 'Companies and users', rows: records },
    ].filter(s => s.rows.length > 0);
  }, [query, index, records]);
  const rows = useMemo(() => sections.flatMap(s => s.rows), [sections]);

  useEffect(() => { setSelected(0); }, [query]);
  const current = Math.min(selected, Math.max(rows.length - 1, 0));

  const choose = useCallback((row: SearchResult) => {
    onClose();
    void router.push(row.url);
  }, [onClose, router]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = rows.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (last >= 0) setSelected(current >= last ? 0 : current + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (last >= 0) setSelected(current <= 0 ? last : current - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const row = rows[current]; if (row) choose(row); }
  };

  if (!isOpen) return null;

  const optionId = (i: number) => `${uid}-opt-${i}`;
  const positionOf = new Map(rows.map((r, n) => [r, n]));
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
            aria-label="Search admin pages, companies and users"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages, companies, users..."
            className="flex-1 py-4 text-base bg-transparent outline-none text-ink placeholder:text-ink-muted"
          />
          {loading && <div className="w-4 h-4 border-2 border-line border-t-teal-500 rounded-full animate-spin flex-shrink-0" aria-hidden="true" />}
          <kbd className="hidden sm:flex items-center px-2 py-0.5 text-xs text-ink-muted bg-surface-sunken border border-line rounded">Esc</kbd>
        </div>

        <div id={listId} role="listbox" aria-label="Results" className="overflow-y-auto flex-1">
          {sections.map(section => (
            <div key={section.id} role="group" aria-labelledby={`${uid}-h-${section.id}`} className="py-2">
              <p id={`${uid}-h-${section.id}`} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {section.heading}
              </p>
              {section.rows.map(row => {
                const i = positionOf.get(row) ?? 0;
                return (
                  <PaletteOption
                    key={`${row.type}-${row.url}`} id={optionId(i)} dataIdx={i} isSelected={current === i}
                    onClick={() => choose(row)} icon={row.icon} title={row.title} subtitle={row.subtitle}
                    trail={row.trail} aliases={row.aliases} badge={BADGES[row.type] ?? row.type}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {error && <p role="alert" className="px-4 py-3 text-sm text-ink border-t border-line">{error}</p>}
        {showEmpty && <p className="px-4 py-8 text-center text-sm text-ink-muted">No results for &ldquo;{query}&rdquo;</p>}
        <p className="sr-only" role="status" aria-live="polite">{query.trim() ? `${rows.length} results` : ''}</p>
      </div>
    </div>
  );
}
