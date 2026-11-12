/**
 * Journal reversal confirmation (audit P3.2). Names the entry, its date, total
 * and line count, and lets the user reverse on the original date (no
 * `reversal_date` sent, the server's default) or on a chosen date (sent as
 * `reversal_date`; the server validates it against open periods).
 */

import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/components/accounting/ConfirmDialog';
import { DateField } from '@/components/ui/DateField';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

export interface ReverseJournalSummary {
  entryNumber: string;
  entryDate: string;
  totalDebit: number;
  lineCount: number;
}

interface Props {
  open: boolean;
  entry: ReverseJournalSummary;
  busy: boolean;
  /** `undefined` = reverse on the original entry date. */
  onConfirm: (reversalDate: string | undefined) => void;
  onCancel: () => void;
}

export function ReverseJournalDialog({ open, entry, busy, onConfirm, onCancel }: Props) {
  const [mode, setMode] = useState<'original' | 'chosen'>('original');
  const [date, setDate] = useState<string | null>(null);
  const [dateValid, setDateValid] = useState(true);

  useEffect(() => {
    if (open) { setMode('original'); setDate(null); setDateValid(true); }
  }, [open]);

  const chosenOk = mode === 'original' || (date !== null && dateValid);

  const message = (
    <div className="space-y-3 whitespace-normal">
      <p>
        Reverse journal <strong>{entry.entryNumber}</strong> dated {formatDisplayDate(entry.entryDate)}:
        {' '}{formatMoney(entry.totalDebit)} across {entry.lineCount} line{entry.lineCount === 1 ? '' : 's'}.
        This posts an equal and opposite journal.
      </p>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Reversal date</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="reversal-date-mode" checked={mode === 'original'} onChange={() => setMode('original')} />
          Original entry date ({formatDisplayDate(entry.entryDate)})
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="reversal-date-mode" checked={mode === 'chosen'} onChange={() => setMode('chosen')} />
          Another date
        </label>
        {mode === 'chosen' && (
          <DateField
            label="Reverse on"
            value={date}
            required
            onChange={(iso, validity) => { setDate(iso); setDateValid(validity.valid); }}
          />
        )}
      </fieldset>
    </div>
  );

  return (
    <ConfirmDialog
      open={open}
      title={`Reverse ${entry.entryNumber}`}
      message={message}
      confirmLabel="Reverse journal"
      confirmTone="danger"
      busy={busy}
      confirmDisabled={!chosenOk}
      onConfirm={() => onConfirm(mode === 'chosen' && date ? date : undefined)}
      onCancel={onCancel}
    />
  );
}
