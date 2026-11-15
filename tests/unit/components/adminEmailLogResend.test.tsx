// Admin audit 2026-11-14, item 1.12 + goal §2a: the email log's Resend sent the
// recipient a "[Resent] <subject>" shell with none of the original content (the
// log keeps no body), and the row then said "Sent". No email type can be rebuilt
// from what email_log holds, so a failed row shows the reason instead of a Resend
// button (review L2: no permanently disabled control).
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import EmailLogPage from '../../../pages/admin/email-log';

const failed = {
  id: 'log-1', company_id: 'c-1', company_name: 'Acme', recipient_email: 'customer@example.test',
  subject: 'Invoice INV-123', email_type: 'invoice', status: 'failed', error_message: 'SMTP timeout',
  sent_at: '2026-11-13T10:00:00Z', sent_by: null,
};
const page = { items: [failed], total: 1, page: 1, limit: 25, stats: { total_sent: 0, total_failed: 1, success_rate: 0 } };

afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

describe('email log Resend', () => {
  it('offers no Resend button on a failed row, only the reason, and posts nothing', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: page }), { status: 200 }));
    render(<EmailLogPage />);
    const note = await screen.findByText(/resend unavailable: no copy of the email is kept/i);
    expect(note.getAttribute('title')).toMatch(/cannot be rebuilt/i);
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull();
    fireEvent.click(note);
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toEqual([]);
  });
});
