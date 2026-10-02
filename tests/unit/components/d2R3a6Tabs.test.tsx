/**
 * D2 round 3 (a6): the customer/supplier Contacts, Activity and DeliveryAddresses tabs fired POST/DELETE
 * without reading the response. A refusal vanished (or, in the old catch, read as a generic failure), and a
 * failed reload left the previous rows on screen. One table, run against every tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { ContactsTab as CustomerContacts } from '../../../src/components/accounting/customers/ContactsTab';
import { ActivityTab as CustomerActivity } from '../../../src/components/accounting/customers/ActivityTab';
import { DeliveryAddressesTab } from '../../../src/components/accounting/customers/DeliveryAddressesTab';
import { ContactsTab as SupplierContacts } from '../../../src/components/accounting/suppliers/ContactsTab';
import { ActivityTab as SupplierActivity } from '../../../src/components/accounting/suppliers/ActivityTab';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const COMMON = { created_at: '2026-01-01T00:00:00Z', created_by: 'u', created_by_email: 'a@x.test', created_by_first_name: 'A',
  created_by_last_name: 'B', activity_type: 'note', subject: null, is_primary: false, is_default: false };
interface Tab {
  name: string; el: () => JSX.Element; path: string; row: Record<string, unknown>; rowText: string;
  add: string; field: string; save: string; del: string; noun: string; loadNoun: string;
}
const TABS: Tab[] = [
  { name: 'customer contacts', el: () => <CustomerContacts customerId="c1" />, path: '/api/accounting/customer-contacts',
    row: { ...COMMON, id: 'r1', full_name: 'D2 Contact Row' }, rowText: 'D2 Contact Row', add: 'Add Contact',
    field: 'Full Name *', save: 'Save Contact', del: 'Delete contact', noun: 'the contact', loadNoun: 'contacts' },
  { name: 'supplier contacts', el: () => <SupplierContacts supplierId="s1" />, path: '/api/accounting/supplier-contacts',
    row: { ...COMMON, id: 'r1', full_name: 'D2 Contact Row' }, rowText: 'D2 Contact Row', add: 'Add Contact',
    field: 'Full Name *', save: 'Save Contact', del: 'Delete contact', noun: 'the contact', loadNoun: 'contacts' },
  { name: 'customer activity', el: () => <CustomerActivity customerId="c1" />, path: '/api/accounting/customer-activities',
    row: { ...COMMON, id: 'r1', customer_id: 'c1', description: 'D2 Activity Row' }, rowText: 'D2 Activity Row', add: 'Add Activity',
    field: 'Description *', save: 'Save Activity', del: 'Delete activity', noun: 'the activity', loadNoun: 'activities' },
  { name: 'supplier activity', el: () => <SupplierActivity supplierId="s1" />, path: '/api/accounting/supplier-activities',
    row: { ...COMMON, id: 'r1', supplier_id: 's1', description: 'D2 Activity Row' }, rowText: 'D2 Activity Row', add: 'Add Activity',
    field: 'Description *', save: 'Save Activity', del: 'Delete activity', noun: 'the activity', loadNoun: 'activities' },
  { name: 'delivery addresses', el: () => <DeliveryAddressesTab customerId="c1" />, path: '/api/accounting/customer-delivery-addresses',
    row: { ...COMMON, id: 'r1', address_name: 'D2 Depot Row', address_line1: null, address_line2: null, city: null, province: null,
      postal_code: null, country: null }, rowText: 'D2 Depot Row', add: 'Add Address',
    field: 'Address Name *', save: 'Save Address', del: 'Delete address', noun: 'the address', loadNoun: 'delivery addresses' },
];

describe.each(TABS)('$name', (t) => {
  const list = on('GET', t.path, () => ok([t.row]));
  const open = async () => {
    render(t.el());
    await screen.findByText(t.rowText);
    fireEvent.click(screen.getByText(t.add));
    const input = screen.getByPlaceholderText(t.field) as HTMLInputElement | HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'D2 typed value' } });
    return input;
  };

  it('add: a refusal shows the server message, keeps the form and the typed value, and is not stuck saving', async () => {
    serve(on('POST', t.path, () => refuse()), list);
    const input = await open();
    fireEvent.click(screen.getByText(t.save));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(input.value).toBe('D2 typed value');
    expect(screen.getByText(t.save)).toBeDefined();
  });

  it('add: an empty-body 500 gives a plain sentence', async () => {
    serve(on('POST', t.path, empty500), list);
    await open();
    fireEvent.click(screen.getByText(t.save));
    expect(await screen.findByText(`Could not save ${t.noun} - try again`)).toBeDefined();
    expectNoJargon();
  });

  it('add: a good write closes the form', async () => {
    serve(on('POST', t.path, () => ok({})), list);
    await open();
    fireEvent.click(screen.getByText(t.save));
    await waitFor(() => expect(screen.queryByPlaceholderText(t.field)).toBeNull());
  });

  it('add: written (200) then the reload fails -> form closed, reload error shown, old rows gone, nothing stuck', async () => {
    let posted = false;
    serve(on('POST', t.path, () => { posted = true; return ok({}); }),
      (url, m) => (posted && m === 'GET' && url.includes(t.path) ? refuse() : undefined), list);
    await open();
    fireEvent.click(screen.getByText(t.save));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText(t.rowText)).toBeNull();
  });

  it('delete: a refusal shows the server message and the row stays', async () => {
    serve(on('DELETE', t.path, () => refuse()), list);
    render(t.el());
    await screen.findByText(t.rowText);
    fireEvent.click(screen.getByTitle(t.del));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText(t.rowText)).toBeDefined();
  });

  it('delete: an empty-body 500 gives a plain sentence', async () => {
    serve(on('DELETE', t.path, empty500), list);
    render(t.el());
    await screen.findByText(t.rowText);
    fireEvent.click(screen.getByTitle(t.del));
    expect(await screen.findByText(`Could not delete ${t.noun} - try again`)).toBeDefined();
    expectNoJargon();
  });

  it('load: a refusal shows the server message and no rows; an empty-body 500 a plain sentence', async () => {
    serve(on('GET', t.path, () => refuse()));
    render(t.el());
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText(t.rowText)).toBeNull();
    cleanup();
    serve(on('GET', t.path, empty500));
    render(t.el());
    expect(await screen.findByText(new RegExp(`Could not load (the )?${t.loadNoun} - try again`))).toBeDefined();
    expectNoJargon();
  });

  it('load: a good 200 renders the rows', async () => {
    serve(list);
    render(t.el());
    expect(await screen.findByText(t.rowText)).toBeDefined();
  });
});
