/**
 * The address form on the employee profile (wave 7 EA1, W5). Checked in the browser by the same rules the server
 * applies (parseEmployeeAddress, SARS BRS V25.3.0 codes 3211-3217, 3285, 3288-3294); the server's refusal is shown as sent.
 */
import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiErrorMessage } from '@/lib/apiFetch';
import type { EmployeeAddress } from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';
import { AddressFields } from './AddressFields';
import {
  addressFormOf, saveEmployeeAddress, validateAddressForm, type AddressErrors, type AddressFieldKey, type AddressForm,
} from './addressForm';

interface Props { employeeId: string; start: EmployeeAddress | null; onSaved: () => void; onCancel: () => void }

export function EmployeeAddressEditor({ employeeId, start, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<AddressForm>(() => addressFormOf(start));
  const [errors, setErrors] = useState<AddressErrors>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const refs = useRef<Partial<Record<AddressFieldKey, HTMLInputElement | null>>>({});
  const inFlight = useRef(false);

  const change = (key: AddressFieldKey, path: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[path] ? { ...prev, [path]: [] } : prev));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    setError('');
    const found = validateAddressForm(form);
    setErrors(found.errors);
    if (found.first) { refs.current[found.first]?.focus(); return; }
    inFlight.current = true;
    setSaving(true);
    try {
      await saveEmployeeAddress(employeeId, form);
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the address - try again'));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Employee address">
      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      <AddressFields form={form} errors={errors} required onChange={change}
        onSameChange={(same) => setForm((prev) => ({ ...prev, sameAsResidential: same }))}
        fieldRef={(k) => (el) => { refs.current[k] = el; }} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}Save address
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]">Cancel</button>
      </div>
    </form>
  );
}
