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
  /** Defaults keep the list-page filter look; SupplierSelect overrides them. */
  placeholder?: string;
  wrapperClassName?: string;
  inputClassName?: string;
  name?: string;
  /** Blocks native form submit until a supplier is chosen (typed text alone does not count). */
  required?: boolean;
  /** Overrides the validity message, e.g. an id that could not be resolved. */
  invalidMessage?: string;
  /** Label suppliers by company_name when set (falls back to name). */
  companyFirst?: boolean;
  /** A preselected id is still being resolved to its name: show that, not an empty field. */
  loading?: boolean;
  testId?: string;
  ariaLabel?: string;
}

const FILTER_INPUT = 'w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40';

export function SupplierTypeahead({
  selectedId, selectedLabel, onSelect, onClear,
  placeholder = 'Filter by supplier…', wrapperClassName = 'w-64', inputClassName = FILTER_INPUT, name = 'supplier',
  required, invalidMessage, companyFirst, loading, testId, ariaLabel,
}: Props) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SupplierOption[]>([]);
  const [open, setOpen] = useState(false);
  // Nothing is fetched until the user focuses or types: a page with a picker per
  // row must not fire one request per row on mount.
  const [active, setActive] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Only a required picker may block submit; an optional one never does.
    const message = !required ? '' : (invalidMessage ?? (!selectedId ? 'Select a supplier from the list' : ''));
    inputRef.current?.setCustomValidity(message);
  }, [required, selectedId, invalidMessage]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const q = query.trim();
      try {
        const url = q
          ? `/api/accounting/suppliers-list?q=${encodeURIComponent(q)}&limit=25`
          : '/api/accounting/suppliers-list?limit=25';
        const res = await apiFetch(url);
        const json = await res.json();
        const data = (json.data || json) as { suppliers?: { id: string; name: string; company_name?: string | null }[] };
        if (!cancelled) {
          setOptions((data.suppliers || []).map((s) => ({ id: s.id, name: (companyFirst && s.company_name) || s.name })));
        }
      } catch (err) {
        if (!cancelled) {
          setOptions([]);
          log.warn('Supplier typeahead fetch failed', { error: err }, 'supplier-invoices');
        }
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, active, companyFirst]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div ref={boxRef} className={`relative ${wrapperClassName}`}>
      <input
        ref={inputRef}
        data-testid={testId}
        aria-label={ariaLabel}
        type="text"
        name={name}
        value={selectedLabel || query}
        onChange={(e) => {
          if (selectedId) onClear();
          setQuery(e.target.value);
          setActive(true);
          setOpen(true);
        }}
        onFocus={() => { setActive(true); setOpen(true); }}
        placeholder={loading ? 'Loading supplier…' : placeholder}
        aria-busy={loading || undefined}
        className={inputClassName}
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
