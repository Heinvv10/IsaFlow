/**
 * D2 round 7 (k4): connected apps (a good revoke whose reload fails is still reported), webhook delivery log (redeliver
 * reads status before body; a failed load does not loop), AFS notes tab, chart-of-accounts import (real session shape
 * `{ session }`, template download, session load). REAL assertOk / apiErrorMessage over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/migration/CoaImportResult', () => ({ CoaImportResult: () => null }));
vi.mock('papaparse', () => ({
  default: { parse: (_file: unknown, opts: { complete: (r: unknown) => void }) => opts.complete({
    data: [{ account_code: '1000', account_name: 'Bank', account_type: 'asset' }], meta: { fields: ['account_code', 'account_name', 'account_type'] } }) },
}));

import { apiFetch } from '@/lib/apiFetch';
import ConnectedAppsPage from '../../../pages/accounting/settings/connected-apps';
import { DeliveryLog } from '../../../src/components/admin/webhooks/DeliveryLog';
import { AfsNotesTab } from '../../../src/components/accounting/afs/AfsNotesTab';
import CoaMigrationPage from '../../../pages/accounting/migration/chart-of-accounts';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const calls = (method: string, part: string) => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).includes(part) && ((i as RequestInit | undefined)?.method ?? 'GET') === method);

describe('connected apps', () => {
  const APP = { authorisationId: 'a1', appId: 'x', appName: 'Zeta App', appLogoUrl: null, appIsVerified: false, scopes: ['read'], companyId: 'c', lastUsedAt: null, createdAt: '2026-01-01' };
  const revoke = async () => { vi.stubGlobal('confirm', () => true); fireEvent.click(await screen.findByRole('button', { name: /revoke/i })); };

  it('a good revoke whose reload FAILS still says it was revoked', async () => {
    let loads = 0;
    script((u, m) => (m === 'DELETE' ? ok({}) : ++loads === 1 ? ok([APP]) : empty500()));
    render(<ConnectedAppsPage />); await revoke();
    expect(await screen.findByText('Access revoked, but the list could not be refreshed - reload the page')).toBeTruthy();
    expect(screen.queryByText('Zeta App')).toBeNull(); expectNoRawError();
  });
  it('a good revoke and reload says Access revoked', async () => {
    let revoked = false;
    script((u, m) => { if (m === 'DELETE') { revoked = true; return ok({}); } return ok(revoked ? [] : [APP]); });
    render(<ConnectedAppsPage />); await revoke();
    expect(await screen.findByText('Access revoked')).toBeTruthy(); expect(screen.queryByText('Zeta App')).toBeNull();
  });
  it('a refused revoke shows the server message, an empty 500 a plain sentence', async () => {
    script((u, m) => (m === 'DELETE' ? refuse() : ok([APP])));
    render(<ConnectedAppsPage />); await revoke();
    expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    script((u, m) => (m === 'DELETE' ? empty500() : ok([APP])));
    render(<ConnectedAppsPage />); await revoke();
    expect(await screen.findByText('Could not revoke access - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a failed load shows a plain sentence and no apps', async () => {
    script(() => empty500()); render(<ConnectedAppsPage />);
    expect(await screen.findByText('Could not load your connected apps - try again')).toBeTruthy(); expectNoRawError();
  });
});

describe('webhook delivery log', () => {
  const DETAIL = { deliveries: [{ id: 'd1', success: false, deliveredAt: '2026-01-01T10:00:00Z', event: 'invoice.paid', responseStatus: 500, responseBody: null }] };
  const redeliver = async () => fireEvent.click(await screen.findByRole('button', { name: /redeliver last failed/i }));

  it('a refused redeliver shows the server message', async () => {
    script((u, m) => (m === 'POST' ? refuse() : ok(DETAIL))); render(<DeliveryLog webhookId="w1" />); await redeliver();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-500 redeliver is a plain sentence, never a JSON error or the old "Redeliver failed"', async () => {
    script((u, m) => (m === 'POST' ? empty500() : ok(DETAIL))); render(<DeliveryLog webhookId="w1" />); await redeliver();
    expect(await screen.findByText('Could not queue the redelivery - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a good redeliver queues and reloads', async () => {
    script((u, m) => ok(m === 'POST' ? {} : DETAIL)); render(<DeliveryLog webhookId="w1" />); await redeliver();
    expect(await screen.findByText('Delivery queued for retry')).toBeTruthy();
    await waitFor(() => expect(calls('GET', '/api/admin/webhooks/w1').length).toBe(2));
  });
  it('a good redeliver whose reload fails still says it was queued', async () => {
    let gets = 0;
    script((u, m) => (m === 'POST' ? ok({}) : ++gets === 1 ? ok(DETAIL) : empty500())); render(<DeliveryLog webhookId="w1" />); await redeliver();
    expect(await screen.findByText(/^Delivery queued for retry, but the list could not be refreshed/)).toBeTruthy(); expectNoRawError();
  });
  it('a failed load is said once and does not re-request in a loop', async () => {
    script(() => empty500()); render(<DeliveryLog webhookId="w1" />);
    expect(await screen.findByText('Could not load deliveries - try again')).toBeTruthy();
    await new Promise(r => setTimeout(r, 400));
    expect(calls('GET', '/api/admin/webhooks/w1').length).toBe(1);
  });
});

describe('afs notes tab', () => {
  const NOTE = { noteNumber: 1, title: 'Revenue', content: 'Zeta revenue policy', source: 'auto', tables: [] };
  it('a refused load shows the server message, an empty 500 a plain sentence, no notes either way', async () => {
    script(() => refuse()); render(<AfsNotesTab fiscalYear={2025} />);
    expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    script(() => empty500()); render(<AfsNotesTab fiscalYear={2025} />);
    expect(await screen.findByText('Could not load the disclosure notes - try again')).toBeTruthy();
    expect(screen.queryByText(/No disclosure notes generated/)).toBeNull(); expectNoRawError();
  });
  it('a good load lists the notes; a failing year change clears them', async () => {
    script((u) => (u.includes('year=2025') ? ok({ notes: [NOTE] }) : empty500()));
    const { rerender } = render(<AfsNotesTab fiscalYear={2025} />);
    expect(await screen.findByText('Zeta revenue policy')).toBeTruthy();
    rerender(<AfsNotesTab fiscalYear={2024} />);
    expect(await screen.findByText('Could not load the disclosure notes - try again')).toBeTruthy();
    expect(screen.queryByText('Zeta revenue policy')).toBeNull();
  });
});

describe('chart-of-accounts import page', () => {
  const SESSION = { id: 'session-1', sourceSystem: 'sage' };
  const uploaded = async (container: HTMLElement) => {
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['a'], 'a.csv', { type: 'text/csv' })] } });
    const go = await screen.findByRole('button', { name: /import 1 accounts/i });
    await waitFor(() => expect((go as HTMLButtonElement).disabled).toBe(false));
    return go;
  };
  it('a real session ({ session }) lets the import proceed with its id', async () => {
    script((u, m) => (u.includes('/migration/session') ? ok({ session: SESSION }) : m === 'POST' ? ok({}) : ok({})));
    const { container } = render(<CoaMigrationPage />); const go = await uploaded(container);
    await waitFor(() => expect(calls('GET', '/migration/session').length).toBe(1)); fireEvent.click(go);
    await waitFor(() => expect(calls('POST', '/migration/chart-of-accounts').length).toBe(1));
    expect(JSON.parse(String((calls('POST', '/migration/chart-of-accounts')[0]![1] as RequestInit).body)).sessionId).toBe('session-1');
    expect(screen.queryByText(/No active migration session/)).toBeNull();
  });
  it('{ session: null } leaves the import disabled and posts nothing', async () => {
    script((u) => (u.includes('/migration/session') ? ok({ session: null }) : ok({})));
    const { container } = render(<CoaMigrationPage />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['a'], 'a.csv', { type: 'text/csv' })] } });
    const go = await screen.findByRole('button', { name: /import 1 accounts/i });
    await waitFor(() => expect(calls('GET', '/migration/session').length).toBe(1));
    expect((go as HTMLButtonElement).disabled).toBe(true); fireEvent.click(go);
    expect(calls('POST', '/migration/chart-of-accounts').length).toBe(0);
  });
  it('a failed session load is shown (server message / plain sentence)', async () => {
    script(() => refuse()); render(<CoaMigrationPage />);
    expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    script(() => empty500()); render(<CoaMigrationPage />);
    expect(await screen.findByText('Could not load the migration session - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a failed template download is shown, not a dead button', async () => {
    script((u) => (u.includes('/templates') ? empty500() : ok({ session: null }))); render(<CoaMigrationPage />);
    fireEvent.click(screen.getByRole('button', { name: /download csv template/i }));
    expect(await screen.findByText('Could not download the template - try again')).toBeTruthy(); cleanup();
    script((u) => (u.includes('/templates') ? refuse() : ok({ session: null }))); render(<CoaMigrationPage />);
    fireEvent.click(screen.getByRole('button', { name: /download csv template/i }));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});
