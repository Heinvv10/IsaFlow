/**
 * D2 round 3 (a6): webhooks, user-access, PermissionsGrid and UdfTab used to fire writes without checking the
 * response (a refusal vanished or read as success) and, for user-access/PermissionsGrid, to parse the body
 * before the status. Real apiFetch helpers run over a scripted spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve, writeCalls, type Route } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/contexts/CompanyContext', () => {
  const value = { activeCompany: { id: 'co-1' } }; // stable identity: the page's load callback depends on it
  return { useCompany: () => value };
});
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-me' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import WebhooksPage from '../../../pages/accounting/webhooks';
import UserAccessPage from '../../../pages/accounting/user-access';
import { PermissionsGrid } from '../../../src/components/accounting/user-access/PermissionsGrid';
import { UdfTab } from '../../../src/components/accounting/settings/UdfTab';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.stubGlobal('confirm', () => true); });
afterEach(() => { cleanup(); });

const PLAIN_LOAD = /Could not load the company users - try again/;

describe('webhooks page', () => {
  const WH = { id: 'w1', companyId: 'c', name: 'D2 Hook', url: 'https://x.test/p', secret: null, events: ['invoice.created'],
    isActive: true, lastTriggeredAt: null, failureCount: 0, createdAt: '2026-01-01' };
  const list = (): Route => (url, method) =>
    method === 'GET' && url.includes('/api/accounting/webhooks') ? ok([WH]) : undefined;

  const openEdit = async () => { fireEvent.click(await screen.findByText('Edit')); await screen.findByText('Save'); };
  const trash = () => document.querySelector('button.text-red-400') as HTMLButtonElement;

  it('a refused save shows the server message, keeps the form open and does not reload', async () => {
    serve(list(), on('PUT', '/api/accounting/webhooks', () => refuse()));
    render(<WebhooksPage />);
    await openEdit();
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('Save')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeNull());
  });

  it('an empty-body 500 on save gives a plain sentence', async () => {
    serve(list(), on('PUT', '/api/accounting/webhooks', empty500));
    render(<WebhooksPage />);
    await openEdit();
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Could not save the webhook - try again')).toBeDefined();
    expectNoJargon();
  });

  it('a refused delete shows the message and the webhook stays listed', async () => {
    serve(list(), on('DELETE', '/api/accounting/webhooks', () => refuse()));
    render(<WebhooksPage />);
    await screen.findByText('D2 Hook');
    fireEvent.click(trash());
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('D2 Hook')).toBeDefined();
  });

  it('an empty-body 500 on delete gives a plain sentence', async () => {
    serve(list(), on('DELETE', '/api/accounting/webhooks', empty500));
    render(<WebhooksPage />);
    await screen.findByText('D2 Hook');
    fireEvent.click(trash());
    expect(await screen.findByText('Could not delete the webhook - try again')).toBeDefined();
    expectNoJargon();
  });

  it('a good delete reloads the list', async () => {
    serve(list(), on('DELETE', '/api/accounting/webhooks', () => ok({})));
    render(<WebhooksPage />);
    await screen.findByText('D2 Hook');
    fireEvent.click(trash());
    await waitFor(() => expect(writeCalls('GET', '/api/accounting/webhooks')).toBe(2));
  });
});

describe('user access page', () => {
  const USERS = [
    { userId: 'u-me', name: 'D2 Owner', email: 'o@x.test', role: 'owner', joinedAt: '2026-01-01T00:00:00Z' },
    { userId: 'u-2', name: 'D2 Bob', email: 'b@x.test', role: 'viewer', joinedAt: '2026-01-01T00:00:00Z' },
  ];
  const INV = { id: 'i1', email: 'pending@x.test', role: 'viewer', expiresAt: '2027-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
    emailSentAt: null, emailError: null };
  const base = (invs: unknown[] = []) => [
    on('GET', '/api/accounting/company-users', () => ok(USERS)),
    on('GET', '/api/accounting/company-invitations', () => ok(invs)),
  ];

  it('load: a refusal shows the server message and no users', async () => {
    serve(on('GET', '/api/accounting/company-users', () => refuse()));
    render(<UserAccessPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('D2 Bob')).toBeNull();
  });

  it('load: an empty-body 500 gives a plain sentence', async () => {
    serve(on('GET', '/api/accounting/company-users', empty500));
    render(<UserAccessPage />);
    expect(await screen.findByText(PLAIN_LOAD)).toBeDefined();
    expectNoJargon();
  });

  it('load: a failing invitations list shows its own plain sentence but keeps the users', async () => {
    serve(on('GET', '/api/accounting/company-invitations', empty500), ...base());
    render(<UserAccessPage />);
    expect(await screen.findByText('Could not load the pending invitations - try again')).toBeDefined();
    expect(screen.getByText('D2 Bob')).toBeDefined();
  });

  it('load: a 403 on invitations (non-admin) is not an error', async () => {
    serve(on('GET', '/api/accounting/company-invitations', () => refuse('forbidden', 403)), ...base());
    render(<UserAccessPage />);
    await screen.findByText('D2 Bob');
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  it('role change: a refusal shows the message and no "Role updated."', async () => {
    serve(on('PUT', '/api/accounting/company-users', () => refuse()), ...base());
    render(<UserAccessPage />);
    await screen.findByText('D2 Bob');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'manager' } });
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('Role updated.')).toBeNull();
  });

  it('role change: an empty-body 500 gives a plain sentence; a good change says so', async () => {
    serve(on('PUT', '/api/accounting/company-users', empty500), ...base());
    render(<UserAccessPage />);
    await screen.findByText('D2 Bob');
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'manager' } });
    expect(await screen.findByText('Could not update the role - try again')).toBeDefined();
    expectNoJargon();
    serve(on('PUT', '/api/accounting/company-users', () => ok(USERS)), ...base());
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'admin' } });
    expect(await screen.findByText('Role updated.')).toBeDefined();
  });

  it('remove: a refusal shows the message, the user stays, no "User removed."', async () => {
    serve(on('DELETE', '/api/accounting/company-users', () => refuse()), ...base());
    render(<UserAccessPage />);
    await screen.findByText('D2 Bob');
    fireEvent.click(document.querySelector('button[class*="hover:text-red-400"]') as HTMLButtonElement);
    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('D2 Bob')).toBeDefined();
    expect(screen.queryByText('User removed.')).toBeNull();
  });

  it('invite: a refusal shows the message, keeps the typed email and is not stuck sending', async () => {
    serve(on('POST', '/api/accounting/company-invitations', () => refuse()), ...base());
    render(<UserAccessPage />);
    await screen.findByText('D2 Bob');
    const email = screen.getByPlaceholderText('colleague@example.com') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'new@x.test' } });
    fireEvent.click(screen.getByText('Invite'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(email.value).toBe('new@x.test');
    expect(screen.queryByText(/Invitation sent/)).toBeNull();
    await waitFor(() => expect(screen.queryByText('Sending...')).toBeNull());
  });

  it('invite: written (200) then the invitations reload fails -> success kept, error shown, not stuck', async () => {
    let posted = false;
    serve(on('POST', '/api/accounting/company-invitations', () => { posted = true; return ok({ autoAdded: false }); }),
      (url, m) => (posted && m === 'GET' && url.includes('company-invitations') ? empty500() : undefined), ...base());
    render(<UserAccessPage />);
    await screen.findByText('D2 Bob');
    fireEvent.change(screen.getByPlaceholderText('colleague@example.com'), { target: { value: 'new@x.test' } });
    fireEvent.click(screen.getByText('Invite'));
    expect(await screen.findByText('Invitation sent to new@x.test.')).toBeDefined();
    expect(await screen.findByText(/invitation was sent, but the list could not be refreshed|Could not load the pending invitations/)).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Sending...')).toBeNull());
  });

  it('cancel invitation: a refusal shows the message and the invitation stays', async () => {
    serve(on('DELETE', '/api/accounting/company-invitations', () => refuse()), ...base([INV]));
    render(<UserAccessPage />);
    await screen.findByText('pending@x.test');
    fireEvent.click(screen.getByText('Cancel'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('pending@x.test')).toBeDefined();
    expect(screen.queryByText('Invitation cancelled.')).toBeNull();
  });
});

describe('PermissionsGrid', () => {
  const PERM = { moduleKey: 'sales', moduleName: 'D2 Sales Module', canRead: true, canWrite: false, canDelete: false,
    canExport: false, canApprove: false, accountRangeFrom: null, accountRangeTo: null };
  const GET = on('GET', '/api/accounting/permissions', () => ok({ permissions: [PERM] }));
  const grid = (onFeedback = vi.fn()) => { render(<PermissionsGrid userId="u-2" userRole="viewer" onFeedback={onFeedback} />); return onFeedback; };

  it('load: a refusal shows the server message and no editable grid', async () => {
    serve(on('GET', '/api/accounting/permissions', () => refuse()));
    grid();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('Reset to Defaults')).toBeNull();
  });

  it('load: an empty-body 500 gives a plain sentence', async () => {
    serve(on('GET', '/api/accounting/permissions', empty500));
    grid();
    expect(await screen.findByText('Could not load the permissions - try again')).toBeDefined();
    expectNoJargon();
  });

  it('reset: a refusal reports the server message and never "reset to role defaults"', async () => {
    serve(on('DELETE', '/api/accounting/permissions', () => refuse()), GET);
    const fb = grid();
    fireEvent.click(await screen.findByText('Reset to Defaults'));
    await waitFor(() => expect(fb).toHaveBeenCalledWith(MSG));
    expect(fb).not.toHaveBeenCalledWith('Permissions reset to role defaults.');
  });

  it('reset: an empty-body 500 reports a plain sentence; a good reset says so', async () => {
    serve(on('DELETE', '/api/accounting/permissions', empty500), GET);
    const fb = grid();
    fireEvent.click(await screen.findByText('Reset to Defaults'));
    await waitFor(() => expect(fb).toHaveBeenCalledWith('Could not reset the permissions - try again'));
    serve(on('DELETE', '/api/accounting/permissions', () => ok({})), GET);
    fireEvent.click(screen.getByText('Reset to Defaults'));
    await waitFor(() => expect(fb).toHaveBeenCalledWith('Permissions reset to role defaults.'));
  });

  it('toggle save: a refusal reports the server message and reloads the saved state', async () => {
    serve(on('POST', '/api/accounting/permissions', () => refuse()), GET);
    const fb = grid();
    await screen.findByText('D2 Sales Module');
    fireEvent.click(document.querySelectorAll('tbody button')[1] as HTMLButtonElement);
    await waitFor(() => expect(fb).toHaveBeenCalledWith(MSG));
    await waitFor(() => expect(writeCalls('GET', '/api/accounting/permissions')).toBe(2));
  });

  it('toggle save: an empty-body 500 reports a plain sentence', async () => {
    serve(on('POST', '/api/accounting/permissions', empty500), GET);
    const fb = grid();
    await screen.findByText('D2 Sales Module');
    fireEvent.click(document.querySelectorAll('tbody button')[1] as HTMLButtonElement);
    await waitFor(() => expect(fb).toHaveBeenCalledWith('Could not save the permission - try again'));
  });
});

describe('UdfTab', () => {
  const DEF = { id: 'd1', entityType: 'customer', fieldNumber: 1, fieldLabel: 'D2 Region', fieldType: 'text', fieldOptions: null,
    isRequired: false, isActive: true };
  const defs = on('GET', '/api/accounting/udf-definitions', () => ok([DEF]));

  it('load: a refusal shows the server message and no editable fields or Save', async () => {
    serve(on('GET', '/api/accounting/udf-definitions', () => refuse()));
    render(<UdfTab />);
    fireEvent.click(screen.getByText('Customer Fields'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('Save Customer Fields')).toBeNull();
    expect(screen.queryByPlaceholderText('Field 1 (unused)')).toBeNull();
  });

  it('save: a refusal shows the message and no "saved" state', async () => {
    serve(on('POST', '/api/accounting/udf-definitions', () => refuse()), defs);
    render(<UdfTab />);
    fireEvent.click(screen.getByText('Customer Fields'));
    fireEvent.click(await screen.findByText('Save Customer Fields'));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText(/saved/i)).toBeNull();
  });

  it('save: an empty-body 500 gives a plain sentence', async () => {
    serve(on('POST', '/api/accounting/udf-definitions', empty500), defs);
    render(<UdfTab />);
    fireEvent.click(screen.getByText('Customer Fields'));
    fireEvent.click(await screen.findByText('Save Customer Fields'));
    expect(await screen.findByText('Could not save the field definitions - try again')).toBeDefined();
    expectNoJargon();
  });
});
