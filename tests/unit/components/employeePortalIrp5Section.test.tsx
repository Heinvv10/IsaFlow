/** Wave 6 SS-c: the portal's tax certificates section. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const replace = vi.fn(async () => true);
vi.mock('next/router', () => ({ useRouter: () => ({ replace, push: replace, pathname: '/employee-portal', events: { on: () => {}, off: () => {} } }) }));

import { Irp5Section } from '@/components/employeePortal/Irp5Section';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let answer: unknown = { payFrequency: 'monthly', certificates: [] };
const fetchMock = vi.fn();
beforeEach(() => {
  replace.mockClear();
  answer = { payFrequency: 'monthly', certificates: [] };
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => json({ success: true, data: answer }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const cert = {
  versionId: 'v1', taxYear: 2026, kind: 'annual', filedAt: '2026-05-31T08:00:00.000Z', certificateNumber: 'CERT-1',
  income: [{ code: '3601', label: 'Salary', amount: 240000 }], deductions: [],
  tax: [{ code: '4102', label: 'PAYE', amount: 30000.5 }],
};

describe('Irp5Section', () => {
  it('says a certificate shows once the employer has filed the EMP501', async () => {
    render(<Irp5Section />);
    expect(await screen.findByText(/once your employer has filed the tax year.s\s+reconciliation \(EMP501\)/)).toBeTruthy();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/employee-portal/irp5');
  });

  it('says weekly pay has no certificate here yet', async () => {
    answer = { payFrequency: 'weekly', certificates: [] };
    render(<Irp5Section />);
    expect(await screen.findByText(/IRP5 certificates for weekly pay are not shown here yet/)).toBeTruthy();
    expect(screen.queryByText(/once your employer has filed/)).toBeNull();
  });

  it('shows each filed certificate with its codes and a named PDF link', async () => {
    answer = { payFrequency: 'monthly', certificates: [cert] };
    render(<Irp5Section />);
    const link = await screen.findByRole('link', { name: 'Download PDF IRP5 copy for tax year 2026, annual' });
    expect(link.getAttribute('href')).toBe('/api/employee-portal/irp5/v1');
    expect(screen.getByRole('heading', { name: 'Tax year 2026: Annual (March to February)' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Income' }).textContent).toContain('3601');
    expect(screen.getByRole('table', { name: 'Tax, UIF and SDL' }).textContent).toContain('4102');
    expect(screen.queryByRole('table', { name: 'Deductions' })).toBeNull();
    expect(screen.getAllByRole('columnheader').every((th) => th.getAttribute('scope') === 'col')).toBe(true);
  });

  it('weekly pay with a filed certificate shows the certificate and no weekly note (review #1649 L1)', async () => {
    answer = { payFrequency: 'weekly', certificates: [cert] };
    render(<Irp5Section />);
    await screen.findByRole('link', { name: /IRP5 copy for tax year 2026/ });
    expect(screen.queryByText(/not shown here yet/)).toBeNull();
  });

  it('a 401 goes to sign in, not an alert (review #1649 L4)', async () => {
    fetchMock.mockImplementation(async () => json({ success: false, error: { message: 'Please sign in again.' } }, 401));
    render(<Irp5Section />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/employee-portal/login'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a loading line, then a named failure', async () => {
    fetchMock.mockImplementation(async () => json({ success: false, error: { message: 'down' } }, 503));
    render(<Irp5Section />);
    expect(screen.getByRole('status').textContent).toMatch(/Loading your tax certificates/);
    expect((await screen.findByRole('alert')).textContent).toBe('down');
  });
});
