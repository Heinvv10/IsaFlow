/**
 * The 13-week tab's stored inputs: the salary pay day (day N of the month, or the last working day; PUT
 * /pay-day) and the expected items already added (DELETE /items). Writers change them; viewers read them.
 * One submit at a time; a refusal shows the server's message.
 */
import { useEffect, useState } from 'react';
import { Button, Input } from '@/components/ui';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import { formatStatementFigure } from '@/lib/format/money';
import { PHONE_TAP } from '@/components/accounting/formActionBar';
import type { PayDayRule, PayDaySetting, StoredItem } from './cash13Client';
import { CATEGORY_LABELS } from './AddItemForm';
import { useGuardedSubmit } from './useGuardedSubmit';

const PANEL = 'rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-4';
const R = (rand: number) => formatStatementFigure(rand, { symbol: true, cents: true });

export function payDayWords(s: PayDaySetting): string {
  const rule = s.payDay.kind === 'last_working_day' ? 'the last working day of the month' : `day ${s.payDay.day} of the month`;
  return s.isDefault ? `Salaries are paid on ${rule} (not chosen yet).` : `Salaries are paid on ${rule}.`;
}

export function PayDayControl({ setting, canEdit, onSave }: {
  setting: PayDaySetting | null; canEdit: boolean; onSave: (rule: PayDayRule) => Promise<ApiResult<unknown>>;
}) {
  const [kind, setKind] = useState<PayDayRule['kind']>('day_of_month');
  const [day, setDay] = useState('25');
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, submit } = useGuardedSubmit();

  useEffect(() => {
    if (!setting) return;
    setKind(setting.payDay.kind);
    setDay(String(setting.day));
  }, [setting]);

  const save = async () => {
    const n = Number(day);
    if (kind === 'day_of_month' && !(Number.isInteger(n) && n >= 1 && n <= 31)) { setLocalError('Enter a day from 1 to 31.'); return; }
    setLocalError(null);
    await submit(() => onSave(kind === 'last_working_day' ? { kind } : { kind, day: n }));
  };

  const shown = localError ?? error;
  return (
    <section className={PANEL} aria-labelledby="cash13-payday">
      <h3 id="cash13-payday" className="text-sm font-semibold text-[var(--ff-text-primary)]">Pay day</h3>
      <p className="mt-1 text-sm text-[var(--ff-text-primary)]" data-testid="payday-words">{setting ? payDayWords(setting) : 'The pay day could not be loaded.'}</p>
      {canEdit && setting && (
        <fieldset className="mt-3 space-y-2">
          <legend className="sr-only">When salaries are paid</legend>
          <label className={`flex items-center gap-2 text-sm text-[var(--ff-text-primary)] ${PHONE_TAP}`}>
            <input type="radio" name="cash13-payday" checked={kind === 'day_of_month'} onChange={() => setKind('day_of_month')} />
            A day of the month
          </label>
          {kind === 'day_of_month' && (
            <Input label="Day (1 to 31)" inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} className="max-w-[8rem]"
              helperText="A day past the end of a short month means its last day." />
          )}
          <label className={`flex items-center gap-2 text-sm text-[var(--ff-text-primary)] ${PHONE_TAP}`}>
            <input type="radio" name="cash13-payday" checked={kind === 'last_working_day'} onChange={() => setKind('last_working_day')} />
            The last working day of the month
          </label>
          {shown && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{shown}</p>}
          <Button size="sm" className={PHONE_TAP} onClick={() => void save()} loading={busy}>Save pay day</Button>
        </fieldset>
      )}
    </section>
  );
}

export function ExpectedItemsList({ items, canEdit, onDelete }: {
  items: readonly StoredItem[]; canEdit: boolean; onDelete: (id: string) => Promise<ApiResult<unknown>>;
}) {
  const { busy, error, submit } = useGuardedSubmit();
  if (items.length === 0) return null;
  return (
    <section className={PANEL} aria-labelledby="cash13-items">
      <h3 id="cash13-items" className="text-sm font-semibold text-[var(--ff-text-primary)]">Expected items you added</h3>
      <ul className="mt-2 divide-y divide-[var(--ff-border-primary)] text-sm">
        {items.map((it) => (
          <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="text-[var(--ff-text-primary)]">
              {it.description}
              <span className="block text-xs text-ink-muted">
                {it.direction === 'receipt' ? 'In' : 'Out'} {R(it.amount)} · {it.date}
                {it.repeat !== 'none' ? ` · every ${it.repeat === 'weekly' ? 'week' : 'month'}${it.repeatUntil ? ` until ${it.repeatUntil}` : ''}` : ''}
                {' · '}{CATEGORY_LABELS[it.category]}
              </span>
            </span>
            {canEdit && (
              <Button size="sm" variant="ghost" className={PHONE_TAP} disabled={busy} aria-label={`Remove ${it.description}`}
                onClick={() => void submit(() => onDelete(it.id))}>Remove</Button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
