import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import AdminSettings from '../../../pages/admin/settings';

afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('admin settings page', () => {
  it('shows no maintenance / registration / max-companies controls, keeps Health Alerts', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('alert-settings')
      ? ok({ health_alert_email: 'a@b.co', health_alert_webhook_url: '' })
      : ok({ smtp_configured: true })));
    render(<AdminSettings />);
    expect(await screen.findByDisplayValue('a@b.co')).toBeTruthy();
    expect(screen.queryByText(/maintenance mode/i)).toBeNull();
    expect(screen.queryByText(/registration enabled/i)).toBeNull();
    expect(screen.queryByText(/max companies per user/i)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /^save settings$/i })).toBeNull();
    expect(screen.getByRole('button', { name: /save alert settings/i })).toBeTruthy();
    expect(screen.getByText(/only when an admin has the System Health page open/i)).toBeTruthy();
  });
});
