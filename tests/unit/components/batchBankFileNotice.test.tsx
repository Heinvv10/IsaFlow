/**
 * AP-01: a batch with an unreleased bank file cannot go to Netcash. The batch page says so, and an owner/admin can
 * release the file with a reason (typed inline) through POST /api/accounting/eft-file-release; anyone else is told
 * who can. A refused release shows the server's message and leaves the notice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const company = vi.hoisted(() => ({ companyRole: 'admin' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));

import { apiFetch } from '@/lib/apiFetch';
import { BatchBankFileNotice } from '@/components/accounting/BatchBankFileNotice';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); company.companyRole = 'admin'; });

const FILE = { bank: 'fnb', generatedBy: 'ann@example.test', generatedAt: '2026-10-20T09:00:00.000Z' };
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST');

describe('BatchBankFileNotice', () => {
  it('renders nothing when the batch has no unreleased bank file', async () => {
    route(() => ok({ bankFile: null }));
    const { container } = render(<BatchBankFileNotice batchId="b1" />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('an admin sees the file, must type a reason, then releases it and the notice goes', async () => {
    let released = false;
    route((_u, method) => {
      if (method === 'POST') { released = true; return ok({ batchId: 'b1', released: 1 }); }
      return ok({ bankFile: released ? null : FILE });
    });
    render(<BatchBankFileNotice batchId="b1" />);
    expect(await screen.findByText(/bank file.*was generated/i)).toBeTruthy();
    expect(screen.getByText(/ann@example.test/)).toBeTruthy();
    expect(document.body.textContent).toContain('A bank file (FNB) was generated for this batch by ann@example.test');
    const button = screen.getByRole('button', { name: /Release bank file/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); // no reason yet
    fireEvent.change(screen.getByLabelText(/Why was the file not used/i), { target: { value: 'Never uploaded to the bank' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText(/bank file.*was generated/i)).toBeNull());
    const [url, init] = posts()[0]!;
    expect(String(url)).toBe('/api/accounting/eft-file-release');
    expect(JSON.parse(String(init?.body))).toEqual({ batchId: 'b1', reason: 'Never uploaded to the bank' });
  });

  it('without a bank on the record it reads "A bank file was generated"', async () => {
    route(() => ok({ bankFile: { ...FILE, bank: null } }));
    render(<BatchBankFileNotice batchId="b1" />);
    expect(await screen.findByText(/A bank file was generated for this batch by ann@example.test/)).toBeTruthy();
  });

  it.each([['owner', true], ['admin', true], ['manager', false], ['bookkeeper', false], [null, false]])(
    'role %s: release control shown = %s', async (role, canRelease) => {
      company.companyRole = role;
      route(() => ok({ bankFile: FILE }));
      render(<BatchBankFileNotice batchId="b1" />);
      expect(await screen.findByText(/bank file.*was generated/i)).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Release bank file/ }) !== null).toBe(canRelease);
      if (!canRelease) expect(screen.getByText(/owner or admin/i)).toBeTruthy();
    });

  it.each([['a refusal', () => bad(), new RegExp(MSG)], ['an empty 500', empty500, /Could not release the bank file - try again/]])(
    '%s shows the message, keeps the notice and never reads as released', async (_n, answer, shown) => {
      route((_u, method) => (method === 'POST' ? answer() : ok({ bankFile: FILE })));
      render(<BatchBankFileNotice batchId="b1" />);
      fireEvent.change(await screen.findByLabelText(/Why was the file not used/i), { target: { value: 'a reason' } });
      fireEvent.click(screen.getByRole('button', { name: /Release bank file/ }));
      expect(await screen.findByText(shown)).toBeTruthy();
      expect(screen.getByText(/bank file.*was generated/i)).toBeTruthy();
      expect(noRawText()).toBe(true);
    });
});
