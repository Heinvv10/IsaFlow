/**
 * A personal service provider's entity particulars (wave 6 PSP-H; its own file, mounted on the work card by one line): the
 * trading name, registration number and income tax reference its H certificate is filed under (SARS PAYE Employer
 * Reconciliation BRS V25.3.0: 3030 p. 20, 3066 p. 24, 3100 p. 26-27). Shown for a stored PSP only. Saved through the employee
 * PATCH, which judges them (payrollEmployeePspEntity) and refuses a Login-as session; only an owner or admin may save.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';

const SAVE_FAILED = 'Could not save the entity particulars - try again';

export interface PspParticularsValue { pspEntityName?: string | null; pspRegistrationNumber?: string | null; pspTaxReference?: string | null }

interface Props {
  employeeId: string;
  entity: 'company' | 'trust' | null | undefined;
  stored: PspParticularsValue;
  canEdit: boolean;
  onSaved: (saved: PspParticularsValue) => void;
}

const text = (v: string | null | undefined) => v ?? '';

export function PspEntityParticularsField({ employeeId, entity, stored, canEdit, onSaved }: Props) {
  const [draft, setDraft] = useState({ name: text(stored.pspEntityName), reg: text(stored.pspRegistrationNumber), tax: text(stored.pspTaxReference) });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const dirty = draft.name.trim() !== text(stored.pspEntityName) || draft.reg.trim() !== text(stored.pspRegistrationNumber)
    || draft.tax.trim() !== text(stored.pspTaxReference);
  const set = (k: keyof typeof draft) => (e: { target: { value: string } }) => { setDraft((d) => ({ ...d, [k]: e.target.value })); setDone(false); };

  async function save(): Promise<void> {
    setSaving(true);
    setError('');
    setDone(false);
    try {
      const d = (await apiJson(`/api/payroll/employees/${employeeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ pspEntityName: draft.name.trim() || null, pspRegistrationNumber: draft.reg.trim() || null, pspTaxReference: draft.tax.trim() || null }),
      }, SAVE_FAILED)) as PspParticularsValue;
      onSaved({ pspEntityName: d.pspEntityName ?? null, pspRegistrationNumber: d.pspRegistrationNumber ?? null, pspTaxReference: d.pspTaxReference ?? null });
      setDone(true);
    } catch (err) {
      setError(apiErrorMessage(err, SAVE_FAILED));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 border-t border-[var(--ff-border-primary)] pt-4" data-testid="psp-particulars-field">
      <h4 className="text-sm font-semibold text-[var(--ff-text-primary)]">Personal service provider certificate (IRP5, nature of person H)</h4>
      <p className="mt-1 text-xs text-[var(--ff-text-secondary)]">
        The {entity === 'trust' ? 'trust' : 'company'}&apos;s particulars. Without the trading name (and the tax reference where PAYE was
        deducted) its months are left off the e@syFile file.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input label="Trading name" maxLength={120} value={draft.name} disabled={!canEdit} onChange={set('name')} />
        <Input label={entity === 'trust' ? 'Trust registration number' : 'Company registration number (CCYY/NNNNNN/NN)'} maxLength={30}
          value={draft.reg} disabled={!canEdit} onChange={set('reg')} />
        <Input label="Income tax reference (starts with 9)" inputMode="numeric" maxLength={10} value={draft.tax} disabled={!canEdit} onChange={set('tax')} />
      </div>
      {canEdit && (
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" onClick={() => void save()} disabled={!dirty} loading={saving}>Save particulars</Button>
        </div>
      )}
      {done && <p role="status" className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">Particulars saved.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}
    </div>
  );
}
