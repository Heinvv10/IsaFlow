/**
 * PE review #1542 E-S1: a failed slip is retried with a plain send naming the employee (open to a manager; nothing went
 * out), a sent or may-have-been-sent slip is resent only by an owner or admin (resend: a second mail).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { PayslipEmailDeliveries } from '@/components/payroll/PayslipEmailDeliveries';
import { PayslipEmailCard } from '@/components/payroll/PayslipEmailCard';
import type { Delivery } from '@/components/payroll/payslipEmailPayloads';

const row = (n: number, status: Delivery['status']): Delivery => ({
  employeeId: `e${n}`, employeeNumber: `E-${n}`, employeeName: `Name ${n}`, status, recipient: `n${n}@example.invalid`,
  at: '2026-11-17T08:00:00.000Z', attempts: 1,
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PayslipEmailDeliveries', () => {
  it('a manager: Try again on a failed row (and Retry all failed), nothing on sent or unknown rows', () => {
    const onRetry = vi.fn();
    const onResend = vi.fn();
    render(<PayslipEmailDeliveries deliveries={[row(1, 'failed'), row(2, 'failed'), row(3, 'sent'), row(4, 'unknown')]}
      canResend={false} busy={false} onRetry={onRetry} onResend={onResend} />);
    fireEvent.click(screen.getByRole('button', { name: "Try sending Name 1's payslip again" }));
    expect(onRetry).toHaveBeenLastCalledWith(['e1']);
    fireEvent.click(screen.getByRole('button', { name: 'Retry all failed (2)' }));
    expect(onRetry).toHaveBeenLastCalledWith(['e1', 'e2']);
    expect(screen.queryByRole('button', { name: /Send Name 3's payslip again/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Send Name 4's payslip again/ })).toBeNull();
    expect(onResend).not.toHaveBeenCalled();
  });

  it('an owner or admin: Send again on sent and unknown rows', () => {
    const onResend = vi.fn();
    render(<PayslipEmailDeliveries deliveries={[row(3, 'sent'), row(4, 'unknown')]} canResend busy={false} onRetry={vi.fn()} onResend={onResend} />);
    fireEvent.click(screen.getByRole('button', { name: "Send Name 4's payslip again" }));
    expect(onResend).toHaveBeenCalledWith('e4');
  });
});

describe('PayslipEmailCard retry', () => {
  it('a manager retrying a failed row posts a plain send naming the employee, never resend', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/payroll/settings/payslip-email') return ok({ platformEnabled: true, enabled: true });
      if (init?.method === 'POST') return ok({ sent: [{ employeeId: 'e1', employeeNumber: 'E-1', employeeName: 'Name 1', addressChanged: false }], remaining: 0 });
      return ok([row(1, 'failed')]);
    });
    render(<PayslipEmailCard runId="r1" companyRole="manager" />);
    fireEvent.click(await screen.findByRole('button', { name: "Try sending Name 1's payslip again" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(post[0]).toBe('/api/payroll/runs/r1/payslips/email');
    expect(JSON.parse(String(post[1].body))).toEqual({ employeeIds: ['e1'] });
  });
});
