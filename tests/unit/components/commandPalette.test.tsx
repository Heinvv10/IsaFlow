import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const push = vi.fn();
const toggleTheme = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => ({ push, asPath: '/accounting', query: {}, pathname: '/' }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ toggleTheme }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const who = { userId: 'u1', companyId: 'co-A' };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: who.userId ? { id: who.userId } : null }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: who.companyId ? { id: who.companyId } : null }) }));
const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async () => undefined,
  apiErrorMessage: (_e: unknown, fb: string) => fb,
}));

import { CommandPalette } from '@/components/layout/CommandPalette';

const employee = { type: 'employee', id: 'e1', title: 'Thandi Nkosi', subtitle: 'E-001', url: '/payroll/employees/e1', icon: 'user-round' };
const serve = (results: unknown[]) => apiFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { results } }) });
const input = () => screen.getByRole('combobox');

beforeEach(() => { who.userId = 'u1'; who.companyId = 'co-A'; push.mockReset(); toggleTheme.mockReset(); apiFetch.mockReset(); localStorage.clear(); serve([]); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('CommandPalette', () => {
  it('is a modal dialog with a combobox over a listbox, focused on open', () => {
    render(<CommandPalette isOpen onClose={() => undefined} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
  });

  it('aria-activedescendant follows the arrow keys across sections', () => {
    render(<CommandPalette isOpen onClose={() => undefined} />);
    const options = screen.getAllByRole('option');
    expect(input().getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(input().getAttribute('aria-activedescendant')).toBe(options[2]!.id);
    expect(options[2]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(input().getAttribute('aria-activedescendant')).toBe(options[1]!.id);
  });

  it('typing "vat" and Enter opens VAT201, and the row shows its trail', () => {
    render(<CommandPalette isOpen onClose={() => undefined} />);
    fireEvent.change(input(), { target: { value: 'vat' } });
    const first = screen.getAllByRole('option')[0]!;
    expect(first.textContent).toContain('VAT201');
    expect(first.textContent).toContain('Tax');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/vat201/i));
  });

  it('finds an employee through the server and opens their page', async () => {
    serve([employee]);
    render(<CommandPalette isOpen onClose={() => undefined} />);
    fireEvent.change(input(), { target: { value: 'thandi' } });
    const row = await screen.findByText('Thandi Nkosi', undefined, { timeout: 3000 });
    fireEvent.click(row);
    expect(push).toHaveBeenCalledWith('/payroll/employees/e1');
  });

  it('"New invoice" navigates; "Switch theme" toggles without navigating', () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText('New invoice'));
    expect(push).toHaveBeenCalledWith('/accounting/customer-invoices/new');
    fireEvent.click(screen.getByText('Switch theme'));
    expect(toggleTheme).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Keyboard shortcuts runs onShowShortcuts, and the footer "?" hint does the same', () => {
    const onShow = vi.fn();
    render(<CommandPalette isOpen onClose={() => undefined} onShowShortcuts={onShow} />);
    fireEvent.click(screen.getByText('Keyboard shortcuts'));
    fireEvent.click(screen.getByRole('button', { name: /shortcuts/i }));
    expect(onShow).toHaveBeenCalledTimes(2);
  });

  it('Escape closes, and Tab does not leave the dialog', () => {
    const onClose = vi.fn();
    render(<><button>outside</button><CommandPalette isOpen onClose={onClose} /></>);
    const dialog = screen.getByRole('dialog');
    const focusables = dialog.querySelectorAll<HTMLElement>('input, button');
    focusables[focusables.length - 1]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('says "No results" only when nothing at all matched', async () => {
    render(<CommandPalette isOpen onClose={() => undefined} />);
    fireEvent.change(input(), { target: { value: 'qqzzxx' } });
    await waitFor(() => expect(screen.getByText(/No results for/)).toBeTruthy(), { timeout: 3000 });
  });

  describe('recent items', () => {
    const KEY = 'isaflow_recent_items';
    const recentTitles = () => screen.queryAllByRole('option').map((o) => o.textContent ?? '');
    const pick = async (title: string, results: unknown[]) => {
      serve(results);
      const view = render(<CommandPalette isOpen onClose={() => undefined} />);
      fireEvent.change(input(), { target: { value: 'zz' } });
      fireEvent.click(await screen.findByText(title, undefined, { timeout: 3000 }));
      view.unmount();
    };
    const customer = { type: 'customer', id: 'c1', title: 'Acme Ltd', subtitle: '', url: '/accounting/customers?id=c1', icon: 'users' };

    it('company A\'s recents are not visible under company B, or to another user', async () => {
      await pick('Acme Ltd', [customer]);
      render(<CommandPalette isOpen onClose={() => undefined} />);
      expect(recentTitles().some((t) => t.includes('Acme Ltd'))).toBe(true);
      cleanup();
      who.companyId = 'co-B';
      render(<CommandPalette isOpen onClose={() => undefined} />);
      expect(recentTitles().some((t) => t.includes('Acme Ltd'))).toBe(false);
      cleanup();
      who.companyId = 'co-A'; who.userId = 'u2';
      render(<CommandPalette isOpen onClose={() => undefined} />);
      expect(recentTitles().some((t) => t.includes('Acme Ltd'))).toBe(false);
    });

    it('never stores an employee row on the device', async () => {
      await pick('Thandi Nkosi', [employee]);
      const all = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? '').join('');
      expect(all).not.toContain('Thandi');
      expect(all).not.toContain('/payroll/employees/e1');
    });

    it('drops the old global key, and ignores what it held', () => {
      localStorage.setItem(KEY, JSON.stringify([customer]));
      render(<CommandPalette isOpen onClose={() => undefined} />);
      expect(localStorage.getItem(KEY)).toBeNull();
      expect(recentTitles().some((t) => t.includes('Acme Ltd'))).toBe(false);
    });

    it('stored junk does not crash the palette: an object, a string, and rows of the wrong shape', () => {
      const scoped = `${KEY}:u1:co-A`;
      for (const junk of ['{}', '"x"', 'null', '[1,null,{"title":5},{"title":"ok","url":"/a","type":"customer","id":"1","subtitle":"","icon":"users"}]', '{not json']) {
        localStorage.setItem(scoped, junk);
        const view = render(<CommandPalette isOpen onClose={() => undefined} />);
        expect(screen.getByRole('dialog')).toBeTruthy();
        view.unmount();
      }
      localStorage.setItem(scoped, '[1,{"title":5},{"title":"ok","url":"/a","type":"customer","id":"1","subtitle":"","icon":"users"}]');
      render(<CommandPalette isOpen onClose={() => undefined} />);
      expect(recentTitles().some((t) => t.includes('ok'))).toBe(true);
    });
  });

  describe('keyboard', () => {
    const active = () => input().getAttribute('aria-activedescendant');
    it('ArrowDown wraps from the last row to the first, ArrowUp from the first to the last', () => {
      render(<CommandPalette isOpen onClose={() => undefined} />);
      const options = screen.getAllByRole('option');
      fireEvent.keyDown(input(), { key: 'ArrowUp' });
      expect(active()).toBe(options[options.length - 1]!.id);
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
      expect(active()).toBe(options[0]!.id);
    });
    it('Home and End jump to the first and last row while the box is empty', () => {
      render(<CommandPalette isOpen onClose={() => undefined} />);
      const options = screen.getAllByRole('option');
      fireEvent.keyDown(input(), { key: 'End' });
      expect(active()).toBe(options[options.length - 1]!.id);
      fireEvent.keyDown(input(), { key: 'Home' });
      expect(active()).toBe(options[0]!.id);
    });
    it('Home and End stay with the caret once something is typed', () => {
      render(<CommandPalette isOpen onClose={() => undefined} />);
      fireEvent.change(input(), { target: { value: 'new' } });
      const before = active();
      const notPrevented = fireEvent.keyDown(input(), { key: 'End' });
      expect(notPrevented).toBe(true);
      expect(active()).toBe(before);
    });
  });

  describe('server results', () => {
    const deferred = () => {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((r) => { resolve = r; });
      return { promise, resolve };
    };
    const reply = (results: unknown[]) => ({ ok: true, json: async () => ({ success: true, data: { results } }) });
    const acme = { type: 'customer', id: 'a', title: 'Acme Old', subtitle: '', url: '/accounting/customers?id=a', icon: 'users' };
    const beta = { type: 'customer', id: 'b', title: 'Beta New', subtitle: '', url: '/accounting/customers?id=b', icon: 'users' };

    it('a slow reply to an earlier query never replaces the current one', async () => {
      const first = deferred();
      apiFetch.mockImplementation((url: string) => (url.includes('q=ac') ? first.promise : Promise.resolve(reply([beta]))));
      render(<CommandPalette isOpen onClose={() => undefined} />);
      fireEvent.change(input(), { target: { value: 'ac' } });
      await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1), { timeout: 3000 });
      fireEvent.change(input(), { target: { value: 'be' } });
      expect(await screen.findByText('Beta New', undefined, { timeout: 3000 })).toBeTruthy();
      await act(async () => { first.resolve(reply([acme])); await Promise.resolve(); });
      expect(screen.queryByText('Acme Old')).toBeNull();
      expect(screen.getByText('Beta New')).toBeTruthy();
    });

    it('while a new query is in flight, the old query\'s records are hidden and cannot be opened', async () => {
      apiFetch.mockResolvedValueOnce(reply([acme]));
      render(<CommandPalette isOpen onClose={() => undefined} />);
      fireEvent.change(input(), { target: { value: 'ac' } });
      await screen.findByText('Acme Old', undefined, { timeout: 3000 });
      apiFetch.mockReturnValue(new Promise(() => undefined));
      fireEvent.change(input(), { target: { value: 'acm' } });
      expect(screen.queryByText('Acme Old')).toBeNull();
      fireEvent.keyDown(input(), { key: 'Enter' });
      expect(push).not.toHaveBeenCalledWith('/accounting/customers?id=a');
    });

    it('closing the palette cancels the pending search: no request fires after close', () => {
      vi.useFakeTimers();
      const view = render(<CommandPalette isOpen onClose={() => undefined} />);
      fireEvent.change(input(), { target: { value: 'acme' } });
      view.rerender(<CommandPalette isOpen={false} onClose={() => undefined} />);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(apiFetch).not.toHaveBeenCalled();
    });

    it('closing aborts a request already in flight', async () => {
      let signal: AbortSignal | undefined;
      apiFetch.mockImplementation((_u: string, init?: { signal?: AbortSignal }) => { signal = init?.signal; return new Promise(() => undefined); });
      const view = render(<CommandPalette isOpen onClose={() => undefined} />);
      fireEvent.change(input(), { target: { value: 'acme' } });
      await waitFor(() => expect(signal).toBeDefined(), { timeout: 3000 });
      view.rerender(<CommandPalette isOpen={false} onClose={() => undefined} />);
      expect(signal!.aborted).toBe(true);
    });

    it('the highlight stays on the row you arrowed to when a reply lands', async () => {
      const d = deferred();
      apiFetch.mockReturnValue(d.promise);
      render(<CommandPalette isOpen onClose={() => undefined} />);
      fireEvent.change(input(), { target: { value: 'ac' } });
      await waitFor(() => expect(apiFetch).toHaveBeenCalled(), { timeout: 3000 });
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
      const before = input().getAttribute('aria-activedescendant');
      expect(before).toBeTruthy();
      await act(async () => { d.resolve(reply([acme])); await Promise.resolve(); });
      await screen.findByText('Acme Old');
      expect(input().getAttribute('aria-activedescendant')).toBe(before);
      expect(before).not.toBe(screen.getAllByRole('option')[0]!.id);
    });
  });

  it('Escape returns focus to the control that opened it', () => {
    const view = render(<><button>trigger</button><CommandPalette isOpen={false} onClose={() => undefined} /></>);
    const trigger = screen.getByText('trigger');
    trigger.focus();
    view.rerender(<><button>trigger</button><CommandPalette isOpen onClose={() => undefined} /></>);
    expect(document.activeElement).toBe(input());
    view.rerender(<><button>trigger</button><CommandPalette isOpen={false} onClose={() => undefined} /></>);
    expect(document.activeElement).toBe(trigger);
  });
});
