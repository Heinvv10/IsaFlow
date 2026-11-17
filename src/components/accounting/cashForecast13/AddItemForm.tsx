/**
 * "Add expected item" (writers): a receipt or payment the books do not know yet. Amount is entered positive; the
 * direction gives the sign (data layer #1509, POST /items). A repeat (weekly / monthly) may end on a date on or
 * after the first one. One submit at a time; a refusal shows the server's message and keeps what was typed.
 */
import { useState } from 'react';
import { Button, DateField, Input, Modal, MoneyField } from '@/components/ui';
import type { ApiResult } from '@/components/accounting/budgets/workspace/types';
import { PHONE_TAP } from '@/components/accounting/formActionBar';
import type { CashCategory } from '@/modules/accounting/services/cashForecast13/types';
import type { ItemBody, ItemDirection, ItemRepeat } from './cash13Client';
import { useGuardedSubmit } from './useGuardedSubmit';

export const CATEGORY_LABELS: Record<CashCategory, string> = {
  customer_receipts: 'Receipts from customers',
  supplier_payments: 'Supplier payments',
  payroll: 'Payroll',
  sars: 'SARS',
  loans: 'Loans',
  other: 'Other',
};

const REPEATS: ReadonlyArray<[ItemRepeat, string]> = [['none', 'Once'], ['weekly', 'Every week'], ['monthly', 'Every month']];
const SELECT = 'w-full rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-bg-primary)] px-3 py-2 text-sm text-[var(--ff-text-primary)] max-lg:min-h-11';
const LABEL = 'block text-sm font-medium text-[var(--ff-text-primary)]';

export function AddItemForm({ onClose, onCreate }: { onClose: () => void; onCreate: (body: ItemBody) => Promise<ApiResult<unknown>> }) {
  const [direction, setDirection] = useState<ItemDirection>('receipt');
  const [amountCents, setAmountCents] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [repeat, setRepeat] = useState<ItemRepeat>('none');
  const [until, setUntil] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<CashCategory>('other');
  const [localError, setLocalError] = useState<string | null>(null);
  const { busy, error, submit } = useGuardedSubmit();

  const save = async () => {
    if (amountCents === null || amountCents <= 0) { setLocalError('Enter an amount more than 0.'); return; }
    if (!date) { setLocalError('Enter the expected date.'); return; }
    if (!description.trim()) { setLocalError('Enter a description.'); return; }
    if (repeat !== 'none' && until !== null && until < date) { setLocalError('The repeat ends on or after the first date.'); return; }
    setLocalError(null);
    const body: ItemBody = {
      direction, amount: amountCents / 100, date, repeat, repeatUntil: repeat === 'none' ? null : until, description: description.trim(), category,
    };
    await submit(() => onCreate(body), onClose);
  };

  const shown = localError ?? error;
  return (
    <Modal open onClose={onClose} title="Add an expected item" size="md">
      <Modal.Body className="space-y-4">
        <fieldset className="space-y-2">
          <legend className={LABEL}>This is</legend>
          <div className="flex gap-4">
            {(['receipt', 'payment'] as const).map((d) => (
              <label key={d} className={`flex items-center gap-2 text-sm text-[var(--ff-text-primary)] ${PHONE_TAP}`}>
                <input type="radio" name="cash13-direction" value={d} checked={direction === d} onChange={() => setDirection(d)} />
                {d === 'receipt' ? 'Money coming in' : 'Money going out'}
              </label>
            ))}
          </div>
        </fieldset>
        <MoneyField label="Amount" value={amountCents} onChange={(c) => setAmountCents(c)} required />
        <DateField label="Expected date" value={date} onChange={(d) => setDate(d)} required keepsEscape />
        <div className="space-y-1">
          <label htmlFor="cash13-repeat" className={LABEL}>Repeats</label>
          <select id="cash13-repeat" className={SELECT} value={repeat} onChange={(e) => setRepeat(e.target.value as ItemRepeat)}>
            {REPEATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {repeat !== 'none' && (
          <DateField label="Repeats until (optional)" value={until} onChange={(d) => setUntil(d)} minDate={date ?? undefined} keepsEscape
            helperText="Leave empty to repeat to the end of the forecast." />
        )}
        <Input label="Description" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} required />
        <div className="space-y-1">
          <label htmlFor="cash13-category" className={LABEL}>Show it under</label>
          <select id="cash13-category" className={SELECT} value={category} onChange={(e) => setCategory(e.target.value as CashCategory)}>
            {(Object.keys(CATEGORY_LABELS) as CashCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
        </div>
        {shown && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{shown}</p>}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" className={PHONE_TAP} onClick={onClose} disabled={busy}>Cancel</Button>
        <Button className={PHONE_TAP} onClick={() => void save()} loading={busy}>Add item</Button>
      </Modal.Footer>
    </Modal>
  );
}
