/**
 * Customer name typeahead for the invoice list — mirrors SupplierTypeahead,
 * but searches only once something is typed: the customers endpoint without
 * `?q=` returns the whole directory, and the list must not load that eagerly.
 */

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

interface CustomerOption { id: string; name: string }

interface Props {
  selectedId: string;
  selectedLabel: string;
  onSelect: (id: string, label: string) => void;
  onClear: () => void;
  inputClassName: string;
}

const MAX_OPTIONS = 25;

export function CustomerTypeahead({ selectedId, selectedLabel, onSelect, onClear, inputClassName }: Props) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<CustomerOption[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setOptions([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/accounting/customers?q=${encodeURIComponent(q)}`);
        await assertOk(res, 'Could not search the customers - try again');
        const json = await res.json() as { data?: CustomerOption[] };
        if (!cancelled) setOptions((json.data ?? []).slice(0, MAX_OPTIONS).map(c => ({ id: c.id, name: c.name })));
      } catch (err) {
        if (!cancelled) {
          setOptions([]);
          log.warn('Customer typeahead fetch failed', { error: err }, 'customer-invoices');
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

  // A deep link carries only the id; until the rows name the customer, say so.
  const shown = selectedId ? (selectedLabel || 'Selected customer') : query;

  return (
    <div ref={boxRef} className="relative w-64">
      <input
        type="text"
        name="customer"
        aria-label="Filter by customer"
        value={shown}
        onChange={e => {
          if (selectedId) onClear();
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Filter by customer…"
        className={`${inputClassName} w-full pr-8`}
      />
      {selectedId && (
        <button
          type="button"
          onClick={() => { setQuery(''); onClear(); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--ff-text-tertiary)] hover:text-[var(--ff-text-primary)]"
          aria-label="Clear customer filter"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {open && options.length > 0 && !selectedId && (
        <div role="listbox" className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] rounded-lg shadow-xl">
          {options.map(c => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => { onSelect(c.id, c.name); setQuery(''); setOpen(false); }}
              className="block w-full text-left px-3 py-2 text-sm text-[var(--ff-text-primary)] hover:bg-teal-500/10"
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
