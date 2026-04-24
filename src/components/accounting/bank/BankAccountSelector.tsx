import { useEffect, useState } from 'react';
import { Landmark, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

export interface BankAccountOption {
  id: string;
  label: string;
  accountName: string;
  accountCode: string;
  accountNumberLast4: string;
}

interface BankAccountSelectorProps {
  value: string | null;
  onChange: (id: string, option: BankAccountOption) => void;
  disabled?: boolean;
  /** Optional helper text rendered below the select. */
  helpText?: string;
}

export function BankAccountSelector(props: BankAccountSelectorProps) {
  const { value, onChange, disabled, helpText } = props;
  const [options, setOptions] = useState<BankAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch('/api/accounting/chart-of-accounts?subtype=bank');
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
          };
        });
        setOptions(mapped);
        setLoading(false);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Failed to load bank accounts');
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    const option = options.find(o => o.id === id);
    if (option) onChange(id, option);
  }

  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm font-medium text-[var(--ff-text-primary)]">
        <Landmark className="h-4 w-4" />
        Bank account
      </label>
      <div className="relative">
        <select
          value={value ?? ''}
          onChange={handleChange}
          disabled={disabled || loading || options.length === 0}
          className="w-full rounded-lg border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] focus:border-[var(--ff-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--ff-accent)] disabled:opacity-60"
        >
          <option value="" disabled>
            {loading ? 'Loading bank accounts…' : options.length === 0 ? 'No bank accounts found' : 'Select a bank account'}
          </option>
          {options.map(o => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        {loading && (
          <Loader2 className="pointer-events-none absolute right-9 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--ff-text-muted)]" />
        )}
      </div>
      {error && <p className="text-xs text-rose-500">{error}</p>}
      {helpText && !error && <p className="text-xs text-[var(--ff-text-muted)]">{helpText}</p>}
      {!loading && options.length === 0 && !error && (
        <p className="text-xs text-amber-500">
          No bank accounts on file. Create one under Chart of Accounts before importing statements.
        </p>
      )}
    </div>
  );
}
