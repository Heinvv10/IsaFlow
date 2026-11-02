/**
 * NotificationBell (budgets P5 T8): the header bell. Unread badge from GET /api/accounting/notifications,
 * a dropdown of the latest 20, mark one read (then follow its in-app link) or all read, a plain
 * sentence when a call fails (the response status is checked, never trusted), and a control
 * distinct from the setup guide's (bell, "Notifications").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ fetch: vi.fn(), push: vi.fn(async () => true) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: h.push, pathname: '/accounting', asPath: '/accounting', query: {} }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => ({
  ...(await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch')),
  apiFetch: (...a: unknown[]) => h.fetch(...a),
}));

import { NotificationBell } from '@/components/layout/NotificationBell';

const note = (id: string, over: Record<string, unknown> = {}) => ({
  id, kind: 'budget_alert', refId: null, title: `Title ${id}`, body: `Body ${id}`, href: `/accounting/budgets/${id}`,
  createdAt: '2026-11-02T08:00:00.000Z', readAt: null, ...over,
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const fail = (status: number, message: string) => new Response(JSON.stringify({ success: false, error: { message } }), { status });
const feed = (items: unknown[], unread: number) => ok({ items, unread });
const bell = () => screen.getByRole('button', { name: 'Notifications' });

beforeEach(() => { h.fetch.mockReset(); h.push.mockClear(); });
afterEach(cleanup);

describe('NotificationBell', () => {
  it('is a bell labelled "Notifications" with the unread count as its badge (99+ past 99)', async () => {
    h.fetch.mockResolvedValueOnce(feed([note('a')], 3));
    render(<NotificationBell />);
    await waitFor(() => expect(screen.getByTestId('notification-badge').textContent).toBe('3'));
    expect(bell().getAttribute('aria-haspopup')).toBe('true');
    expect(bell().querySelector('svg')?.getAttribute('class')).toContain('lucide-bell');
    expect(screen.getByText('3 unread notifications')).toBeTruthy();
    expect(h.fetch).toHaveBeenCalledWith('/api/accounting/notifications');
    cleanup();
    h.fetch.mockResolvedValueOnce(feed([], 150));
    render(<NotificationBell />);
    await waitFor(() => expect(screen.getByTestId('notification-badge').textContent).toBe('99+'));
  });

  it('no badge with nothing unread; the open list says so when empty', async () => {
    h.fetch.mockImplementation(async () => feed([], 0));
    render(<NotificationBell />);
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('notification-badge')).toBeNull();
    fireEvent.click(bell());
    expect(await screen.findByText('No notifications yet')).toBeTruthy();
    expect(bell().getAttribute('aria-expanded')).toBe('true');
  });

  it('opening refreshes and lists the latest; clicking an unread one marks it read, then follows its link', async () => {
    h.fetch.mockResolvedValueOnce(feed([note('a')], 1));
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');
    h.fetch.mockResolvedValueOnce(feed([note('b'), note('a', { readAt: '2026-11-02T09:00:00.000Z' })], 1));
    fireEvent.click(bell());
    const item = await screen.findByRole('button', { name: /Title b/ });
    expect(screen.getByText('Body b')).toBeTruthy();
    h.fetch.mockResolvedValueOnce(ok({ updated: 1 }));
    fireEvent.click(item);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/accounting/budgets/b'));
    const [url, init] = h.fetch.mock.calls[2]! as [string, RequestInit];
    expect(url).toBe('/api/accounting/notifications/read');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ids: ['b'] });
    expect(screen.queryByTestId('notification-badge')).toBeNull();
  });

  it('a read one is followed without another write', async () => {
    h.fetch.mockImplementation(async () => feed([note('a', { readAt: '2026-11-02T09:00:00.000Z' })], 0));
    render(<NotificationBell />);
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole('button', { name: /Title a/ }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith('/accounting/budgets/a'));
    expect(h.fetch.mock.calls.every(([u]) => u === '/api/accounting/notifications')).toBe(true);
  });

  it('a failed mark-read says so and does not navigate or clear the badge', async () => {
    h.fetch.mockResolvedValueOnce(feed([note('a')], 1)).mockResolvedValueOnce(feed([note('a')], 1))
      .mockResolvedValueOnce(fail(500, 'Database unavailable'));
    render(<NotificationBell />);
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole('button', { name: /Title a/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Database unavailable');
    expect(h.push).not.toHaveBeenCalled();
    expect(screen.getByTestId('notification-badge').textContent).toBe('1');
  });

  it('"Mark all read" clears every unread row', async () => {
    h.fetch.mockResolvedValueOnce(feed([note('a'), note('b')], 2)).mockResolvedValueOnce(feed([note('a'), note('b')], 2))
      .mockResolvedValueOnce(ok({ updated: 2 }));
    render(<NotificationBell />);
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.queryByTestId('notification-badge')).toBeNull());
    expect(JSON.parse(String((h.fetch.mock.calls[2]! as [string, RequestInit])[1].body))).toEqual({ all: true });
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });

  it('a failed feed is a sentence in the list (the server\'s own, else a plain one), never "no notifications" or a stale badge', async () => {
    h.fetch.mockResolvedValueOnce(feed([note('a')], 1)).mockResolvedValueOnce(fail(503, 'Service unavailable'));
    render(<NotificationBell />);
    await screen.findByTestId('notification-badge');
    fireEvent.click(bell());
    expect((await screen.findByRole('alert')).textContent).toContain('Service unavailable');
    expect(screen.queryByText('No notifications yet')).toBeNull();
    expect(screen.queryByTestId('notification-badge')).toBeNull();
    expect(screen.queryByRole('button', { name: /Title a/ })).toBeNull();
    cleanup();
    h.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<NotificationBell />);
    fireEvent.click(bell());
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load notifications');
  });

  it('a link that is not an in-app path is never followed', async () => {
    h.fetch.mockImplementation(async () => feed([note('a', { href: '//evil.example', readAt: '2026-11-02T09:00:00.000Z' })], 0));
    render(<NotificationBell />);
    fireEvent.click(bell());
    fireEvent.click(await screen.findByRole('button', { name: /Title a/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Title a/ })).toBeTruthy());
    expect(h.push).not.toHaveBeenCalled();
  });
});
