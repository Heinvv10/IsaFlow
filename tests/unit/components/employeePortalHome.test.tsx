/** The employee portal home and its fetch helper (wave 6 SS, review #1576 M3, L2, L3, L4). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const replace = vi.fn(async () => true);
vi.mock('next/router', () => ({ useRouter: () => ({ replace, push: replace, pathname: '/employee-portal', events: { on: () => {}, off: () => {} } }) }));

import EmployeePortalHome from '../../../pages/employee-portal/index';
import { portalCall, PortalCallError } from '@/components/employeePortal/portalFetch';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let slips: unknown[] = [];
let logoutFails = false;
const fetchMock = vi.fn();
beforeEach(() => {
  slips = [];
  logoutFails = false;
  replace.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/me')) return json({ success: true, data: { employeeName: 'Zola Portal', employeeNumber: 'Z1', employer: 'Acme' } });
    if (url.endsWith('/payslips')) return json({ success: true, data: slips });
    if (url.endsWith('/leave')) return json({ success: true, data: [] });
    if (url.endsWith('/logout')) return logoutFails ? json({ success: false, error: { message: 'down' } }, 503) : json({ success: true, data: { signedIn: false } });
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('employee portal home', () => {
  it('says earlier payslips come from the employer when the list is empty (ruling 2)', async () => {
    render(<EmployeePortalHome />);
    expect(await screen.findByText(/earlier payslips are available from your employer/)).toBeTruthy();
    expect(screen.queryByRole('table', { name: /payslips/ })).toBeNull();
  });

  it('shows a loading line until the reads answer', async () => {
    render(<EmployeePortalHome />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading/);
    await screen.findByText(/earlier payslips/);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names each download by its visible text plus the month (WCAG 2.5.3), in a captioned table', async () => {
    slips = [{ runId: 'r1', periodYear: 2026, periodMonth: 10, runDate: null, netPay: 100 }];
    render(<EmployeePortalHome />);
    const link = await screen.findByRole('link', { name: 'Download PDF for October 2026' });
    expect(link.textContent?.startsWith('Download PDF')).toBe(true);
    expect(link.getAttribute('aria-label')).toBeNull();
    expect(screen.getByRole('table', { name: 'Your payslips, newest first' })).toBeTruthy();
    expect(screen.getAllByRole('columnheader').every((th) => th.getAttribute('scope') === 'col')).toBe(true);
  });

  it('goes to sign in even when the sign-out call fails', async () => {
    logoutFails = true;
    render(<EmployeePortalHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/employee-portal/login'));
  });
});

describe('portalCall', () => {
  it('throws on a 2xx with no data, naming what failed', async () => {
    fetchMock.mockImplementation(async () => json({ success: true }));
    await expect(portalCall('/api/employee-portal/payslips', 'Could not load your details.')).rejects.toSatisfy(
      (e: unknown) => e instanceof PortalCallError && e.message === 'Could not load your details.',
    );
  });
});
