/**
 * Change an approved or part-paid bill's due date (payment-terms programme PR 2). Date only: everything else on an
 * approved bill stays locked. The change is recorded in the bill's history (migration 962).
 */
import { useState } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiFetch, assertOk } from '@/lib/apiFetch';
import { DUE_DATE_SOURCE_LABELS, isDueDateSource } from '@/modules/accounting/services/shared/dueDateSource';
import { formatDisplayDate } from '@/utils/dateFormat';
import { DateField } from '@/components/ui/DateField';

interface Props {
  invoiceId: string;
  status: string;
  invoiceDate: string;
  dueDate?: string;
  dueDateSource?: string;
  onSaved: () => void | Promise<void>;
}

export function BillDueDateEditor({ invoiceId, status, invoiceDate, dueDate, dueDateSource, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(dueDate ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [refused, setRefused] = useState(false);
  if (status !== 'approved' && status !== 'partially_paid') return null;

  const source = isDueDateSource(dueDateSource) ? DUE_DATE_SOURCE_LABELS[dueDateSource] : null;
  const tooEarly = value !== '' && value < invoiceDate;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/supplier-invoices-due-date', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId, dueDate: value }),
      });
      await assertOk(res, 'Could not change the due date - try again');
      setEditing(false);
      await onSaved();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not change the due date - try again'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4" data-testid="bill-due-date-editor">
      <div className="flex flex-wrap items-center gap-3">
        <CalendarClock className="h-4 w-4 text-teal-500" />
        <span className="text-sm text-[var(--ff-text-secondary)]">Due date</span>
        {!editing ? (
          <>
            <span className="text-sm font-medium text-[var(--ff-text-primary)]">{dueDate ? formatDisplayDate(dueDate) : 'None'}</span>
            {source && <span className="text-xs text-[var(--ff-text-tertiary)]">({source})</span>}
            <button
              type="button"
              className="ml-auto text-sm text-teal-600 hover:text-teal-700"
              onClick={() => { setValue(dueDate ?? ''); setRefused(false); setError(''); setEditing(true); }}
            >
              Change due date
            </button>
          </>
        ) : (
          <>
            <div className="w-48">
              <DateField
                label="New due date"
                value={value || null}
                minDate={invoiceDate}
                anchorDate={invoiceDate}
                minMessage="The due date cannot be before the invoice date."
                onChange={(iso, validity) => { setValue(iso ?? ''); setRefused(!validity.valid); }}
              />
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded bg-brand-600 px-3 py-1 text-sm text-white disabled:opacity-50"
              disabled={saving || refused || value === '' || tooEarly || value === dueDate}
              onClick={() => { void save(); }}
            >
              {saving && <Loader2 className="h-3 w-3 animate-spin" />} Save
            </button>
            <button type="button" className="text-sm text-[var(--ff-text-secondary)]" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
      {editing && <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">Only the due date changes. The change is recorded in the invoice&apos;s history.</p>}
      {tooEarly && <p className="mt-2 text-xs text-red-400">The due date cannot be before the invoice date.</p>}
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
