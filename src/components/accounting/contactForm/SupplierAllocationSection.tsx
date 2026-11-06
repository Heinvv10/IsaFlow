/** The supplier form's opening balance (create only) and auto-allocate control. */
import { useState } from 'react';
import { DateField } from '@/components/ui';
import type { SupplierFormData } from '@/components/accounting/SupplierForm';
import { Card, SectionTitle, TextField, selectClass, type SectionProps } from './formParts';

export function SupplierAllocationSection({ form, set, mode, dates }: SectionProps<SupplierFormData>) {
  // Remembers the last order chosen (oldest/newest) while the toggle is off, so switching it back on restores that
  // choice instead of resetting to 'oldest' every time.
  const [lastOrder, setLastOrder] = useState<'oldest' | 'newest'>(
    form.auto_allocate_strategy !== 'off' ? form.auto_allocate_strategy : 'oldest',
  );
  const autoAllocateOn = form.auto_allocate_strategy !== 'off';

  return (
    <Card>
      <SectionTitle>{mode === 'create' ? 'Opening Balance' : 'Payment Allocation'}</SectionTitle>
      {mode === 'create' && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Opening Balance" type="number" min="0" step="0.01" value={form.opening_balance}
            onChange={(v) => set('opening_balance', v)} placeholder="0.00" />
          <DateField label="Opening Balance as At" name="opening_balance_date" value={form.opening_balance_date || null}
            onChange={dates.bind('opening_balance_date', (iso) => set('opening_balance_date', iso), form.opening_balance_date)} />
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={autoAllocateOn}
          onClick={() => set('auto_allocate_strategy', autoAllocateOn ? 'off' : lastOrder)}
          className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            autoAllocateOn ? 'bg-brand-600' : 'bg-[var(--ff-bg-tertiary)]'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${
              autoAllocateOn ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
        <span className="text-sm text-[var(--ff-text-secondary)]">
          {autoAllocateOn
            ? `Auto Allocate Payments to ${form.auto_allocate_strategy === 'newest' ? 'Newest' : 'Oldest'} Invoice`
            : 'Auto Allocate Payments'}
        </span>
        <label className="sr-only" htmlFor="supplier-auto-allocate-order">Auto allocate order</label>
        <select
          id="supplier-auto-allocate-order"
          disabled={!autoAllocateOn}
          // The live strategy while the toggle is ON, so a record loaded after mount shows its own order.
          value={autoAllocateOn ? form.auto_allocate_strategy : lastOrder}
          onChange={(e) => {
            const order = e.target.value as 'oldest' | 'newest';
            setLastOrder(order);
            set('auto_allocate_strategy', order);
          }}
          className={`${selectClass} w-auto disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          <option value="oldest">Oldest invoice first</option>
          <option value="newest">Newest invoice first</option>
        </select>
      </div>
    </Card>
  );
}
