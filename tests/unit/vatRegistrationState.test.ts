/**
 * The two decisions that keep `vat_period` and `vat_system_type` in step, and
 * the loading-window behaviour that decides what a page shows before the
 * company record has arrived.
 */
import { describe, it, expect } from 'vitest';
import { vatSystemSelectionUpdates } from '@/components/accounting/settings/vatSystemSelection';
import { resolveVatRegistration } from '@/hooks/vatRegistrationState';

describe('vatSystemSelectionUpdates', () => {
  it('opting out writes BOTH columns, so no reader sees "registered"', () => {
    expect(vatSystemSelectionUpdates('none', 'bi-monthly')).toEqual([
      { field: 'vatSystemType', value: 'none' },
      { field: 'vatPeriod', value: 'none' },
    ]);
  });

  it('opting back in lifts the cadence off none', () => {
    expect(vatSystemSelectionUpdates('invoice', 'none')).toEqual([
      { field: 'vatSystemType', value: 'invoice' },
      { field: 'vatPeriod', value: 'bi-monthly' },
    ]);
  });

  it('switching basis on an already-registered company leaves the cadence alone', () => {
    expect(vatSystemSelectionUpdates('payment', 'monthly')).toEqual([
      { field: 'vatSystemType', value: 'payment' },
    ]);
  });

  it('never leaves a company registered on one column and not the other', () => {
    for (const next of ['invoice', 'payment', 'none']) {
      for (const period of ['monthly', 'bi-monthly', 'none', null, undefined]) {
        const u = vatSystemSelectionUpdates(next, period);
        const system = u.find((x) => x.field === 'vatSystemType')!.value;
        const resulting = u.find((x) => x.field === 'vatPeriod')?.value ?? period;
        const systemSaysNone = system === 'none';
        const periodSaysNone = String(resulting ?? '').toLowerCase() === 'none';
        expect(systemSaysNone).toBe(periodSaysNone);
      }
    }
  });
});

describe('resolveVatRegistration', () => {
  it('is unknown while the context is still loading with no columns yet', () => {
    const r = resolveVatRegistration(undefined, undefined, true);
    expect(r.known).toBe(false);
    // Fails towards registered so a real vendor never loses VAT mid-load.
    expect(r.isRegistered).toBe(true);
  });

  it('becomes known once loading finishes even if the company has no VAT columns', () => {
    const r = resolveVatRegistration(undefined, undefined, false);
    expect(r.known).toBe(true);
    expect(r.isRegistered).toBe(true);
    expect(r.setting).toBe('bi-monthly');
  });

  it('is known and negative as soon as either column says none', () => {
    expect(resolveVatRegistration('none', undefined, true)).toEqual({
      setting: 'none', isRegistered: false, known: true,
    });
    expect(resolveVatRegistration('bi-monthly', 'none', true)).toEqual({
      setting: 'none', isRegistered: false, known: true,
    });
  });

  it('carries the cadence through for a registered vendor', () => {
    expect(resolveVatRegistration('monthly', 'invoice', false)).toEqual({
      setting: 'monthly', isRegistered: true, known: true,
    });
  });
});
