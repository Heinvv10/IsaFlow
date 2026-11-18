/**
 * The header's "Create new" menu from the keyboard: N opens it, then a letter goes to that item's page. While focus is
 * in a text field neither key does anything (N and the letters are ordinary typing there).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ push: vi.fn(async () => true) }));
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {}, push: h.push }) }));

import { CreateNewMenu } from '@/components/layout/CreateNewMenu';

beforeEach(() => { h.push.mockClear(); });
afterEach(cleanup);

const KEYS: Array<[string, string, string]> = [
  ['I', 'New Invoice', '/accounting/customer-invoices/new'],
  ['B', 'New Bill', '/accounting/supplier-invoices/new'],
  ['O', 'New Purchase Order', '/accounting/purchase-orders/new'],
  ['C', 'New Customer', '/accounting/customers/new'],
  ['S', 'New Supplier', '/accounting/suppliers/new'],
  ['P', 'Record Payment', '/accounting/customer-payments/new'],
  ['J', 'New Journal Entry', '/accounting/journal-entries/new'],
];

describe('Create new menu keys', () => {
  it('N opens the menu with the seven items, in order, each showing its key', () => {
    render(<CreateNewMenu />);
    expect(screen.queryByRole('menu', { name: 'Create new' })).toBeNull();
    fireEvent.keyDown(document, { key: 'n' });
    const items = within(screen.getByRole('menu', { name: 'Create new' })).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(KEYS.map(([k, label]) => `${label}N ${k}`));
  });

  it.each(KEYS)('N then %s goes to %s', (key, _label, route) => {
    render(<CreateNewMenu />);
    fireEvent.keyDown(document, { key: 'n' });
    fireEvent.keyDown(document, { key: key.toLowerCase() });
    expect(h.push).toHaveBeenCalledExactlyOnceWith(route);
    expect(screen.queryByRole('menu', { name: 'Create new' })).toBeNull();
  });

  it('a removed letter (Q, T) does nothing', () => {
    render(<CreateNewMenu />);
    fireEvent.keyDown(document, { key: 'n' });
    fireEvent.keyDown(document, { key: 'q' });
    fireEvent.keyDown(document, { key: 't' });
    expect(h.push).not.toHaveBeenCalled();
    expect(screen.getByRole('menu', { name: 'Create new' })).toBeTruthy();
  });

  it.each(['input', 'textarea'])('typing N and O in a focused %s neither opens the menu nor navigates', (tag) => {
    render(<><CreateNewMenu />{tag === 'input' ? <input aria-label="field" /> : <textarea aria-label="field" />}</>);
    const field = screen.getByLabelText('field');
    field.focus();
    fireEvent.keyDown(field, { key: 'n' });
    fireEvent.keyDown(field, { key: 'o' });
    expect(screen.queryByRole('menu', { name: 'Create new' })).toBeNull();
    expect(h.push).not.toHaveBeenCalled();
  });

  it('with the menu open, a letter typed in a field does not navigate', () => {
    render(<><CreateNewMenu /><input aria-label="field" /></>);
    fireEvent.keyDown(document, { key: 'n' });
    const field = screen.getByLabelText('field');
    fireEvent.keyDown(field, { key: 's' });
    expect(h.push).not.toHaveBeenCalled();
  });
});
