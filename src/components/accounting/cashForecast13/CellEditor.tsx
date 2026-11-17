/**
 * The editor for one cell of the 13-week grid (writers only): Set to / Add / Move to another week, Money in or
 * Money out, an amount typed as a positive figure, and a note. One override per cell (the PUT upserts), so a save
 * REPLACES the cell's stored change: the editor works on the BASE (editorBase.ts: the source line with every
 * stored change but this cell's own, through the engine's applyOverrides), and the preview is the engine's result
 * of the draft on that base. A stored change pre-fills the editor ("Remove this change" deletes it). One submit at a time; a refusal shows the server's message and keeps the dialog open.
 */
import { useMemo, useState } from 'react';
import { Button, Input, Modal, MoneyField } from '@/components/ui';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import { formatCents } from '@/lib/money/formatMoney';
import { editorBase, isNoOpResave, previewOf, toEngineOverrides, withOverrides } from './editorBase';
import type { ForecastLine, ForecastWeek } from '@/modules/accounting/services/cashForecast13/types';
import { PHONE_TAP } from '@/components/accounting/formActionBar';
import {
  buildOverrideBody, cellSign, draftFromOverride,
  type ExistingOverride, type OverrideBody, type OverrideDraft, type OverrideMode,
} from './overridePayload';
import { weekLabel } from './forecastRows';
import { useGuardedSubmit } from './useGuardedSubmit';

export interface CellEditorProps {
  /** The SOURCE line as the forecast has it (its override deltas are on a separate line). */
  line: ForecastLine;
  /** Every stored override of the company, in application order. */
  stored: readonly ExistingOverride[];
  week: number;
  weeks: readonly ForecastWeek[];
  existing: ExistingOverride | undefined;
  onClose: () => void;
  onSave: (body: OverrideBody) => Promise<ApiResult<unknown>>;
  onRemove: (id: string) => Promise<ApiResult<unknown>>;
}

const MODES: ReadonlyArray<{ id: OverrideMode; label: string }> = [
  { id: 'set', label: 'Set to' },
  { id: 'add', label: 'Add' },
  { id: 'move_to', label: 'Move to another week' },
];

/** The footer's buttons wrap (and take the width) on a 360px phone instead of running off the dialog. */
export const EDITOR_FOOTER = 'flex-wrap max-sm:[&>button]:flex-1';
const RADIO = `flex items-center gap-2 text-sm text-[var(--ff-text-primary)] ${PHONE_TAP}`;

export function CellEditor({ line: source, stored, week, weeks, existing, onClose, onSave, onRemove }: CellEditorProps) {
  const line = useMemo(() => editorBase(source, stored, week, weeks), [source, stored, week, weeks]);
  const shownNow = useMemo(() => withOverrides(source, toEngineOverrides(stored, weeks)).weekly[week] ?? 0, [source, stored, week, weeks]);
  const cell = line.weekly[week] ?? 0;
  const [draft, setDraft] = useState<OverrideDraft>(() => (existing
    ? draftFromOverride(existing, line, week, weeks)
    : { mode: 'set', direction: cellSign(line, week), amountCents: null, wholeCell: true, targetWeek: null, note: '' }));
  const [amountValid, setAmountValid] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, submit } = useGuardedSubmit();
  const patch = (p: Partial<OverrideDraft>) => { setDraft((d) => ({ ...d, ...p })); setLocalError(null); };

  const save = async () => {
    if (!amountValid && !(draft.mode === 'move_to' && draft.wholeCell)) { setLocalError('The amount could not be read.'); return; }
    const built = buildOverrideBody(draft, line, week, weeks);
    if (!built.ok) { setLocalError(built.message); return; }
    setLocalError(null);
    await submit(() => onSave(built.body), onClose);
  };

  const remove = async () => {
    if (!existing) return;
    await submit(() => onRemove(existing.id), onClose);
  };

  const shown = localError ?? error;
  const built = buildOverrideBody(draft, line, week, weeks);
  const unchanged = built.ok && isNoOpResave(built.body, existing);
  const preview = !built.ok ? null // incomplete: nothing to state yet
    : unchanged ? `No change to the figures: week ${week + 1} stays ${formatCents(shownNow)}.`
      : previewOf(built.body, line, week, draft.mode === 'move_to' ? draft.targetWeek : null, weeks);
  const onAmount = (c: number | null, v: { valid: boolean }) => { patch({ amountCents: c }); setAmountValid(v.valid); };

  return (
    <Modal open onClose={onClose} title={`${line.label} · ${weekLabel(weeks[week] as ForecastWeek)}`} size="md">
      <Modal.Body className="space-y-4">
        <p className="text-sm text-[var(--ff-text-secondary)]" data-testid="cell-in-force">This week: {formatCents(shownNow)}</p>
        {existing && (
          <p className="text-sm text-[var(--ff-text-primary)]" data-testid="replaces-note">
            This replaces your earlier change to this week. Without it the week is {formatCents(cell)}.
          </p>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-[var(--ff-text-primary)]">Change</legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
            {MODES.map((m) => (
              <label key={m.id} className={RADIO}>
                <input type="radio" name="cash13-mode" value={m.id} checked={draft.mode === m.id} onChange={() => patch({ mode: m.id })}
                  disabled={m.id === 'move_to' && cell === 0} />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>
        {draft.mode === 'move_to' ? (
          <>
            <label className={RADIO}>
              <input type="checkbox" checked={draft.wholeCell} onChange={(e) => patch({ wholeCell: e.target.checked })} />
              Move the whole week
            </label>
            {!draft.wholeCell && <MoneyField label="Amount to move" value={draft.amountCents} onChange={onAmount} />}
            <div className="space-y-1">
              <label htmlFor="cash13-target" className="block text-sm font-medium text-[var(--ff-text-primary)]">Move to</label>
              <select id="cash13-target" className="w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] max-lg:min-h-11"
                value={draft.targetWeek ?? ''} onChange={(e) => patch({ targetWeek: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">Choose a week</option>
                {weeks.filter((w) => w.index !== week).map((w) => <option key={w.index} value={w.index}>{weekLabel(w)}</option>)}
              </select>
            </div>
          </>
        ) : (
          <>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-[var(--ff-text-primary)]">Direction</legend>
              <div className="flex gap-4">
                {([[1, 'Money in'], [-1, 'Money out']] as const).map(([d, l]) => (
                  <label key={d} className={RADIO}>
                    <input type="radio" name="cash13-direction" checked={draft.direction === d} onChange={() => patch({ direction: d })} />
                    {l}
                  </label>
                ))}
              </div>
            </fieldset>
            <MoneyField label={draft.mode === 'set' ? 'New amount' : 'Amount to add'} value={draft.amountCents} onChange={onAmount}
              helperText="Type the amount without a minus sign; the direction above gives its sign." />
          </>
        )}
        <Input label="Note (optional)" value={draft.note} maxLength={500} onChange={(e) => patch({ note: e.target.value })} />
        {preview && <p className="text-sm font-medium text-[var(--ff-text-primary)]" data-testid="override-preview">{preview}</p>}
        {shown && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{shown}</p>}
      </Modal.Body>
      <Modal.Footer className={EDITOR_FOOTER}>
        {existing && <Button variant="ghost" className={PHONE_TAP} onClick={() => void remove()} disabled={busy}>Remove this change</Button>}
        <Button variant="secondary" className={PHONE_TAP} onClick={onClose} disabled={busy}>Cancel</Button>
        <Button className={PHONE_TAP} onClick={() => void save()} loading={busy}>Save change</Button>
      </Modal.Footer>
    </Modal>
  );
}
