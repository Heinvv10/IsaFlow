/**
 * Request validation of the 13-week cash forecast's stored inputs: mirrors migration 999i's CHECKs so a
 * bad value is a 400, and refuses dates Postgres would choke on (30 February).
 */
import { describe, expect, it } from 'vitest';
import { ItemInput, ItemUpdate, OverrideInput, PayDayInput, isMonday } from '@/modules/accounting/services/cashForecast13/storeSchemas';

const item = { direction: 'receipt', amount: 1500.5, date: '2026-12-01', description: 'Deposit' };
const ovr = { lineKey: 'payroll:net', weekStart: '2026-11-16', mode: 'set', amount: 0 };
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe('ItemInput', () => {
  it('accepts a one-off item and defaults repeat to none, repeatUntil and accountId to null', () => {
    const r = ItemInput.parse(item);
    expect(r).toMatchObject({ repeat: 'none', repeatUntil: null, accountId: null, description: 'Deposit', category: 'other' });
  });
  it('trims the description', () => { expect(ItemInput.parse({ ...item, description: '  Rent  ' }).description).toBe('Rent'); });
  it.each([
    ['amount 0', { amount: 0 }], ['negative amount', { amount: -1 }], ['three decimals', { amount: 1.005 }],
    ['amount past numeric(15,2)', { amount: 1e13 }], ['NaN', { amount: Number.NaN }], ['amount as text', { amount: '5' }],
    ['unknown direction', { direction: 'transfer' }], ['unknown repeat', { repeat: 'daily' }],
    ['30 February', { date: '2026-02-30' }], ['not a date', { date: '01/12/2026' }],
    ['blank description', { description: '   ' }], ['description of 201', { description: 'x'.repeat(201) }],
    ['repeatUntil on a one-off', { repeatUntil: '2027-01-01' }],
    ['repeatUntil before the date', { repeat: 'weekly', repeatUntil: '2026-11-30' }],
    ['repeatUntil not a real date', { repeat: 'weekly', repeatUntil: '2026-13-01' }],
    ['accountId not a uuid', { accountId: 'abc' }], ['unknown category', { category: 'tax' }],
  ])('refuses %s', (_n, patch) => { expect(ok(ItemInput, { ...item, ...patch })).toBe(false); });
  it.each([
    ['0.01', { amount: 0.01 }], ['two decimals', { amount: 0.29 }], ['200 characters', { description: 'x'.repeat(200) }],
    ['repeatUntil on the date', { repeat: 'monthly', repeatUntil: '2026-12-01' }], ['open-ended weekly', { repeat: 'weekly' }],
    ['a payment with an account', { direction: 'payment', accountId: '00000000-0000-0000-0000-000000000001' }],
    ['category loans', { category: 'loans' }],
  ])('accepts %s', (_n, patch) => { expect(ok(ItemInput, { ...item, ...patch })).toBe(true); });
  it('ItemUpdate needs an id', () => {
    expect(ok(ItemUpdate, item)).toBe(false);
    expect(ItemUpdate.parse({ ...item, id: '00000000-0000-0000-0000-0000000000aa' }).id).toBe('00000000-0000-0000-0000-0000000000aa');
  });
});

describe('OverrideInput', () => {
  it('isMonday', () => {
    expect(isMonday('2026-11-16')).toBe(true);
    expect(isMonday('2026-11-17')).toBe(false);
    expect(isMonday('2026-11-22')).toBe(false);
  });
  it.each([
    ['a Tuesday week', { weekStart: '2026-11-17' }], ['a Sunday week', { weekStart: '2026-11-22' }], ['31 November', { weekStart: '2026-11-31' }],
    ['set without an amount', { amount: null }], ['add without an amount', { mode: 'add', amount: undefined }], ['add of 0', { mode: 'add', amount: 0 }],
    ['move_to of 0', { mode: 'move_to', amount: 0, targetWeekStart: '2026-11-23' }],
    ['move_to negative', { mode: 'move_to', amount: -5, targetWeekStart: '2026-11-23' }],
    ['move_to without target', { mode: 'move_to', amount: 5 }],
    ['move_to to a Tuesday', { mode: 'move_to', amount: 5, targetWeekStart: '2026-11-24' }],
    ['move_to to its own week', { mode: 'move_to', amount: 5, targetWeekStart: '2026-11-16' }],
    ['set with a target', { amount: 5, targetWeekStart: '2026-11-23' }],
    ['add with a target', { mode: 'add', amount: 5, targetWeekStart: '2026-11-23' }],
    ['unknown mode', { mode: 'scale', amount: 1 }], ['blank line key', { lineKey: '  ' }], ['line key of 201', { lineKey: 'k'.repeat(201) }],
    ['note of 501', { note: 'n'.repeat(501) }], ['three decimals', { amount: 0.001 }],
  ])('refuses %s', (_n, patch) => { expect(ok(OverrideInput, { ...ovr, ...patch })).toBe(false); });
  it.each([
    ['set 0', {}], ['set negative (a payment line)', { amount: -80000 }], ['add negative', { mode: 'add', amount: -250.5 }],
    ['move_to with no amount (the whole cell)', { mode: 'move_to', amount: null, targetWeekStart: '2026-11-23' }],
    ['move_to a later Monday', { mode: 'move_to', amount: 100, targetWeekStart: '2026-11-23' }],
    ['move_to an earlier Monday', { weekStart: '2026-11-23', mode: 'move_to', amount: 100, targetWeekStart: '2026-11-16' }],
    ['line key of 200', { lineKey: 'k'.repeat(200) }],
  ])('accepts %s', (_n, patch) => { expect(ok(OverrideInput, { ...ovr, ...patch })).toBe(true); });
  it('a blank note becomes null; a null target stays null', () => {
    expect(OverrideInput.parse({ ...ovr, note: '   ' })).toMatchObject({ note: null, targetWeekStart: null });
  });
});

describe('PayDayInput', () => {
  it.each([[1], [25], [31]])('accepts day %i', (d) => { expect(ok(PayDayInput, { kind: 'day_of_month', day: d })).toBe(true); });
  it.each([[0], [32], [2.5]])('refuses day %s', (d) => { expect(ok(PayDayInput, { kind: 'day_of_month', day: d })).toBe(false); });
  it('accepts last_working_day; refuses an unknown kind and a missing day', () => {
    expect(ok(PayDayInput, { kind: 'last_working_day' })).toBe(true);
    expect(ok(PayDayInput, { kind: 'first_friday' })).toBe(false);
    expect(ok(PayDayInput, { kind: 'day_of_month' })).toBe(false);
  });
});
