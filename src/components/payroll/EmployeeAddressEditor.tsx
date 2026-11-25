/**
 * The address form on the employee profile (wave 7 EA1, W5). Checked in the browser by the same rules the server
 * applies (parseEmployeeAddress, SARS BRS V25.3.0 codes 3211-3217, 3285, 3288-3294); the server's refusal is shown as sent.
 */
import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { parseEmployeeAddress, type EmployeeAddress } from '@/modules/accounting/services/payroll/payrollEmployeeAddressInput';

type Form = Record<FieldKey, string> & { sameAsResidential: boolean };
type FieldKey = typeof FIELDS[number]['key'];

/** Each field, in tab order: form key, the server's error key, the label and its e@syFile code. */
const FIELDS = [
  { key: 'unitNumber', path: 'residential.unitNumber', label: 'Unit number', part: 'res' },
  { key: 'complex', path: 'residential.complex', label: 'Complex', part: 'res' },
  { key: 'streetNumber', path: 'residential.streetNumber', label: 'Street number', part: 'res' },
  { key: 'street', path: 'residential.street', label: 'Street or farm name *', part: 'res' },
  { key: 'suburb', path: 'residential.suburb', label: 'Suburb or district', part: 'res' },
  { key: 'city', path: 'residential.city', label: 'City or town', part: 'res' },
  { key: 'postalCode', path: 'residential.postalCode', label: 'Postal code', part: 'res' },
  { key: 'countryCode', path: 'residential.countryCode', label: 'Country code *', part: 'res' },
  { key: 'line1', path: 'postal.line1', label: 'Postal address line 1 *', part: 'post' },
  { key: 'line2', path: 'postal.line2', label: 'Postal address line 2', part: 'post' },
  { key: 'line3', path: 'postal.line3', label: 'Postal address line 3', part: 'post' },
  { key: 'line4', path: 'postal.line4', label: 'Postal address line 4', part: 'post' },
  { key: 'postalPostalCode', path: 'postal.postalCode', label: 'Postal code (postal address)', part: 'post' },
  { key: 'postalCountryCode', path: 'postal.countryCode', label: 'Country code (postal address) *', part: 'post' },
] as const;

function formOf(a: EmployeeAddress | null): Form {
  const r = a?.residential;
  const p = a && !a.postal.sameAsResidential ? a.postal : null;
  return {
    unitNumber: r?.unitNumber ?? '', complex: r?.complex ?? '', streetNumber: r?.streetNumber ?? '', street: r?.street ?? '',
    suburb: r?.suburb ?? '', city: r?.city ?? '', postalCode: r?.postalCode ?? '', countryCode: r?.countryCode ?? 'ZA',
    sameAsResidential: a ? a.postal.sameAsResidential : true,
    line1: p?.line1 ?? '', line2: p?.line2 ?? '', line3: p?.line3 ?? '', line4: p?.line4 ?? '',
    postalPostalCode: p?.postalCode ?? '', postalCountryCode: p?.countryCode ?? 'ZA',
  };
}

function bodyOf(f: Form): unknown {
  return {
    residential: { unitNumber: f.unitNumber, complex: f.complex, streetNumber: f.streetNumber, street: f.street, suburb: f.suburb, city: f.city, postalCode: f.postalCode, countryCode: f.countryCode },
    postal: f.sameAsResidential ? { sameAsResidential: true } : {
      sameAsResidential: false, line1: f.line1, line2: f.line2, line3: f.line3, line4: f.line4, postalCode: f.postalPostalCode, countryCode: f.postalCountryCode,
    },
  };
}

interface Props { employeeId: string; start: EmployeeAddress | null; onSaved: () => void; onCancel: () => void }

export function EmployeeAddressEditor({ employeeId, start, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<Form>(() => formOf(start));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const refs = useRef<Partial<Record<FieldKey, HTMLInputElement | null>>>({});
  const inFlight = useRef(false);

  const change = (key: FieldKey, path: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[path] ? { ...prev, [path]: [] } : prev));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    setError('');
    const parsed = parseEmployeeAddress(bodyOf(form));
    if (!parsed.ok) {
      setErrors(parsed.fieldErrors);
      const first = FIELDS.find((f) => parsed.fieldErrors[f.path]?.length);
      if (first) refs.current[first.key]?.focus();
      return;
    }
    setErrors({});
    inFlight.current = true;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/payroll/employees/${employeeId}/address`, { method: 'PUT', body: JSON.stringify(bodyOf(form)) });
      await assertOk(res, 'Could not save the address - try again');
      onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not save the address - try again'));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const field = (f: typeof FIELDS[number]) => (
    <Input key={f.key} ref={(el) => { refs.current[f.key] = el; }} label={f.label} value={form[f.key]} autoComplete="off"
      aria-required={f.label.endsWith('*') || undefined} error={errors[f.path]?.[0]}
      onChange={(e) => change(f.key, f.path, e.target.value)} />
  );

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Employee address">
      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-[var(--ff-text-primary)]">Residential address</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{FIELDS.filter((f) => f.part === 'res').map(field)}</div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-[var(--ff-text-primary)]">Postal address</legend>
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)]">
          <input type="checkbox" checked={form.sameAsResidential} onChange={(e) => setForm((prev) => ({ ...prev, sameAsResidential: e.target.checked }))} />
          Same as the residential address
        </label>
        {!form.sameAsResidential && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{FIELDS.filter((f) => f.part === 'post').map(field)}</div>
        )}
      </fieldset>
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
