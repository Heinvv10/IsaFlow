/**
 * AP-01: an owner/admin releases a Netcash claim from the submissions page: choose what was found at Netcash, type the
 * required note inline, and POST /api/accounting/netcash/resolve. A pending/unknown row offers both outcomes; a
 * submitted/processing row (Netcash accepted it) offers "failed" only, warns that freeing it can pay the batch twice,
 * and shows the last poll's answer as context - never as the reason it may be freed (round 9). Anyone else, and a
 * completed or failed row, gets no control.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { canResolveSubmission, NetcashResolveForm } from '@/components/accounting/NetcashResolveControl';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(cleanup);

const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST');
const typeNote = (v: string) => fireEvent.change(screen.getByLabelText(/What did you find at Netcash/i), { target: { value: v } });
const form = (status: string, extra: Partial<Parameters<typeof NetcashResolveForm>[0]> = {}) => {
  const onResolved = vi.fn();
  const onClose = vi.fn();
  render(<NetcashResolveForm submissionId="s1" status={status} lastPoll={null} onResolved={onResolved} onClose={onClose} {...extra} />);
  return { onResolved, onClose };
};
const WARNING = /paid twice/i;

describe('NetcashResolveForm', () => {
  it('an unknown claim: picks what Netcash has, types a note, confirms; onClose and onResolved run', async () => {
    route(() => ok({ submissionId: 's1', status: 'failed' }));
    const { onResolved, onClose } = form('unknown');
    expect(screen.getByLabelText(/Netcash has this batch/i)).toBeTruthy();
    expect(screen.queryByText(WARNING)).toBeNull();
    const confirm = screen.getByRole('button', { name: /Confirm/ }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // no outcome, no note
    fireEvent.click(screen.getByLabelText(/never received this batch/i));
    expect(confirm.disabled).toBe(true); // no note
    typeNote('Checked the portal: not there');
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/netcash/resolve');
    expect(JSON.parse(String(init?.body))).toEqual({ submissionId: 's1', outcome: 'failed', note: 'Checked the portal: not there' });
  });

  it('"Netcash has it" on a pending claim resolves as submitted', async () => {
    route(() => ok({}));
    form('pending');
    fireEvent.click(screen.getByLabelText(/Netcash has this batch/i));
    typeNote('It is in the portal');
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]?.body)).outcome).toBe('submitted');
  });

  it.each(['submitted', 'processing'])('a %s row: "failed" only, a double-payment warning, and the last poll shown as context', async (status) => {
    route(() => ok({}));
    form(status, { lastPoll: { status: 'Processing - 0 errors', at: '2026-10-20T10:00:00.000Z' } });
    expect(screen.getByText(WARNING)).toBeTruthy();
    expect(screen.getByText(/Processing - 0 errors/)).toBeTruthy();
    expect(screen.queryByLabelText(/Netcash has this batch/i)).toBeNull();
    fireEvent.click(screen.getByLabelText(/never received this batch|rejected it/i));
    typeNote('Portal shows the batch rejected');
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]?.body)).outcome).toBe('failed');
  });

  it('a submitted row never polled says so', () => {
    route(() => ok({}));
    form('submitted');
    expect(screen.getByText(WARNING)).toBeTruthy();
    expect(screen.getByText(/not been checked/i)).toBeTruthy();
  });

  it.each([['a refusal', () => bad(), new RegExp(MSG)], ['an empty 500', empty500, /Could not resolve the submission - try again/]])(
    '%s shows the message, keeps the form open and never calls onResolved', async (_n, answer, shown) => {
      route(() => answer());
      const { onResolved, onClose } = form('unknown');
      fireEvent.click(screen.getByLabelText(/never received this batch/i));
      typeNote('a note');
      fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
      expect(await screen.findByText(shown)).toBeTruthy();
      expect(screen.getByLabelText(/What did you find at Netcash/i)).toBeTruthy();
      expect(onResolved).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(noRawText()).toBe(true);
    });

  it('Cancel closes the form without a request', () => {
    route(() => ok({}));
    const { onClose } = form('unknown');
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(0);
  });
});

describe('canResolveSubmission', () => {
  it.each([
    ['owner', 'pending', true], ['admin', 'unknown', true], ['admin', 'submitted', true], ['owner', 'processing', true],
    ['admin', 'completed', false], ['admin', 'failed', false],
    ['manager', 'unknown', false], ['viewer', 'submitted', false], [null, 'unknown', false],
  ] as const)('%s on a %s row: %s', (role, status, allowed) => {
    expect(canResolveSubmission(role, status)).toBe(allowed);
  });
});
