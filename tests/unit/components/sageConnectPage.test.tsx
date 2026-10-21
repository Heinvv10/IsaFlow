/**
 * The "Import from Sage" page and its hook (useSageConnect) on the async read:
 * starting a read answers at once and the page POLLS /pulls/{id} until the
 * review is in (or the read failed); a refresh resumes a read under way; the
 * password goes to the server once, to start the read, and never again; and an
 * import whose answer never arrived (a 524) does NOT claim nothing changed,
 * while a real refusal does (L6).
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SageConnectPage from '../../../pages/accounting/migration/sage';
import { IMPORT_UNKNOWN, POLL_MS } from '@/components/accounting/migration/sage/useSageConnect';
import { toReview } from '@/modules/accounting/services/sage/sageConnectRequest';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';
import { emptyCompany, sageFixture } from '../services/sage/sageFixture';

useApiJsonOverMock();
const PULL = '33333333-3333-4333-8333-333333333333';
const review = toReview(buildSageTakeOn(sageFixture(), emptyCompany));
const pulling = (progress: string | null) => ok({ pullId: PULL, status: 'pulling', progress, error: null, review: null });
const ready = () => ok({ pullId: PULL, status: 'ready', progress: null, error: null, review });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const bodies = () => vi.mocked(apiFetch).mock.calls.map(([u, i]) => `${String(u)} ${String((i as RequestInit | undefined)?.body ?? '')}`);
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS + 10); });

async function signInAndRead() {
  render(<SageConnectPage />);
  fireEvent.change(await screen.findByLabelText(/email/i), { target: { value: 'owner@acme.test' } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 's3cret!' } });
  fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Read from Sage/ }));
}

describe('Import from Sage: the background read', () => {
  it('polls until the review is in, showing progress, and sends the password only to start the read', async () => {
    let polls = 0;
    script((u, method) => {
      if (u.endsWith('/sage-connect/status')) return ok({ available: true, open: null, priorTakeOn: null });
      if (u.endsWith('/companies')) return ok({ companies: [{ id: 555, name: 'Acme Media (Pty) Ltd' }] });
      if (u.endsWith('/preview') && method === 'POST') return ok({ pullId: PULL, status: 'pulling' });
      if (u.includes(`/pulls/${PULL}`)) return ++polls < 2 ? pulling('Reading customers') : ready();
      return undefined;
    });
    await signInAndRead();
    expect(await screen.findByText('Reading your data from Sage…')).toBeTruthy();
    await tick();
    expect(await screen.findByText('Reading customers')).toBeTruthy();
    await tick();
    expect(await screen.findByText(/Check what will come across from Acme Media/)).toBeTruthy();
    expect(screen.getByText(/this year's income and expenses to date/)).toBeTruthy();
    expect(polls).toBe(2);
    const withPassword = bodies().filter((b) => b.includes('s3cret!'));
    expect(withPassword.map((b) => b.split(' ')[0])).toEqual(['/api/accounting/sage-connect/companies', '/api/accounting/sage-connect/preview']);
  });

  it('a failed read says why and goes back to sign-in', async () => {
    script((u, method) => {
      if (u.endsWith('/sage-connect/status')) return ok({ available: true, open: null, priorTakeOn: null });
      if (u.endsWith('/companies')) return ok({ companies: [{ id: 555, name: 'Acme' }] });
      if (u.endsWith('/preview') && method === 'POST') return ok({ pullId: PULL, status: 'pulling' });
      if (u.includes('/pulls/')) return ok({ pullId: PULL, status: 'failed', progress: null, error: 'Sage did not accept that email address or password.', review: null });
      return undefined;
    });
    await signInAndRead();
    await tick();
    expect(await screen.findByText(/Sage did not accept that email address or password/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Continue/ })).toBeTruthy();
  });

  it('a refresh resumes a read under way', async () => {
    script((u) => {
      if (u.endsWith('/sage-connect/status')) return ok({ available: true, open: { pullId: PULL, status: 'pulling' }, priorTakeOn: null });
      if (u.includes('/pulls/')) return ready();
      return undefined;
    });
    render(<SageConnectPage />);
    expect(await screen.findByText('Reading your data from Sage…')).toBeTruthy();
    await tick();
    expect(await screen.findByText(/Check what will come across/)).toBeTruthy();
  });

  it('keeps polling through a failed poll, backing off', async () => {
    let n = 0;
    script((u) => {
      if (u.endsWith('/sage-connect/status')) return ok({ available: true, open: { pullId: PULL, status: 'pulling' }, priorTakeOn: null });
      if (u.includes('/pulls/')) return ++n === 1 ? new Response('', { status: 502 }) : ready();
      return undefined;
    });
    render(<SageConnectPage />);
    await screen.findByText('Reading your data from Sage…');
    await tick();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2 + 10); });
    expect(await screen.findByText(/Check what will come across/)).toBeTruthy();
  });

  it('a company that already has a take-on is told so, and offered no sign-in', async () => {
    script((u) => (u.endsWith('/sage-connect/status') ? ok({ available: true, open: null, priorTakeOn: 'This company already has its books from Sage.' }) : undefined));
    render(<SageConnectPage />);
    expect(await screen.findByText('This company already has its books from Sage.')).toBeTruthy();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });
});

describe('Import from Sage: the import answer (L6)', () => {
  async function toReviewThenImport(importAnswer: () => Response) {
    script((u, method) => {
      if (u.endsWith('/sage-connect/status')) return ok({ available: true, open: { pullId: PULL, status: 'ready' }, priorTakeOn: null });
      if (u.includes('/pulls/')) return ready();
      if (u.endsWith('/import') && method === 'POST') return importAnswer();
      return undefined;
    });
    render(<SageConnectPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Import into IsaFlow/ }));
  }

  it('a 524 (no answer) does not claim nothing changed: it says to refresh and check', async () => {
    await toReviewThenImport(() => new Response('<html>A timeout occurred</html>', { status: 524 }));
    expect(await screen.findByText(IMPORT_UNKNOWN)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Nothing was changed');
  });

  it('a network error says the same', async () => {
    await toReviewThenImport(() => { throw new TypeError('Failed to fetch'); });
    expect(await screen.findByText(IMPORT_UNKNOWN)).toBeTruthy();
  });

  it('a refusal from the server says nothing was changed, and lists the issues', async () => {
    await toReviewThenImport(() => new Response(JSON.stringify({ success: false, error: { message: 'IsaFlow could not take on every item.', details: { issues: [{ severity: 'error', area: 'receivables', message: 'D2 bad row' }] } } }), { status: 400 }));
    expect(await screen.findByText('IsaFlow could not take on every item. Nothing was changed.')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('D2 bad row')).toBeTruthy());
  });
});
