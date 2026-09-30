/**
 * Supplier picker for forms — a server-searched replacement for a plain
 * <select> fed by /suppliers-list, which answers only 25 rows by default (PUR-01).
 * Typing searches via ?q=; a preselected id (OCR match, edit form) is resolved
 * with ?id= so it displays even when it is not in the first page.
 */

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { SupplierTypeahead } from './SupplierTypeahead';

interface Props {
  value: string;
  onChange: (id: string, name: string) => void;
  name?: string;
  required?: boolean;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
}

export function SupplierSelect({
  value, onChange, name = 'supplierId', required, placeholder = 'Search supplier…',
  className = 'w-full', inputClassName = 'ff-input w-full',
}: Props) {
  // A label only counts for the id it was resolved for, so an id set from outside
  // (OCR match) never shows the previous supplier's name.
  const [named, setNamed] = useState({ id: '', label: '' });
  const label = named.id === value ? named.label : '';
  const resolved = useRef<string>('');

  useEffect(() => {
    if (!value) { resolved.current = ''; return; }
    if (label || resolved.current === value) return;
    resolved.current = value;
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(`/api/accounting/suppliers-list?id=${encodeURIComponent(value)}`);
        const json = await res.json();
        const row = (json.data ?? json) as { name?: string; company_name?: string };
        if (!cancelled && res.ok) setNamed({ id: value, label: row.name || row.company_name || '' });
      } catch (err) {
        log.warn('Supplier select could not resolve id', { error: err }, 'supplier-select');
      }
    })();
    return () => { cancelled = true; };
  }, [value, label]);

  return (
    <>
      <SupplierTypeahead
        selectedId={value}
        selectedLabel={label}
        onSelect={(id, n) => { setNamed({ id, label: n }); resolved.current = id; onChange(id, n); }}
        onClear={() => { setNamed({ id: '', label: '' }); onChange('', ''); }}
        placeholder={placeholder}
        wrapperClassName={className}
        inputClassName={inputClassName}
        name={`${name}Search`}
      />
      {/* Carries the id for native `required` validation and form posts. */}
      <input type="text" name={name} value={value} required={required} readOnly tabIndex={-1} aria-hidden="true" className="sr-only" />
    </>
  );
}
