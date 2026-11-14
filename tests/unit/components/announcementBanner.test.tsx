/**
 * The tenant announcement banner (admin audit 1.4): title and message render as TEXT (an announcement is free text
 * an admin typed, never HTML), a dismissible one closes and is remembered through the dismiss route, a
 * not-dismissible one has no close button, and a failing fetch leaves the app alone.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnouncementBanner, clearAnnouncementCache } from '@/components/layout/AnnouncementBanner';
import { apiFetch } from '@/lib/apiFetch';
import type { TenantAnnouncement } from '@/lib/tenantAnnouncements';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
const h = vi.hoisted(() => ({
  auth: { user: { id: 'u1' } as { id: string } | null },
  company: { activeCompany: { id: 'c1' } as { id: string } | null },
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => h.company }));
useApiJsonOverMock();

const ann = (over: Partial<TenantAnnouncement> = {}): TenantAnnouncement => ({
  id: '11111111-1111-4111-8111-111111111111', title: 'Maintenance', message: 'Down 22:00 to 23:00.', type: 'maintenance',
  starts_at: '2026-11-14T10:00:00.000Z', ends_at: null, is_dismissible: true, ...over,
});
const envelope = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } });
const calls = (match: string) => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u) === match);

function serve(list: TenantAnnouncement[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    if (String(url) === '/api/announcements/active') return envelope(list);
    if (String(url) === '/api/announcements/dismiss') return envelope({ id: 'x' });
    return new Response('{}', { status: 404 });
  });
}

beforeEach(() => { clearAnnouncementCache(); h.auth.user = { id: 'u1' }; h.company.activeCompany = { id: 'c1' }; serve([ann()]); });
afterEach(cleanup);

describe('AnnouncementBanner', () => {
  it('shows the title and the message', async () => {
    render(<AnnouncementBanner />);
    expect(await screen.findByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByText('Down 22:00 to 23:00.')).toBeInTheDocument();
  });

  it('renders HTML in the title or message as literal text: no element is created, nothing runs', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script><b>bold</b>';
    serve([ann({ title: '<i>Title</i>', message: evil })]);
    const { container } = render(<AnnouncementBanner />);
    expect(await screen.findByText(evil)).toBeInTheDocument();
    expect(screen.getByText('<i>Title</i>')).toBeInTheDocument();
    expect(container.querySelector('img, script, b, i')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('dismissing hides it at once and sends the id to the dismiss route', async () => {
    render(<AnnouncementBanner />);
    fireEvent.click(await screen.findByRole('button', { name: /dismiss announcement: maintenance/i }));
    expect(screen.queryByText('Maintenance')).toBeNull();
    await waitFor(() => expect(calls('/api/announcements/dismiss')).toHaveLength(1));
    const [, init] = calls('/api/announcements/dismiss')[0]!;
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ id: ann().id });
  });

  it('stays dismissed on the next page (a fresh mount) without asking the server again', async () => {
    const first = render(<AnnouncementBanner />);
    fireEvent.click(await screen.findByRole('button', { name: /dismiss announcement/i }));
    first.unmount();
    render(<AnnouncementBanner />);
    expect(screen.queryByText('Maintenance')).toBeNull();
    expect(calls('/api/announcements/active')).toHaveLength(1);
  });

  it('a not-dismissible announcement has no close button', async () => {
    serve([ann({ is_dismissible: false })]);
    render(<AnnouncementBanner />);
    await screen.findByText('Maintenance');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows every active announcement', async () => {
    serve([ann(), ann({ id: '22222222-2222-4222-8222-222222222222', title: 'New feature', type: 'feature' })]);
    render(<AnnouncementBanner />);
    expect(await screen.findByText('New feature')).toBeInTheDocument();
    expect(screen.getByText('Maintenance')).toBeInTheDocument();
  });

  it('a failed load renders nothing and does not throw', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response('{}', { status: 500 }));
    const { container } = render(<AnnouncementBanner />);
    await waitFor(() => expect(calls('/api/announcements/active')).toHaveLength(1));
    expect(container.firstChild).toBeNull();
  });

  it('asks nothing without a user and a company, and asks again for another company', async () => {
    h.auth.user = null;
    const view = render(<AnnouncementBanner />);
    expect(calls('/api/announcements/active')).toHaveLength(0);
    h.auth.user = { id: 'u1' };
    view.rerender(<AnnouncementBanner />);
    await screen.findByText('Maintenance');
    h.company.activeCompany = { id: 'c2' };
    serve([ann({ id: '33333333-3333-4333-8333-333333333333', title: 'Only for c2' })]);
    view.rerender(<AnnouncementBanner />);
    expect(await screen.findByText('Only for c2')).toBeInTheDocument();
    expect(screen.queryByText('Maintenance')).toBeNull();
  });
});
