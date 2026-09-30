/**
 * Supplier picker for forms — a server-searched replacement for a plain
 * <select> fed by /suppliers-list, which answers only 25 rows by default (PUR-01).
 * Typing searches via ?q=; a preselected id (OCR match, edit form) is resolved
 * with ?id= so it displays even when it is not in the first page.
 *
 * `required` is enforced on the visible input (setCustomValidity): readonly and
 * hidden inputs are barred from constraint validation, so they cannot carry it.
 * An id that cannot be resolved is cleared and flagged, never submitted blind.
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
  /** Label by company_name when set (falls back to name). */
  companyFirst?: boolean;
}

const UNKNOWN = 'Supplier not found — choose another';

export function SupplierSelect({
  value, onChange, name = 'supplierId', required, placeholder = 'Search supplier…',
  className = 'w-full', inputClassName = 'ff-input w-full', companyFirst,
}: Props) {
  // A label only counts for the id it was resolved for, so an id set from outside
  // (OCR match) never shows the previous supplier's name.
  const [named, setNamed] = useState({ id: '', label: '' });
  const [unknown, setUnknown] = useState(false);
  const label = named.id === value ? named.label : '';
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  useEffect(() => {
    if (!value || named.id === value) return;
    let ignore = false; // StrictMode runs this effect twice; only the last run may apply
    void (async () => {
      let found = '';
      try {
        const res = await apiFetch(`/api/accounting/suppliers-list?id=${encodeURIComponent(value)}`);
        const json = await res.json();
        const row = (json.data ?? json) as { name?: string; company_name?: string };
        if (res.ok) found = (companyFirst && row.company_name) || row.name || row.company_name || '';
      } catch (err) {
        log.warn('Supplier select could not resolve id', { error: err, id: value }, 'supplier-select');
      }
      if (ignore) return;
      if (found) { setUnknown(false); setNamed({ id: value, label: found }); return; }
      log.warn('Supplier select id did not resolve', { id: value }, 'supplier-select');
      setUnknown(true);
      onChangeRef.current('', '');
    })();
    return () => { ignore = true; };
  }, [value, named.id, companyFirst]);

  return (
    <div className={className}>
      <SupplierTypeahead
        selectedId={value}
        selectedLabel={label}
        onSelect={(id, n) => { setUnknown(false); setNamed({ id, label: n }); onChange(id, n); }}
        onClear={() => { setNamed({ id: '', label: '' }); onChange('', ''); }}
        placeholder={placeholder}
        wrapperClassName="w-full"
        inputClassName={inputClassName}
        name={`${name}Search`}
        required={required}
        companyFirst={companyFirst}
        invalidMessage={unknown ? UNKNOWN : undefined}
      />
      <input type="hidden" name={name} value={value} />
      {unknown && <p role="alert" className="mt-1 text-xs text-red-500">{UNKNOWN}</p>}
    </div>
  );
}
