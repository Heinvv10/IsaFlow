/**
 * D2 round 3 (a1): accounting settings (a failed load must not render blank editable values),
 * the two-factor panel (an unknown status must never show "Enable"), company document upload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast, default: toast }));

import AccountingSettingsPage from '../../../pages/accounting/accounting-settings';
import { TwoFactorSection } from '@/components/accounting/my-account/TwoFactorSection';
import { DetailsTab } from '@/components/accounting/settings/DetailsTab';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const AP = { settings: { enabled: false, minConfidence: 0.9, amountCap: 10000, llmEnabled: false, llmMinConfidence: 0.95, llmAmountCap: 2000 } };

describe('accounting settings', () => {
  function open(key: (method: string) => Response, autopost: () => Response = () => ok(AP)) {
    route((url, method) => (url.includes('/bank-auto-post') ? autopost() : key(method)));
    render(<AccountingSettingsPage />);
  }
  const KEY = (method: string) => (method === 'GET' ? ok({ value: 'USD' }) : ok({}));

  it('a failed settings load shows one error and no editable form', async () => {
    open(() => empty500());
    expect(await screen.findByText(/Could not load settings - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull());
    expect(screen.queryByText('Reporting Currency')).toBeNull();
    expect(document.querySelector('select[name="reporting_currency"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
    expect(screen.queryByText(/No configurable settings/)).toBeNull();
  });
  it('shows the server message when a key refuses to load', async () => {
    open(() => bad());
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(document.querySelector('select[name="reporting_currency"]')).toBeNull();
  });
  it('the key-load message is not overwritten by an auto-post load failure', async () => {
    open(() => empty500(), () => bad());
    expect(await screen.findByText(/Could not load settings - try again/)).toBeTruthy();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.getByText(/Could not load settings - try again/)).toBeTruthy();
  });
  it('a failed auto-post load hides the auto-post card instead of showing defaults', async () => {
    open(KEY, () => bad());
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(await screen.findByText('Reporting Currency')).toBeTruthy();
    expect(screen.queryByText(/Auto-post high-confidence transactions/)).toBeNull();
  });
  it('renders the loaded value and saves it', async () => {
    open(KEY);
    const select = (await screen.findByDisplayValue(/USD/)) as HTMLSelectElement;
    expect(select.value).toBe('USD');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Reporting Currency updated'));
  });
  it('a refused save shows the server message, not a generic failure', async () => {
    open((m) => (m === 'GET' ? ok({ value: 'USD' }) : bad()));
    await screen.findByDisplayValue(/USD/);
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG));
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('an empty 500 save shows a plain sentence', async () => {
    open((m) => (m === 'GET' ? ok({ value: 'USD' }) : empty500()));
    await screen.findByDisplayValue(/USD/);
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the setting - try again'));
  });
});

describe('two-factor panel', () => {
  const enabled = () => ok({ enabled: true, factor_id: 'f1' });
  const disabled = () => ok({ enabled: false, factor_id: null });
  const noEnable = () => {
    expect(screen.queryByRole('button', { name: /Enable 2FA/ })).toBeNull();
    expect(screen.queryByText(/Adds a second step/)).toBeNull();
  };

  it('an empty-500 status never shows the Enable panel; it shows a plain sentence and a retry', async () => {
    route(() => empty500());
    render(<TwoFactorSection />);
    expect(await screen.findByText(/Could not load your two-factor status - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    noEnable();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
  });
  it('a refused status shows the server message and no Enable panel', async () => {
    route(() => bad());
    render(<TwoFactorSection />);
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    noEnable();
  });
  it('a 200 status without data is unknown, not "disabled"', async () => {
    route(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
    render(<TwoFactorSection />);
    expect(await screen.findByRole('button', { name: /Try again/ })).toBeTruthy();
    noEnable();
  });
  it('retry after a failed status shows the real (enabled) state', async () => {
    let gets = 0;
    route(() => (++gets === 1 ? empty500() : enabled()));
    render(<TwoFactorSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Try again/ }));
    expect(await screen.findByText(/Two-factor authentication is enabled/)).toBeTruthy();
    expect(screen.queryByText(/Could not load your two-factor status/)).toBeNull();
  });
  it('confirm succeeds then the status refresh fails: still shown as enabled, never the Enable panel', async () => {
    let statuses = 0;
    route((url) => {
      if (url.includes('2fa-status')) return ++statuses === 1 ? disabled() : empty500();
      if (url.includes('2fa-enroll')) return ok({ factor_id: 'f9', qr_code: '<svg></svg>', secret: 'D2SECRET' });
      return ok({});
    });
    render(<TwoFactorSection />);
    fireEvent.click(await screen.findByRole('button', { name: /Enable 2FA/ }));
    fireEvent.change(await screen.findByLabelText('TOTP code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Enable 2FA/ }));
    expect(await screen.findByText(/Two-factor authentication is enabled/)).toBeTruthy();
    expect(await screen.findByText(/Could not load your two-factor status - try again/)).toBeTruthy();
    noEnable();
  });
  it('a refused disable keeps the enabled view and shows the server message', async () => {
    route((url) => (url.includes('2fa-status') ? enabled() : bad()));
    render(<TwoFactorSection />);
    fireEvent.change(await screen.findByLabelText('TOTP code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Disable 2FA/ }));
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.getByText(/Two-factor authentication is enabled/)).toBeTruthy();
  });
  it('a successful disable shows the Enable panel', async () => {
    let statuses = 0;
    route((url) => (url.includes('2fa-status') ? (++statuses === 1 ? enabled() : disabled()) : ok({})));
    render(<TwoFactorSection />);
    fireEvent.change(await screen.findByLabelText('TOTP code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Disable 2FA/ }));
    expect(await screen.findByRole('button', { name: /Enable 2FA/ })).toBeTruthy();
  });
});

describe('company document upload', () => {
  function upload(post: () => Response, docs: () => Response = () => ok([{ id: 'd1' }])) {
    route((_u, method) => (method === 'POST' ? post() : docs()));
    const props = { company: { id: 'co-1', name: 'D2 Co' } as never, onChange: vi.fn(), onCompanyChange: vi.fn(),
      documents: [], onDocumentsChange: vi.fn(), onError: vi.fn() };
    const { container } = render(<DetailsTab {...props} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'cert.pdf', { type: 'application/pdf' })] } });
    return props;
  }
  it('a refused upload reports the server message', async () => {
    const p = upload(() => bad());
    await waitFor(() => expect(p.onError).toHaveBeenCalledWith(MSG));
    expect(p.onDocumentsChange).not.toHaveBeenCalled();
  });
  it('an empty 500 upload reports a plain sentence', async () => {
    const p = upload(empty500);
    await waitFor(() => expect(p.onError).toHaveBeenCalledWith('Could not upload the document - try again'));
    expect(p.onDocumentsChange).not.toHaveBeenCalled();
  });
  it('a good upload refreshes the document list', async () => {
    const p = upload(() => ok({}));
    await waitFor(() => expect(p.onDocumentsChange).toHaveBeenCalledWith([{ id: 'd1' }]));
    expect(p.onError).not.toHaveBeenCalledWith(expect.stringMatching(/./));
  });
});
