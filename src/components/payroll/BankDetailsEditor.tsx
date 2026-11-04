import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import { BankFields } from './employeeCreate/BankFields';
import {
  BANK_FIELD_ORDER, emptyBank, saveBankDetails, validateBank,
  type AccountType, type BankErrors, type BankForm, type BankKey,
} from './employeeCreate/bankDetails';

interface Props {
  employeeId: string;
  /** A change keeps the bank name and type; the numbers are always typed again (the card never holds the full ones). */
  start?: { bankName: string; accountType: AccountType };
  /** The current details name a holder (the mask shows one): it has to be typed again on a change. */
  holderRequired?: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

/** The first-entry and change form on the profile card. Shows the server's refusal as sent. */
export function BankDetailsEditor({ employeeId, start, holderRequired, onSaved, onCancel }: Props) {
  const [bank, setBank] = useState<BankForm>(() => ({ ...emptyBank(), ...start }));
  const [errors, setErrors] = useState<BankErrors>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearHolder, setClearHolder] = useState(false);
  const refs = useRef<Partial<Record<BankKey, HTMLElement | null>>>({});
  const inFlight = useRef(false);

  const change = <K extends keyof BankForm>(k: K, v: BankForm[K]) => {
    setBank(prev => ({ ...prev, [k]: v }));
    setErrors(prev => (k in prev ? { ...prev, [k]: undefined } : prev));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    setError('');
    const found = validateBank(bank, { holderRequired: holderRequired && !clearHolder });
    setErrors(found);
    const first = BANK_FIELD_ORDER.find(k => found[k]);
    if (first) { refs.current[first]?.focus(); return; }
    inFlight.current = true;
    setSaving(true);
    try {
      await saveBankDetails(employeeId, bank, { clearHolder: clearHolder && Boolean(holderRequired) });
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the bank details - try again'));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      <BankFields bank={bank} errors={errors} onChange={change} fieldRef={k => el => { refs.current[k] = el; }}
        holderDisabled={clearHolder}
        hint={start ? 'Type the full number again; the current one is never shown here.' : undefined} />
      {holderRequired && (
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" checked={clearHolder} onChange={e => { setClearHolder(e.target.checked); if (e.target.checked) change('accountHolder', ''); }} />
          Remove account holder
        </label>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}Save bank details
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
      </div>
    </form>
  );
}
