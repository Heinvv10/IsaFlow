/**
 * Admin — pick a company by name. Shows the company's name, never its id;
 * a preselected id is looked up directly, so deleted companies still show.
 */

import { useEffect, useState } from 'react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';

interface CompanyOption { id: string; name: string }

interface SubscriptionCompanyPickerProps {
  companyId: string;
  onChange: (companyId: string) => void;
}

const INPUT = 'w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-teal-500';

export function SubscriptionCompanyPicker({ companyId, onChange }: SubscriptionCompanyPickerProps) {
  const [selectedName, setSelectedName] = useState('');
  const [query, setQuery]               = useState('');
  const [matches, setMatches]           = useState<CompanyOption[] | null>(null);
  const [error, setError]               = useState('');

  useEffect(() => {
    if (!companyId) { setSelectedName(''); return; }
    let live = true;
    setError('');
    apiFetch(`/api/admin/companies/${encodeURIComponent(companyId)}`)
      .then(async res => { await assertOk(res, 'Could not load the company - pick it again'); return res.json(); })
      .then(json => { if (live) setSelectedName((json.data as CompanyOption).name); })
      .catch(err => { if (live) setError(apiErrorMessage(err, 'Could not load the company - pick it again')); });
    return () => { live = false; };
  }, [companyId]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setMatches(null); return; }
    let live = true;
    const t = setTimeout(() => {
      apiFetch(`/api/admin/companies?${new URLSearchParams({ search: q, limit: '10' })}`)
        .then(async res => { await assertOk(res, 'Could not search companies - try again'); return res.json(); })
        .then(json => { if (live) { setError(''); setMatches((json.data?.items ?? []) as CompanyOption[]); } })
        .catch(err => { if (live) setError(apiErrorMessage(err, 'Could not search companies - try again')); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  if (companyId && !error) {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700">
        <span className="text-gray-900 dark:text-white truncate">{selectedName || 'Loading…'}</span>
        <button type="button" onClick={() => { setQuery(''); onChange(''); }}
          className="text-xs text-teal-600 dark:text-teal-400 hover:underline">Change</button>
      </div>
    );
  }

  return (
    <div>
      <input type="text" placeholder="Search company by name..." value={query} onChange={e => setQuery(e.target.value)} className={INPUT} />
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      {matches && matches.length === 0 && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">No companies match &ldquo;{query.trim()}&rdquo;</p>}
      {matches && matches.length > 0 && (
        <ul role="listbox" className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-800">
          {matches.map(c => (
            <li key={c.id} role="option" aria-selected={false} onClick={() => { setQuery(''); setMatches(null); onChange(c.id); }}
              className="px-3 py-2 text-sm text-gray-900 dark:text-white cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800">{c.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
