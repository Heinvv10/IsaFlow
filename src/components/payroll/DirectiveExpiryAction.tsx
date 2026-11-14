/**
 * "Set expiry" on an approved fixed-percentage / fixed-amount directive (wave 5 DR). Once a run was taxed by one it
 * cannot be cancelled (409: "set an expiry date instead"); this sets or shortens its expiry date through
 * PATCH /api/accounting/tax-directives/[id] { expiry_date }, which refuses a later date or one before a run it taxed.
 */
import { useState } from 'react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { DateField } from '@/components/ui/DateField';

export function DirectiveExpiryAction({ id, onSaved, onError }: { id: string; onSaved: () => void; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!date) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/accounting/tax-directives/${id}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiry_date: date }),
      });
      await assertOk(res, 'Could not set the expiry date - try again');
      setOpen(false);
      onSaved();
    } catch (err) {
      onError(apiErrorMessage(err, 'Could not set the expiry date - try again'));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="text-xs text-teal-500 hover:text-teal-400">Set expiry</button>;
  }
  return (
    <div className="flex items-end gap-2">
      <DateField label="Expiry Date" value={date} onChange={(iso, v) => setDate(v.valid ? iso : null)} />
      <button type="button" disabled={!date || saving} onClick={() => void save()} className="text-xs text-teal-500 hover:text-teal-400 disabled:opacity-50">Save</button>
      <button type="button" onClick={() => setOpen(false)} className="text-xs text-[var(--ff-text-secondary)]">Close</button>
    </div>
  );
}
