/**
 * useBankTxSelection: the selection is derived synchronously. The FIRST render with active accounts already has the
 * default selected and no "no active accounts" notice (renderToString has no effects, so it sees the first frame); a
 * deep link is handled once on the first load (found or not); a chosen account that disappears falls back with a notice.
 */
import { useState } from 'react';
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

  it('the default is pinned on the first load: a later change of the first active account does not move the user silently', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, undefined), { initialProps: { accounts: [B(), C()] } });
    expect(h.result.current.selected).toBe('b');
    h.rerender({ accounts: [summaryAcct('z', { accountName: 'New first' }), B(), C()] });
    expect(h.result.current).toMatchObject({ selected: 'b', notice: '' });
    h.rerender({ accounts: [C()] }); // losing the pinned default says so
    expect(h.result.current).toMatchObject({ selected: 'c', notice: 'Main is no longer listed; showing Savings.' });
  });
});

describe('after the pinned account vanishes', () => {
  it('the fallback is pinned: a later change of the first active account does not move the user', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, undefined), { initialProps: { accounts: [B(), C()] } });
    h.rerender({ accounts: [C()] });
    expect(h.result.current.selected).toBe('c');
    h.rerender({ accounts: [summaryAcct('z', { accountName: 'New first' }), C()] });
    expect(h.result.current.selected).toBe('c');
  });
});

describe('late-hydrating deep link', () => {
  it('accounts load first, the link becomes readable afterwards: it is applied', () => {
    const h = renderHook(({ accounts, link, ready }) => useBankTxSelection(accounts, link, ready),
      { initialProps: { accounts: [B(), C()], link: undefined as string | undefined, ready: false } });
    expect(h.result.current.selected).toBe('b');
    h.rerender({ accounts: [B(), C()], link: 'c', ready: true });
    expect(h.result.current).toMatchObject({ selected: 'c', notice: '' });
  });
  it('once ready with no link, a later link is not applied', () => {
    const accounts = [B(), C()];
    const h = renderHook(({ link }) => useBankTxSelection(accounts, link, true), { initialProps: { link: undefined as string | undefined } });
    h.rerender({ link: 'c' });
    expect(h.result.current.selected).toBe('b');
  });
});

describe('stale notices clear', () => {
  it('"isn\'t available" clears when that account appears in the summary', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, 'c'), { initialProps: { accounts: [B()] } });
    expect(h.result.current.notice).toBe("That account isn't available; showing Main.");
    h.rerender({ accounts: [B(), C()] });
    expect(h.result.current).toMatchObject({ selected: 'b', notice: '' });
  });
  it('"no longer listed" clears when the account returns', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, undefined), { initialProps: { accounts: [A(), B()] } });
    act(() => h.result.current.setSelected('a'));
    h.rerender({ accounts: [B()] });
    expect(h.result.current.notice).toBe('Old card is no longer listed; showing Main.');
    h.rerender({ accounts: [A(), B()] });
    expect(h.result.current.notice).toBe('');
  });
});

describe('multi-valued link', () => {
  it('is invalid: the default is shown with the "isn\'t available" notice', () => {
    const h = renderHook(() => useBankTxSelection(useStable([B(), C()]), ['b', 'c']));
    expect(h.result.current).toMatchObject({ selected: 'b', notice: "That account isn't available; showing Main." });
  });
});
function useStable<T>(v: T): T { return useState(v)[0]; }

describe('a link to an inactive account', () => {
  const inactive = () => ({ ...B(), id: 'x', accountName: 'Closed', isActive: false });
  it('is not opened: the default is shown with the "isn\'t available" notice, and the notice survives an accounts refresh', () => {
    const h = renderHook(({ accounts }) => useBankTxSelection(accounts, 'x'), { initialProps: { accounts: [A(), B(), inactive()] } });
    expect(h.result.current.selected).not.toBe('x');
    expect(h.result.current.notice).toMatch(/isn't available/);
    h.rerender({ accounts: [A(), B(), inactive()] });
    expect(h.result.current.notice).toMatch(/isn't available/);
  });
});
