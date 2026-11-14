// Admin Settings (WP13, admin audit 4.13): the Health Alert inputs are named by their captions, so a screen
// reader (and getByLabelText) finds "Alert Email" and "Webhook URL".
import { cleanup, configure, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SettingsPage from '../../../pages/admin/settings';

useApiJsonOverMock();
afterEach(() => { cleanup(); });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

describe('settings labels', () => {
  it('names the health alert inputs', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes('alert-settings')
      ? ok({ health_alert_email: 'ops@isaflow.test', health_alert_webhook_url: '' })
      : ok({ smtp_configured: false, maintenance_mode: false, registration_enabled: true, max_companies_per_user: 5 })));
    render(<SettingsPage />);
    expect(((await screen.findByLabelText('Alert Email')) as HTMLInputElement).value).toBe('ops@isaflow.test');
    expect((screen.getByLabelText('Webhook URL') as HTMLInputElement).tagName).toBe('INPUT');
  });
});
