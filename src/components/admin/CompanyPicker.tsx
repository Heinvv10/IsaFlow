/**
 * CompanyPicker
 * Search-and-select component for targeting specific companies in announcements.
 * Calls /api/admin/companies?search=<query>&limit=10 with 300ms debounce.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
} from 'react';
import { Search, X, CheckCircle2, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';

interface CompanyOption {
  id: string;
  name: string;
  status: string;
}

interface Props {
  value: string[];
  onChange: (ids: string[]) => void;
  /** id of the search input, for a <label htmlFor> outside the picker. */
  inputId?: string;
}

const STATUS_BADGE: Record<string, string> = {
  active:   'bg-green-500/10 text-green-600 dark:text-green-400',
  trial:    'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  suspended:'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  inactive: 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

function statusBadgeCls(status: string) {
  return STATUS_BADGE[status] ?? 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400';
}

export function CompanyPicker({ value, onChange, inputId }: Props) {
  const [query, setQuery]           = useState('');
  const afterDelay = useTimeoutOnce();
  const [results, setResults]       = useState<CompanyOption[]>([]);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState('');
  const [open, setOpen]             = useState(false);
  const [activeIdx, setActiveIdx]   = useState(-1);
  const [selectedMap, setSelectedMap] = useState<Map<string, CompanyOption>>(new Map());

  // Ids whose name has been asked for (once each): an id that arrives in `value` already chosen is not in selectedMap.
  const asked = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef    = useRef<HTMLInputElement>(null);
  const listRef     = useRef<HTMLUListElement>(null);

  // Keep selectedMap in sync when value prop changes (e.g. editing existing announcement)
  useEffect(() => {
    setSelectedMap(prev => {
      const next = new Map(prev);
      // Remove IDs that are no longer in value
      for (const id of Array.from(next.keys())) {
        if (!value.includes(id)) next.delete(id);
      }
      return next;
    });
  }, [value]);

  // Targets chosen before this picker mounted (editing an announcement) arrive as bare ids: look up their names so
  // each shows as a chip that can be removed. An id that cannot be loaded still gets a chip, labelled as unavailable.
  useEffect(() => {
    const put = (c: CompanyOption) => { if (mounted.current) setSelectedMap(prev => new Map(prev).set(c.id, c)); };
    for (const id of value) {
      if (selectedMap.has(id) || asked.current.has(id)) continue;
      asked.current.add(id);
      void (async () => {
        try {
          const res = await apiFetch(`/api/admin/companies/${encodeURIComponent(id)}`);
          await assertOk(res, 'Could not load a target company');
          const json = await res.json() as { data?: { id?: string; name?: string; status?: string } };
          put({ id, name: json.data?.name ?? id, status: json.data?.status ?? '' });
        } catch (err) {
          log.warn('Could not load a target company', { companyId: id, error: err }, 'admin-ui');
          put({ id, name: `Unavailable company (${id.slice(0, 8)})`, status: '' });
        }
      })();
    }
  }, [value, selectedMap]);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]); setError('');
      setOpen(false);
      return;
    }
    setLoading(true); setError('');
    try {
      const res  = await apiFetch(`/api/admin/companies?search=${encodeURIComponent(q)}&limit=10`);
      await assertOk(res, 'Could not search companies - try again');
      const json = await res.json() as { data?: { items?: CompanyOption[] } };
      setResults(json.data?.items ?? []);
      setOpen(true);
      setActiveIdx(-1);
    } catch (err) {
      setResults([]); setOpen(false);
      setError(apiErrorMessage(err, 'Could not search companies - try again'));
      log.error('Company search failed', { error: err }, 'admin-ui');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleQueryChange = (q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void search(q); }, 300);
  };

  const select = useCallback((company: CompanyOption) => {
    if (value.includes(company.id)) return;
    const next = new Map(selectedMap).set(company.id, company);
    setSelectedMap(next);
    onChange([...value, company.id]);
    setQuery('');
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  }, [value, onChange, selectedMap]);

  const deselect = useCallback((id: string) => {
    const next = new Map(selectedMap);
    next.delete(id);
    setSelectedMap(next);
    onChange(value.filter(v => v !== id));
  }, [value, onChange, selectedMap]);

  const clearAll = () => {
    setSelectedMap(new Map());
    onChange([]);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && results[activeIdx]) select(results[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIdx(-1);
    }
  };

  // Scroll active item into view
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const selectedEntries = value
    .map(id => selectedMap.get(id))
    .filter((c): c is CompanyOption => c !== undefined);

  return (
    <div className="space-y-2">
      {/* Search input */}
      <div className="relative">
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 dark:text-gray-400 pointer-events-none">
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
        </div>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          // aria-haspopup lets a surrounding dialog's focus trap leave Escape to the open list (useFocusTrap).
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="company-picker-listbox"
          aria-activedescendant={activeIdx >= 0 ? `company-opt-${activeIdx}` : undefined}
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          onBlur={() => afterDelay(() => setOpen(false), 150)}
          placeholder="Search companies by name…"
          className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm pl-9 pr-3 py-2 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-teal-500"
        />

        {/* Dropdown */}
        {open && results.length > 0 && (
          <ul
            id="company-picker-listbox"
            ref={listRef}
            role="listbox"
            aria-label="Company search results"
            className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg"
          >
            {results.map((company, idx) => {
              const alreadySelected = value.includes(company.id);
              const isActive = idx === activeIdx;
              return (
                <li
                  key={company.id}
                  id={`company-opt-${idx}`}
                  role="option"
                  aria-selected={alreadySelected}
                  onMouseDown={() => select(company)}
                  className={[
                    'flex items-center justify-between px-3 py-2 cursor-pointer text-sm',
                    isActive
                      ? 'bg-teal-50 dark:bg-teal-900/30'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-700/50',
                    alreadySelected ? 'opacity-50 cursor-not-allowed' : '',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {alreadySelected && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-teal-500 flex-shrink-0" />
                    )}
                    <span className="truncate text-gray-900 dark:text-white">{company.name}</span>
                  </span>
                  <span className={`ml-2 flex-shrink-0 px-1.5 py-0.5 rounded-full text-xs font-medium capitalize ${statusBadgeCls(company.status)}`}>
                    {company.status}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {error && <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

        {open && !loading && results.length === 0 && query.trim() && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
            No companies found for &quot;{query}&quot;
          </div>
        )}
      </div>

      {/* Selected chips */}
      {selectedEntries.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {selectedEntries.map(company => (
              <span
                key={company.id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300"
              >
                {company.name}
                <button
                  type="button"
                  onClick={() => deselect(company.id)}
                  aria-label={`Remove ${company.name}`}
                  className="ml-0.5 text-teal-600 hover:text-teal-900 dark:text-teal-400 dark:hover:text-teal-100"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-gray-600 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
