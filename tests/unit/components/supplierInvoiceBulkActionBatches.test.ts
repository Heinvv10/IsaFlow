// @vitest-environment happy-dom
import { expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { MAX_POSTED_DOCUMENTS_PER_REQUEST } from '@/lib/limits/authorityHoldLimits';
const fetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', () => ({ apiFetch: fetch }));
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';

// The route refuses more than MAX_POSTED_DOCUMENTS_PER_REQUEST ids (each request holds the company authority key),
// so the bar sends a large selection as sequential batches and reports the batches as one outcome.
const ids = Array.from({ length: 2 * MAX_POSTED_DOCUMENTS_PER_REQUEST + 3 }, (_, i) => `inv-${i}`);
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body });
function mount(onError = vi.fn(), onComplete = vi.fn()) {
  render(createElement(BulkActionBar, { selected: new Set(ids), busy: null, onBusyChange: vi.fn(), onError, onComplete, onClear: vi.fn() }));
  return { onError, onComplete };
}
beforeEach(() => { fetch.mockReset(); vi.stubGlobal('confirm', () => true); });

it('sends a selection larger than the route maximum as sequential batches of at most that many', async () => {
  fetch.mockImplementation(async (_url: string, init: { body: string }) => {
    const batch = (JSON.parse(init.body) as { invoiceIds: string[] }).invoiceIds;
    return reply({ data: { total: batch.length, succeeded: batch.length - 1, failed: 1,
      results: batch.map((invoiceId, i) => ({ invoiceId, ok: i > 0, ...(i > 0 ? {} : { error: 'Synthetic refusal' }) })) } });
  });
  const { onError, onComplete } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  const sent = fetch.mock.calls.map(call => (JSON.parse((call[1] as { body: string }).body) as { invoiceIds: string[] }).invoiceIds);
  expect(sent.map(batch => batch.length)).toEqual([MAX_POSTED_DOCUMENTS_PER_REQUEST, MAX_POSTED_DOCUMENTS_PER_REQUEST, 3]);
  expect(sent.flat()).toEqual(ids);
  expect(onError).toHaveBeenLastCalledWith(`3 of ${ids.length} approves failed: Synthetic refusal`);
});

it('stops at a refused batch and reports the committed batches, their failures included, and what was not attempted', async () => {
  fetch.mockResolvedValueOnce(reply({ data: { total: MAX_POSTED_DOCUMENTS_PER_REQUEST, succeeded: MAX_POSTED_DOCUMENTS_PER_REQUEST - 1, failed: 1,
    results: [{ invoiceId: ids[0]!, ok: false, error: 'Synthetic earlier refusal' }] } }))
    .mockResolvedValueOnce(reply({ error: { message: 'Another change to this company is in progress. Please retry shortly.' } }, false));
  const { onError, onComplete } = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(onError).toHaveBeenLastCalledWith(
    `Another change to this company is in progress. Please retry shortly. — stopped after ${MAX_POSTED_DOCUMENTS_PER_REQUEST} of ${ids.length}: `
    + `${MAX_POSTED_DOCUMENTS_PER_REQUEST - 1} succeeded, 1 failed (Synthetic earlier refusal); the remaining ${ids.length - MAX_POSTED_DOCUMENTS_PER_REQUEST} were not attempted`);
});
