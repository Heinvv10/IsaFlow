/**
 * useBankTxSelection: the selection is derived synchronously. The FIRST render with active accounts already has the
 * default selected and no "no active accounts" notice (renderToString has no effects, so it sees the first frame); a
 * deep link is handled once on the first load (found or not); a chosen account that disappears falls back with a notice.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { useBankTxSelection } from '@/components/accounting/bank-transactions/useBankTxSelection';
import type { BankAccountSummary } from '@/modules/accounting/services/bank/bankAccountSummaryService';
import { summaryAcct } from '../helpers/bankSummaryFixture';

afterEach(cleanup);
const A = () => summaryAcct('a', { isActive: false, accountName: 'Old card' });
const B = () => summaryAcct('b', { accountName: 'Main' });
const C = () => summaryAcct('c', { accountName: 'Savings' });

function Probe({ accounts, link }: { accounts: BankAccountSummary[]; link?: string }) {
  const s = useBankTxSelection(accounts, link);
  return <p>{JSON.stringify({ selected: s.selected, noneActive: s.noneActive, notice: s.notice })}</p>;
}
const firstFrame = (accounts: BankAccountSummary[], link?: string) =>
  JSON.parse(renderToString(<Probe accounts={accounts} link={link} />).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")) as { selected: string; noneActive: boolean; notice: string };

describe('first frame', () => {
  it('with an active account: it is selected and there is no "no active accounts" state', () => {
    expect(firstFrame([A(), B()])).toEqual({ selected: 'b', noneActive: false, notice: '' });
  });
  it('with only inactive accounts: nothing selected, and noneActive', () => {
    expect(firstFrame([A()])).toEqual({ selected: '', noneActive: true, notice: '' });
  });
  it('before the accounts load: nothing selected and NOT noneActive', () => {
    expect(firstFrame([])).toEqual({ selected: '', noneActive: false, notice: '' });
  });
  it('a deep link that is among the accounts is selected on the first frame', () => {
    expect(firstFrame([B(), C()], 'c')).toMatchObject({ selected: 'c', notice: '' });
  });
});

describe('deep link, handled once', () => {
  it('a missing one says so on the first load, then a later refresh that lists it does NOT move the user to it', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, 'c'), { initialProps: { accounts: [B()] } });
    expect(h.result.current.selected).toBe('b');
    expect(h.result.current.notice).toBe("That account isn't available; showing Main.");
    h.rerender({ accounts: [B(), C()] });
    expect(h.result.current.selected).toBe('b');
  });

  it('a found one is applied once: after the user picks another, a refresh keeps their pick', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, 'c'), { initialProps: { accounts: [B(), C()] } });
    expect(h.result.current.selected).toBe('c');
    act(() => h.result.current.setSelected('b'));
    h.rerender({ accounts: [B(), C(), summaryAcct('d')] });
    expect(h.result.current.selected).toBe('b');
  });
});

describe('a chosen account that disappears', () => {
  it('falls back to the default and says which went and what is shown', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, undefined), { initialProps: { accounts: [A(), B()] } });
    act(() => h.result.current.setSelected('a'));
    expect(h.result.current.selected).toBe('a');
    h.rerender({ accounts: [B()] });
    expect(h.result.current.selected).toBe('b');
    expect(h.result.current.notice).toBe('Old card is no longer listed; showing Main.');
  });

  it('the notice is dismissible, and choosing an account retires it', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, undefined), { initialProps: { accounts: [A(), B()] } });
    act(() => h.result.current.setSelected('a'));
    h.rerender({ accounts: [B()] });
    act(() => h.result.current.dismissNotice());
    expect(h.result.current.notice).toBe('');
    h.rerender({ accounts: [B(), C()] });
    act(() => h.result.current.setSelected('c'));
    expect(h.result.current.notice).toBe('');
  });

  it('a default selection that changes with the list is not a "vanished" account (nothing was chosen)', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, undefined), { initialProps: { accounts: [B(), C()] } });
    h.rerender({ accounts: [C()] });
    expect(h.result.current).toMatchObject({ selected: 'c', notice: '' });
  });
});
