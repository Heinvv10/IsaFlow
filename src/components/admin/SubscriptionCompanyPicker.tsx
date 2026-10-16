/**
 * Admin — pick one company by name for a subscription. Shows the company's
 * name, never its id; a preselected id is looked up directly, so deleted
 * companies still show. (CompanyPicker is the multi-select for announcements.)
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface CompanyOption { id: string; name: string; status?: string }

interface SubscriptionCompanyPickerProps {
  companyId: string;
  onChange: (companyId: string) => void;
}

const INPUT = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500';
const LOAD_ERROR = 'Could not load that company - search for it by name';
const SEARCH_ERROR = 'Could not search companies - try again';

export function SubscriptionCompanyPicker({ companyId, onChange }: SubscriptionCompanyPickerProps) {
  const [selectedName, setSelectedName] = useState('');
  const [loadError, setLoadError]       = useState('');
  const [query, setQuery]               = useState('');
  const [matches, setMatches]           = useState<CompanyOption[] | null>(null);
  const [searchError, setSearchError]   = useState('');
  const [activeIdx, setActiveIdx]       = useState(-1);
  const listboxId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setSelectedName('');
    if (!companyId) return;
    let live = true;
    setLoadError('');
    apiFetch(`/api/admin/companies/${encodeURIComponent(companyId)}`)
      .then(async res => { await assertOk(res, LOAD_ERROR); return res.json(); })
      .then(json => { if (live) setSelectedName((json.data as CompanyOption).name); })
      .catch(err => {
        if (!live) return;
        log.warn('Subscription company lookup failed', { companyId, error: err }, 'admin-ui');
        setLoadError(apiErrorMessage(err, LOAD_ERROR));
        onChange(''); // an id we can't name must not be submitted
      });
    return () => { live = false; };
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = query.trim();
    setActiveIdx(-1);
    if (!q) { setMatches(null); setSearchError(''); return; }
    let live = true;
    const t = setTimeout(() => {
      apiFetch(`/api/admin/companies?${new URLSearchParams({ search: q, limit: '10' })}`)
        .then(async res => { await assertOk(res, SEARCH_ERROR); return res.json(); })
        .then(json => { if (live) { setSearchError(''); setActiveIdx(-1); setMatches((json.data?.items ?? []) as CompanyOption[]); } })
        .catch(err => {
          if (!live) return;
          log.error('Company search failed', { error: err }, 'admin-ui');
          setMatches(null);
          setSearchError(apiErrorMessage(err, SEARCH_ERROR));
        });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  useEffect(() => {
    if (activeIdx < 0) return;
    (listRef.current?.children[activeIdx] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIdx]);

  function pick(c: CompanyOption) {
    setQuery(''); setMatches(null); setLoadError('');
    onChange(c.id);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!matches || matches.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, matches.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && matches[activeIdx]) { e.preventDefault(); pick(matches[activeIdx]); }
    else if (e.key === 'Escape') { setMatches(null); }
  }

  if (companyId && !loadError) {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700">
        <span className="text-gray-900 dark:text-white truncate">{selectedName || 'Loading…'}</span>
        <button type="button" onClick={() => { setQuery(''); onChange(''); }}
          className="text-xs text-teal-600 dark:text-teal-400 hover:underline">Change</button>
      </div>
    );
  }

  const open = !!matches && matches.length > 0;
  return (
    <div>
      <input type="text" role="combobox" aria-label="Company" aria-autocomplete="list" aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeIdx >= 0 ? `${listboxId}-${activeIdx}` : undefined}
        placeholder="Search company by name..." value={query} onChange={e => setQuery(e.target.value)} onKeyDown={onKeyDown} className={INPUT} />
      {(loadError || searchError) && <p className="mt-1 text-xs text-red-500">{searchError || loadError}</p>}
      {matches && matches.length === 0 && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">No companies match &ldquo;{query.trim()}&rdquo;</p>}
      {open && (
        <ul id={listboxId} ref={listRef} role="listbox" aria-label="Matching companies"
          className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
          {matches.map((c, i) => (
            <li key={c.id} id={`${listboxId}-${i}`} role="option" aria-selected={i === activeIdx} onClick={() => pick(c)}
              className={`flex items-center justify-between px-3 py-2 text-sm text-gray-900 dark:text-white cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${i === activeIdx ? 'bg-teal-50 dark:bg-teal-900/30' : ''}`}>
              <span className="truncate">{c.name}</span>
              {c.status && c.status !== 'active' && <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">{c.status}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
