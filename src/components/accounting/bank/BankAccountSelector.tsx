import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, type SelectOption } from '@/components/ui/Select';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { groupBankAccountOptions } from './groupBankOptions';

export interface BankAccountOption {
  id: string;
  label: string;
  accountName: string;
  accountCode: string;
  accountNumberLast4: string;
  parentAccountId: string | null;
}

interface BankAccountSelectorProps {
  value: string | null;
  onChange: (id: string, option: BankAccountOption) => void;
  disabled?: boolean;
  /** Optional helper text rendered below the select. */
  helpText?: string;
  /** Pre-select this account once options load (e.g. from a ?account_id= link). */
  initialValue?: string | null;
}

export function BankAccountSelector(props: BankAccountSelectorProps) {
  const { value, onChange, disabled, helpText, initialValue } = props;
  const [options, setOptions] = useState<BankAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await apiFetch('/api/accounting/chart-of-accounts?subtype=bank');
        await assertOk(res, 'Could not load bank accounts - try again');
        const json = await res.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any[] = Array.isArray(json?.data) ? json.data : json?.data?.accounts || [];
        if (!alive) return;
        const mapped: BankAccountOption[] = data.map(a => {
          const last4 = (a.bankAccountNumber || a.bank_account_number || '').slice(-4);
          const code = a.accountCode || a.account_code || '';
          const name = a.accountName || a.account_name || '';
          return {
            id: String(a.id),
            accountName: name,
            accountCode: code,
            accountNumberLast4: last4,
            label: `${code} — ${name}${last4 ? ` (****${last4})` : ''}`,
            parentAccountId: a.parentAccountId || a.parent_account_id || null,
          };
        });
        setOptions(mapped);
        setLoading(false);
      } catch (err) {
        if (!alive) return;
        setError(apiErrorMessage(err, 'Could not load bank accounts - try again'));
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Apply the deep-link preselect once options arrive. The fired ref makes
  // this one-shot even if the parent re-renders with a fresh onChange before
  // `value` settles; the `value` guard keeps manual selections untouched.
  const preselectFired = useRef(false);
  useEffect(() => {
    if (preselectFired.current || !initialValue || value || options.length === 0) return;
    const option = options.find(o => o.id === initialValue);
    if (option) {
      preselectFired.current = true;
      onChange(option.id, option);
    }
  }, [initialValue, value, options, onChange]);

  function handleChange(id: string | null) {
    const option = options.find(o => o.id === id);
    if (id && option) onChange(id, option);
  }

  const grouped = useMemo(() => groupBankAccountOptions(options), [options]);
  const selectOptions = useMemo<SelectOption[]>(() => [
    ...grouped.primaries.map(o => ({ value: o.id, label: o.label })),
    ...grouped.groups.flatMap(g => g.children.map(o => ({ value: o.id, label: o.label, group: g.umbrella.label }))),
  ], [grouped]);
  const placeholder = loading ? 'Loading bank accounts…' : options.length === 0 ? 'No bank accounts found' : 'Select a bank account';

  return (
    <div className="space-y-1.5">
      <Select
        label="Bank account"
        labelClassName="mb-0 flex items-center gap-2 text-sm font-medium text-[var(--ff-text-primary)]"
        options={selectOptions}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled || loading || options.length === 0}
        loading={loading}
        emptyText="No bank accounts found"
      />
      {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {helpText && !error && <p className="text-xs text-[var(--ff-text-muted)]">{helpText}</p>}
      {!loading && options.length === 0 && !error && (
        <p className="text-xs text-amber-500">
          No bank accounts on file. Create one under Chart of Accounts before importing statements.
        </p>
      )}
    </div>
  );
}
