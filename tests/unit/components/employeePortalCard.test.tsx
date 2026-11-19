/** EmployeePortalCard (wave 6 SS): what it offers follows the two switches, the login and the viewer's role. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EmployeePortalCard } from '@/components/payroll/EmployeePortalCard';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }), { status });
let settings = { platformEnabled: true, enabled: true };
let access: Record<string, unknown> = { status: 'none', email: null, inviteExpiresAt: null, lastLoginAt: null, accessEnds: null };
const fetchMock = vi.fn();
beforeEach(() => {
  settings = { platformEnabled: true, enabled: true };
  access = { status: 'none', email: null, inviteExpiresAt: null, lastLoginAt: null, accessEnds: null };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/settings/employee-portal')) return json(settings);
    if (init?.method === 'POST') return json({ code: 'CONFLICT', message: 'Add the employee\'s email address first.', details: { reason: 'NO_EMAIL' } }, 409);
    return json(access);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EmployeePortalCard', () => {
  it('says the platform has not switched it on, and offers nothing', async () => {
    settings = { platformEnabled: false, enabled: true };
    render(<EmployeePortalCard employeeId="e1" canEdit />);
    expect(await screen.findByText(/Not available for this company yet/)).toBeTruthy();
    await screen.findByText('Not invited');
    expect(screen.queryByRole('button', { name: 'Invite to portal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
  });
  it('offers an owner or admin the invite and shows the route\'s refusal', async () => {
    render(<EmployeePortalCard employeeId="e1" canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Invite to portal' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/email address first/));
  });
  it('offers a manager nothing to change', async () => {
    access = { ...access, status: 'active', lastLoginAt: '2026-11-17T08:00:00Z' };
    render(<EmployeePortalCard employeeId="e1" canEdit={false} />);
    expect(await screen.findByText('Uses the portal')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows a leaver\'s last day', async () => {
    access = { ...access, status: 'active', accessEnds: '2028-02-29' };
    render(<EmployeePortalCard employeeId="e1" canEdit />);
    expect(await screen.findByText('As a leaver, access ends after 2028-02-29.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End access' })).toBeTruthy();
  });
});
