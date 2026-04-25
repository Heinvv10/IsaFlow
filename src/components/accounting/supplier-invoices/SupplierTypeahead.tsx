/**
 * Supplier name typeahead — server-side ?q= search against /suppliers-list.
 */

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { SupplierOption } from './listTypes';

interface Props {
  selectedId: string;
  selectedLabel: string;
  onSelect: (id: string, label: string) => void;
  onClear: () => void;
}

export function SupplierTypeahead({ selectedId, selectedLabel, onSelect, onClear }: Props) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SupplierOption[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const q = query.trim();
      try {
        const url = q
          ? `/api/accounting/suppliers-list?q=${encodeURIComponent(q)}&limit=25`
          : '/api/accounting/suppliers-list?limit=25';
        const res = await apiFetch(url);
        const json = await res.json();
        const data = (json.data || json) as { suppliers?: { id: string; name: string }[] };
        if (!cancelled) {
          setOptions((data.suppliers || []).map((s) => ({ id: s.id, name: s.name })));
        }
      } catch (err) {
        if (!cancelled) {
          setOptions([]);
          log.warn('Supplier typeahead fetch failed', { error: err }, 'supplier-invoices');
        }
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div ref={boxRef} className="relative w-64">
      <input
        type="text"
        name="supplier"
        value={selectedLabel || query}
        onChange={(e) => {
          if (selectedId) onClear();
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Filter by supplier…"
        className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
      />
      {selectedId && (
        <button
          type="button"
          onClick={() => { setQuery(''); onClear(); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200"
          aria-label="Clear supplier filter"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {open && options.length > 0 && !selectedId && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl">
          {options.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                onSelect(s.id, s.name);
                setQuery('');
                setOpen(false);
              }}
              className="block w-full text-left px-3 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-amber-500/10"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
