/**
 * The editor for one cell of the 13-week grid (writers only): Set to / Add / Move to another week, with a note.
 * The draft becomes the PUT body in `buildOverrideBody` (sign rules there). A cell already changed by hand
 * offers "Remove this change" (DELETE by the override's id). One submit at a time; a refusal shows the
 * server's message and keeps the dialog open; a save closes it and the page reloads the forecast.
 */
import { useState } from 'react';
import { Button, Input, Modal, MoneyField } from '@/components/ui';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import { formatStatementFigure } from '@/lib/format/money';
import type { ForecastLine, ForecastWeek } from '@/modules/accounting/services/cashForecast13/types';
import { PHONE_TAP } from '@/components/accounting/formActionBar';
import { buildOverrideBody, type OverrideBody, type OverrideMode } from './overridePayload';
import { weekLabel } from './forecastRows';
import type { StoredOverride } from './cash13Client';
import { useGuardedSubmit } from './useGuardedSubmit';

export interface CellEditorProps {
  line: ForecastLine;
  week: number;
  weeks: readonly ForecastWeek[];
  existing: StoredOverride | undefined;
  onClose: () => void;
  onSave: (body: OverrideBody) => Promise<ApiResult<unknown>>;
  onRemove: (id: string) => Promise<ApiResult<unknown>>;
}

const MODES: ReadonlyArray<{ id: OverrideMode; label: string }> = [
  { id: 'set', label: 'Set to' },
  { id: 'add', label: 'Add' },
  { id: 'move_to', label: 'Move to another week' },
];

const rands = (cents: number) => formatStatementFigure(cents / 100, { symbol: true, cents: true });

export function CellEditor({ line, week, weeks, existing, onClose, onSave, onRemove }: CellEditorProps) {
  const cell = line.weekly[week] ?? 0;
  const [mode, setMode] = useState<OverrideMode>('set');
  const [amountCents, setAmountCents] = useState<number | null>(null);
  const [amountValid, setAmountValid] = useState(true);
  const [wholeCell, setWholeCell] = useState(true);
  const [targetWeek, setTargetWeek] = useState<number | null>(null);
  const [note, setNote] = useState(existing?.note ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, submit } = useGuardedSubmit();

  const save = async () => {
    if (!amountValid && !(mode === 'move_to' && wholeCell)) { setLocalError('The amount could not be read.'); return; }
    const built = buildOverrideBody({ mode, amountCents, wholeCell, targetWeek, note }, line, week, weeks);
    if (!built.ok) { setLocalError(built.message); return; }
    setLocalError(null);
    await submit(() => onSave(built.body), onClose);
  };

  const remove = async () => {
    if (!existing) return;
    await submit(() => onRemove(existing.id), onClose);
  };

  const shown = localError ?? error;
  const onAmount = (c: number | null, v: { valid: boolean }) => { setAmountCents(c); setAmountValid(v.valid); };

  return (
    <Modal open onClose={onClose} title={`${line.label} · ${weekLabel(weeks[week] as ForecastWeek)}`} size="md">
      <Modal.Body className="space-y-4">
        <p className="text-sm text-[var(--ff-text-secondary)]">This week: {cell === 0 ? 'nothing' : rands(cell)}</p>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-[var(--ff-text-primary)]">Change</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            {MODES.map((m) => (
              <label key={m.id} className={`flex items-center gap-2 text-sm text-[var(--ff-text-primary)] ${PHONE_TAP}`}>
                <input type="radio" name="cash13-mode" value={m.id} checked={mode === m.id} onChange={() => { setMode(m.id); setLocalError(null); }}
                  disabled={m.id === 'move_to' && cell === 0} />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>
        {mode === 'move_to' ? (
          <>
            <label className={`flex items-center gap-2 text-sm text-[var(--ff-text-primary)] ${PHONE_TAP}`}>
              <input type="checkbox" checked={wholeCell} onChange={(e) => setWholeCell(e.target.checked)} />
              Move the whole week
            </label>
            {!wholeCell && <MoneyField label="Amount to move" value={amountCents} onChange={onAmount} />}
            <div className="space-y-1">
              <label htmlFor="cash13-target" className="block text-sm font-medium text-[var(--ff-text-primary)]">Move to</label>
              <select id="cash13-target" className="w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)]"
                value={targetWeek ?? ''} onChange={(e) => setTargetWeek(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Choose a week</option>
                {weeks.filter((w) => w.index !== week).map((w) => <option key={w.index} value={w.index}>{weekLabel(w)}</option>)}
              </select>
            </div>
          </>
        ) : (
          <MoneyField label={mode === 'set' ? 'New amount' : 'Amount to add'} value={amountCents} onChange={onAmount}
            allowNegative={mode === 'add'} helperText={mode === 'add' ? 'A negative amount means less.' : 'As it reads in the grid, without a minus sign.'} />
        )}
        <Input label="Note (optional)" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        {shown && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{shown}</p>}
      </Modal.Body>
      <Modal.Footer>
        {existing && <Button variant="ghost" className={PHONE_TAP} onClick={() => void remove()} disabled={busy}>Remove this change</Button>}
        <Button variant="secondary" className={PHONE_TAP} onClick={onClose} disabled={busy}>Cancel</Button>
        <Button className={PHONE_TAP} onClick={() => void save()} loading={busy}>Save change</Button>
      </Modal.Footer>
    </Modal>
  );
}
