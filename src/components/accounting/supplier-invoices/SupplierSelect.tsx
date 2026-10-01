/**
 * Supplier picker for forms — a server-searched replacement for a plain
 * <select> fed by /suppliers-list, which answers only 25 rows by default (PUR-01).
 * Typing searches via ?q=; a preselected id (OCR match, edit form) is resolved
 * with ?id= so it displays even when it is not in the first page.
 *
 * `required` is enforced on the visible input (setCustomValidity): readonly and
 * hidden inputs are barred from constraint validation, so they cannot carry it.
 * An id the server says does not exist (404, or ok with no row) is cleared and
 * flagged. Any other failure (5xx, network) keeps the saved id and offers a retry,
 * so a flaky lookup never wipes a saved supplier.
 */

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { UUID_RE } from '@/lib/validation';
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
const LOAD_FAILED = "Couldn't load supplier";

type Lookup = { kind: 'found'; label: string } | { kind: 'missing' } | { kind: 'error' };

async function lookup(id: string, companyFirst?: boolean): Promise<Lookup> {
  // The route casts ?id= to UUID and answers 500 for anything else; a corrupted id is
  // missing, not a server fault worth retrying.
  if (!UUID_RE.test(id)) return { kind: 'missing' };
  try {
    const res = await apiFetch(`/api/accounting/suppliers-list?id=${encodeURIComponent(id)}`);
    if (res.status === 404) return { kind: 'missing' };
    if (!res.ok) return { kind: 'error' };
    const json = await res.json();
    const row = (json.data ?? json) as { name?: string; company_name?: string };
    const label = (companyFirst && row.company_name) || row.name || row.company_name || '';
    return label ? { kind: 'found', label } : { kind: 'missing' };
  } catch (err) {
    log.warn('Supplier select could not resolve id', { error: err, id }, 'supplier-select');
    return { kind: 'error' };
  }
}

export function SupplierSelect({
  value, onChange, name = 'supplierId', required, placeholder = 'Search supplier…',
  className = 'w-full', inputClassName = 'ff-input w-full', companyFirst,
}: Props) {
  // A label only counts for the id it was resolved for, so an id set from outside
  // (OCR match) never shows the previous supplier's name.
  const [named, setNamed] = useState({ id: '', label: '' });
  const [unknown, setUnknown] = useState(false);
  const [failedId, setFailedId] = useState('');
  const [attempt, setAttempt] = useState(0);
  const label = named.id === value ? named.label : '';
  const loadFailed = failedId !== '' && failedId === value;
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  useEffect(() => {
    if (!value || named.id === value) return;
    let ignore = false; // StrictMode runs this effect twice; only the last run may apply
    void (async () => {
      const r = await lookup(value, companyFirst);
      if (ignore) return;
      if (r.kind === 'found') { setUnknown(false); setFailedId(''); setNamed({ id: value, label: r.label }); return; }
      if (r.kind === 'error') { setFailedId(value); return; }
      log.warn('Supplier select id did not resolve', { id: value }, 'supplier-select');
      setUnknown(true);
      onChangeRef.current('', '');
    })();
    return () => { ignore = true; };
  }, [value, named.id, companyFirst, attempt]);

  return (
    <div className={className}>
      <SupplierTypeahead
        selectedId={value}
        selectedLabel={label}
        onSelect={(id, n) => { setUnknown(false); setFailedId(''); setNamed({ id, label: n }); onChange(id, n); }}
        onClear={() => { setNamed({ id: '', label: '' }); setFailedId(''); onChange('', ''); }}
        placeholder={placeholder}
        wrapperClassName="w-full"
        inputClassName={inputClassName}
        name={`${name}Search`}
        required={required}
        companyFirst={companyFirst}
        invalidMessage={unknown ? UNKNOWN : undefined}
        loading={!!value && !label && !unknown && !loadFailed}
        testId="supplier-select-input"
        ariaLabel="Supplier"
      />
      <input type="hidden" name={name} value={value} />
      {unknown && (
        <p role="alert" className="mt-1 text-xs text-red-500">
          {UNKNOWN}
          {!required && (
            <button type="button" onClick={() => setUnknown(false)} className="ml-2 underline">Clear</button>
          )}
        </p>
      )}
      {loadFailed && (
        <p role="alert" className="mt-1 text-xs text-red-500">
          {LOAD_FAILED} — the saved supplier is kept.
          <button type="button" onClick={() => { setFailedId(''); setAttempt((a) => a + 1); }} className="ml-2 underline">Retry</button>
        </p>
      )}
    </div>
  );
}
