/**
 * W2-28 round 12: a rollback that falls to its one-at-a-time loop stops at a
 * cap per request and reports `remaining`. The button used to disappear after
 * the first answer; with accounts still to go it must stay and say so.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());

import { apiFetch } from '@/lib/apiFetch';
import { RollbackButton } from '@/components/accounting/migration/WizardParts';

void mockedApiFetchModule;
useApiJsonOverMock();

/** Each entry answers one request: a result object (200), or a string — the message of a 503. */
const answers = (...results: (object | string)[]) => {
  const queue = [...results];
  vi.mocked(apiFetch).mockReset().mockImplementation(async () => {
    const next = queue.shift();
    return typeof next === 'string'
      ? new Response(JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: next } }), { status: 503 })
      : new Response(JSON.stringify({ success: true, data: next }), { status: 200 });
  });
};

beforeEach(() => { vi.stubGlobal('confirm', () => true); });
afterEach(() => { cleanup(); });

it('over two passes it reports the TOTALS: what was removed in both, and what the first pass kept', async () => {
  // The first pass retains R3 and untags it, so the second pass never sees it again: only the page can
  // remember it. The final line used to read "Rollback complete — 5 accounts removed".
  answers({ deleted: 999, retained: 1, retainedCodes: ['R3'], remaining: 5 }, { deleted: 5, retained: 0, retainedCodes: [] });
  render(<RollbackButton source="xero" />);
  fireEvent.click(screen.getByRole('button', { name: /rollback import/i }));
  expect(await screen.findByText(/999 accounts removed so far; 5 still to go/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /continue rollback/i }));
  expect(await screen.findByText(/1004 accounts removed in this session; 1 kept because they are in use \(R3\)/)).toBeTruthy();
  // The totals are the page's own: a run made before a reload is not in them, and the screen says so.
  expect(screen.getByText(/cover this session's 2 runs only — a run made before the page was reloaded is not counted/)).toBeTruthy();
  expect(screen.queryByText(/Rollback complete/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('three passes with nothing kept end on the total removed', async () => {
  answers({ deleted: 2000, retained: 0, retainedCodes: [], remaining: 2500 }, { deleted: 2000, retained: 0, retainedCodes: [], remaining: 500 },
    { deleted: 500, retained: 0, retainedCodes: [] });
  render(<RollbackButton source="xero" />);
  fireEvent.click(screen.getByRole('button', { name: /rollback import/i }));
  fireEvent.click(await screen.findByRole('button', { name: /continue rollback/i }));
  expect(await screen.findByText(/4000 accounts removed so far; 500 still to go/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /continue rollback/i }));
  expect(await screen.findByText(/Rollback complete — 4500 accounts removed in this session/)).toBeTruthy();
  expect(screen.getByText(/cover this session's 3 runs only/)).toBeTruthy();
});

it('a rollback done in one request reads as before', async () => {
  answers({ deleted: 3, retained: 1, retainedCodes: ['X300'] });
  render(<RollbackButton source="xero" />);
  fireEvent.click(screen.getByRole('button', { name: /rollback import/i }));
  expect(await screen.findByText(/3 accounts removed; 1 kept because they are in use/)).toBeTruthy();
  expect(screen.queryByText(/this session/)).toBeNull();   // one run: nothing to qualify
});

it('a run that fails mid-way keeps the totals so far, shows the error, and the next run carries on from them', async () => {
  const BUSY = 'The chart of accounts is being changed by another request — retry in a moment.';
  answers({ deleted: 999, retained: 1, retainedCodes: ['R3'], remaining: 5 }, BUSY, { deleted: 5, retained: 0, retainedCodes: [] });
  render(<RollbackButton source="xero" />);
  fireEvent.click(screen.getByRole('button', { name: /rollback import/i }));
  fireEvent.click(await screen.findByRole('button', { name: /continue rollback/i }));
  expect(await screen.findByText(BUSY)).toBeTruthy();
  expect(screen.getByText(/999 accounts removed so far; 5 still to go/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /continue rollback/i }));
  expect(await screen.findByText(/1004 accounts removed in this session; 1 kept because they are in use \(R3\)/)).toBeTruthy();
  expect(screen.getByText(/cover this session's 2 runs only/)).toBeTruthy();   // the failed run removed nothing and is not counted
});
