/**
 * D2 round 3 (a7): my-account saves, the dashboard impersonation exchange, the statement-email hook and the
 * company-document download/delete. 400 -> the server's message; empty-body 500 -> a plain sentence (never
 * JSON / HTTP / bare Failed); a refused write never claims success; a download never saves an error body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const refreshUser = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const replace = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: toast }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: query.value, isReady: true, push: vi.fn(), replace }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'owner' }, refreshUser }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }) }));
const co = vi.hoisted(() => ({ id: 'co-1' }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: co.id, name: 'D2 Co' }, companies: [{ companyId: 'co-1' }], loading: false }) }));
vi.mock('@/components/accounting/my-account/TwoFactorSection', () => ({ TwoFactorSection: () => null }));
vi.mock('@/components/accounting/my-account/ChangeEmailSection', () => ({ ChangeEmailSection: () => null }));
vi.mock('@/components/accounting/dashboard/OverviewTab', () => ({ OverviewTab: () => null }));
vi.mock('@/components/accounting/dashboard/ChartOfAccountsTab', () => ({ ChartOfAccountsTab: () => null }));
vi.mock('@/components/accounting/dashboard/JournalEntriesTab', () => ({ JournalEntriesTab: () => null }));
vi.mock('@/components/accounting/dashboard/FiscalPeriodsTab', () => ({ FiscalPeriodsTab: () => null }));
vi.mock('@/components/accounting/dashboard/ReportsTab', () => ({ ReportsTab: () => null }));
vi.mock('@/components/accounting/dashboard/DashboardHero', () => ({ DashboardHero: ({ stats }: { stats?: { revenueMtd: number } }) => <p>hero revenue {stats ? stats.revenueMtd : 'none'}</p> }));

import { apiFetch } from '@/lib/apiFetch';
import MyAccountPage from '../../../pages/accounting/my-account';
import AccountingPage from '../../../pages/accounting/index';
import { DetailsTab } from '../../../src/components/accounting/settings/DetailsTab';
import { useStatementEmail } from '../../../src/modules/accounting/hooks/useStatementEmail';

useApiJsonOverMock();
beforeEach(() => { query.value = {}; });
afterEach(() => { cleanup(); for (const f of [refreshUser, toast.error, toast.success, replace]) f.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const click = async (name: RegExp | string) => fireEvent.click(await screen.findByRole('button', { name }));
const PROFILE = { firstName: 'D2', lastName: 'Tester', email: 'd2@example.com', phone: '', mobile: '' };
const account = (write: (u: string) => Response, loads: Record<string, () => Response> = {}) => script((u, m) => {
  if (m !== 'GET') return write(u);
  const k = Object.keys(loads).find(x => u.includes(x));
  return k ? loads[k]!() : u.includes('profile') ? ok(PROFILE) : ok({ rowsPerPage: '50', navMode: 'top' });
});
const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'PUT' || i?.method === 'POST').length;

describe('my-account', () => {
  const saveProfile = async () => { render(<MyAccountPage />); await screen.findByDisplayValue('Tester'); await click(/save profile/i); };
  it('profile save 400: the server message, no success', async () => {
    account(refuse); await saveProfile();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG)); expect(toast.success).not.toHaveBeenCalled(); expect(refreshUser).not.toHaveBeenCalled();
  });
  it('profile save empty-body 500: a plain sentence', async () => {
    account(empty500); await saveProfile();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save your profile - try again')); expect(toast.success).not.toHaveBeenCalled();
  });
  it('profile save 200 but the user refresh fails: still reported as saved, never as failed', async () => {
    refreshUser.mockRejectedValue(new Error('refresh blew up'));
    account(() => ok({})); await saveProfile();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Profile updated successfully')); expect(toast.error).not.toHaveBeenCalled();
  });
  it('a failed profile load blocks Save: nothing is written', async () => {
    account(() => ok({}), { profile: empty500 }); render(<MyAccountPage />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load your profile - try again'));
    fireEvent.change(screen.getByPlaceholderText('First name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByPlaceholderText('Last name'), { target: { value: 'Y' } });
    await click(/save profile/i);
    expect(toast.error).toHaveBeenCalledWith('Your profile could not be loaded - reload the page before saving'); expect(puts()).toBe(0);
  });
  const changePassword = async () => {
    render(<MyAccountPage />); await screen.findByDisplayValue('Tester'); await click(/^security$/i);
    await screen.findByRole('button', { name: /change password/i });
    document.querySelectorAll('input[type="password"]').forEach(i => fireEvent.change(i, { target: { value: 'D2-pass-1234' } }));
    await click(/change password/i);
  };
  it('password change 400: the server message, no success', async () => {
    account(refuse); await changePassword();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG)); expect(toast.success).not.toHaveBeenCalled();
  });
  it('password change empty-body 500: a plain sentence', async () => {
    account(empty500); await changePassword();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not change your password - try again'));
  });
  const savePrefs = async () => { render(<MyAccountPage />); await screen.findByDisplayValue('Tester'); await click(/^preferences$/i); await click(/save preferences/i); };
  it('preferences save 400 / empty 500: message / plain sentence, never success', async () => {
    account(refuse); await savePrefs();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG)); expect(toast.success).not.toHaveBeenCalled();
    cleanup(); toast.error.mockClear();
    account(empty500); await savePrefs();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save your preferences - try again'));
  });
  it('a failed preferences load blocks Save so defaults never overwrite the real values', async () => {
    account(() => ok({}), { preferences: empty500 }); render(<MyAccountPage />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load your preferences - try again'));
    await screen.findByDisplayValue('Tester'); await click(/^preferences$/i); await click(/save preferences/i);
    expect(toast.error).toHaveBeenCalledWith('Your preferences could not be loaded - reload the page before saving'); expect(puts()).toBe(0);
  });
});

describe('dashboard impersonation exchange', () => {
  const mount = (res: () => Response) => {
    query.value = { impersonate: 'tok-1' };
    const assign = vi.fn(); vi.stubGlobal('location', { ...window.location, assign });
    script(u => (u.includes('impersonate-exchange') ? res() : u.includes('kpi-dashboard') ? ok({ kpis: {} }) : undefined));
    render(<AccountingPage />); return assign;
  };
  it('400: the server message is shown (not a silent bounce to the own dashboard)', async () => {
    const assign = mount(refuse);
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(assign).not.toHaveBeenCalled(); expect(window.localStorage.getItem('isaflow_active_company')).toBeNull();
  });
  it('empty-body 500: a plain sentence', async () => {
    mount(empty500);
    expect(await screen.findByText('Could not switch to that company - try again')).toBeTruthy(); expectNoRawError();
  });
  it('200: the company is stored and the page hard-navigates', async () => {
    const assign = mount(() => ok({ company_id: 'co-9', company_name: 'D2 Target' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/accounting'));
    expect(window.localStorage.getItem('isaflow_active_company')).toContain('co-9'); window.localStorage.clear();
  });
});

describe('dashboard hero figures', () => {
  it('a failing reload for another company clears the previous company\'s figures', async () => {
    co.id = 'co-1';
    script(() => ok({ kpis: { revenue: { total: 777 } } }));
    const { rerender } = render(<AccountingPage />);
    expect(await screen.findByText('hero revenue 777')).toBeTruthy();
    script(() => empty500()); co.id = 'co-2'; rerender(<AccountingPage />);
    expect(await screen.findByText('Could not load the dashboard figures - try again')).toBeTruthy();
    expect(screen.queryByText('hero revenue 777')).toBeNull(); co.id = 'co-1';
  });
});

describe('useStatementEmail', () => {
  function Harness() {
    const { sendEmails, toast: t } = useStatementEmail({ customers: [{ client_id: 'c1', email: 'a@b.co' }], asAtDate: '2031-01-31' });
    return <div><button onClick={() => void sendEmails(new Set(['c1']))}>send</button><p data-testid="toast">{t?.message ?? ''}</p></div>;
  }
  const send = async (res: () => Response) => { script(() => res()); render(<Harness />); await click('send'); };
  it('400: the server message, never "Sent 0 statements successfully"', async () => {
    await send(refuse);
    await waitFor(() => expect(screen.getByTestId('toast').textContent).toBe(MSG)); expect(document.body.textContent).not.toMatch(/Sent 0/);
  });
  it('empty-body 500: a plain sentence, not "Failed to send emails"', async () => {
    await send(empty500);
    await waitFor(() => expect(screen.getByTestId('toast').textContent).toBe('Could not send the statements - try again')); expectNoRawError();
  });
  it('200: the sent count', async () => {
    await send(() => ok({ sent: 1, failed: 0, errors: [] }));
    await waitFor(() => expect(screen.getByTestId('toast').textContent).toBe('Sent 1 statement successfully.'));
  });
  it('a 200 that reports nothing sent is not a success', async () => {
    await send(() => ok({}));
    await waitFor(() => expect(screen.getByTestId('toast').textContent).toBe('No statements were sent - try again'));
  });
});

describe('DetailsTab documents', () => {
  const DOC = { id: 'd1', documentType: 'cipc_certificate', documentName: 'D2-cert.pdf', mimeType: 'application/pdf', fileSize: 10, createdAt: '2031-01-01' };
  const mountTab = (res: (m: string) => Response) => {
    const onError = vi.fn(); const onDocumentsChange = vi.fn();
    script((_u, m) => res(m));
    const create = vi.fn(() => 'blob:d2'); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    window.confirm = vi.fn(() => true);
    render(<DetailsTab company={{ id: 'co-1', name: 'D2 Co', entityType: 'pty' } as never} onChange={vi.fn()} onCompanyChange={vi.fn()}
      documents={[DOC]} onDocumentsChange={onDocumentsChange} onError={onError} />);
    return { onError, onDocumentsChange, create, click };
  };
  it('download 400: the server message and no file is saved', async () => {
    const t = mountTab(() => refuse()); fireEvent.click(screen.getByTitle('Download'));
    await waitFor(() => expect(t.onError).toHaveBeenCalledWith(MSG)); expect(t.create).not.toHaveBeenCalled(); expect(t.click).not.toHaveBeenCalled();
  });
  it('download empty-body 500: a plain sentence and no file is saved', async () => {
    const t = mountTab(() => empty500()); fireEvent.click(screen.getByTitle('Download'));
    await waitFor(() => expect(t.onError).toHaveBeenCalledWith('Could not download the document - try again')); expect(t.create).not.toHaveBeenCalled();
  });
  it('download 200: the file is saved', async () => {
    const t = mountTab(() => new Response('PDFBYTES', { status: 200 })); fireEvent.click(screen.getByTitle('Download'));
    await waitFor(() => expect(t.click).toHaveBeenCalled()); expect(t.onError).not.toHaveBeenCalledWith(expect.stringMatching(/./));
  });
  it('delete 400: the server message and the document stays; empty 500: a plain sentence', async () => {
    const t = mountTab(() => refuse()); fireEvent.click(screen.getByTitle('Delete'));
    await waitFor(() => expect(t.onError).toHaveBeenCalledWith(MSG)); expect(t.onDocumentsChange).not.toHaveBeenCalled();
    cleanup(); const t2 = mountTab(() => empty500()); fireEvent.click(screen.getByTitle('Delete'));
    await waitFor(() => expect(t2.onError).toHaveBeenCalledWith('Could not delete the document - try again'));
  });
});
