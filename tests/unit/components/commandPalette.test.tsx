import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const push = vi.fn();
const toggleTheme = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => ({ push, asPath: '/accounting', query: {}, pathname: '/' }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ toggleTheme }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
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

beforeEach(() => { push.mockReset(); toggleTheme.mockReset(); apiFetch.mockReset(); localStorage.clear(); serve([]); });
afterEach(() => cleanup());

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
    expect(JSON.parse(localStorage.getItem('isaflow_recent_items') ?? '[]')[0].url).toBe('/payroll/employees/e1');
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
});
