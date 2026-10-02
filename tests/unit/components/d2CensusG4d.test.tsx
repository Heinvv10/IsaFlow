/**
 * D2 census group 4 (d): webhooks, scan-and-fill, journal entries tab, supplier activity tab. A 400 shows the
 * server's message, an empty 500 a plain sentence (never "Unexpected end of JSON input"), a 200 renders.
 * LEFT: onboarding/AccountingTour preference read (best-effort: a failed read already opens the tour, same as a
 * missing preference).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => {
  const value = { activeCompany: { id: 'co-1', name: 'Acme' } }; // stable identity: the page refetches when it changes
  return { useCompany: () => value };
});
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/hooks/useDisplayMode', () => ({ useDisplayMode: () => ({ displayMode: 'normal', setDisplayMode: vi.fn() }) }));
vi.mock('@/components/accounting/DisplayModeToggle', () => ({ DisplayModeToggle: () => null }));
vi.mock('@/components/accounting/webhooks/WebhookForm', () => ({ WebhookForm: () => null }));
vi.mock('@/components/accounting/webhooks/WebhookCard', () => ({
  WebhookCard: (p: { webhook: { name: string }; deliveries?: { eventType: string }[]; testResult?: { body: string }; onToggle: () => void; onTest: () => void }) => (
    <div>
      <span>{p.webhook.name}</span>
      <button onClick={p.onToggle}>expand</button>
      <button onClick={p.onTest}>run test</button>
      {p.deliveries?.map(d => <i key={d.eventType}>{d.eventType}</i>)}
      {p.testResult && <b>{p.testResult.body}</b>}
    </div>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import WebhooksPage from '../../../pages/accounting/webhooks';
import { ScanAndFillButton } from '@/components/accounting/ScanAndFillButton';
import { JournalEntriesTab } from '@/components/accounting/dashboard/JournalEntriesTab';
import { ActivityTab } from '@/components/accounting/suppliers/ActivityTab';
import { MSG, bad, boom, expectNoRawJsonError, ok, trio } from '../helpers/d2CensusG4';

void mockedApiFetchModule;
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(notify.error).mockClear(); vi.mocked(notify.success).mockClear(); });

const HOOKS = [{ id: 'w1', name: 'D2 Hook' }];
const hooks = (u: string) => (u.endsWith('/api/accounting/webhooks') ? ok(HOOKS) : undefined);
const press = async (name: string) => fireEvent.click(await screen.findByRole('button', { name }));

describe('webhooks page', () => {
  trio({ name: 'webhook list', render: () => render(<WebhooksPage />), match: u => u.endsWith('/api/accounting/webhooks'), data: HOOKS,
    plain: 'Could not load the webhooks - try again', success: /D2 Hook/ });
  trio({ name: 'delivery history', render: () => render(<WebhooksPage />), match: u => u.includes('webhook-deliveries'),
    data: [{ eventType: 'invoice.created.777' }], others: hooks, drive: () => press('expand'),
    plain: 'Could not load the delivery history - try again', success: /invoice\.created\.777/ });
  trio({ name: 'test webhook', render: () => render(<WebhooksPage />), match: u => u.includes('webhooks-test'),
    data: { success: true, status: 200, body: 'D2 test body 777' }, others: hooks, drive: () => press('run test'),
    plain: 'Could not send the test webhook - try again', success: /D2 test body 777/ });
});

describe('journal entries tab', () => {
  trio({ name: 'journal entries', render: () => render(<JournalEntriesTab />), match: u => u.includes('journal-entries'),
    data: { entries: [{ id: 'j1', entryNumber: 'JE-D2-777', entryDate: '2031-03-01', description: 'd', source: 'manual', status: 'posted' }] },
    plain: 'Could not load the journal entries - try again', success: /JE-D2-777/ });
});

describe('supplier activity tab', () => {
  trio({ name: 'supplier activities', render: () => render(<ActivityTab supplierId="s-1" />), match: u => u.includes('supplier-activities'),
    data: [{ id: 'a1', supplier_id: 's-1', activity_type: 'note', subject: 'D2 Subject 777', description: 'D2 note', created_at: '2031-03-01T00:00:00Z',
      created_by: 'u', created_by_email: 'u@x.co', created_by_first_name: null, created_by_last_name: null }],
    plain: 'Could not load the activities - try again', success: /D2 Subject 777/ });
});

describe('scan and fill', () => {
  const run = async (extract: () => Response, onExtracted = vi.fn()) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) =>
      String(url).includes('vlm-status') ? ok({ available: true }) : String(url).includes('vlm-extract') ? extract() : ok({}));
    const { container } = render(<ScanAndFillButton onExtracted={onExtracted} />);
    await screen.findByRole('button', { name: /scan & fill/i });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'doc.pdf', { type: 'application/pdf' })] } });
    return onExtracted;
  };
  it('a 400 notifies the server message', async () => {
    const cb = await run(bad);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
    expect(cb).not.toHaveBeenCalled();
  });
  it('an empty 500 notifies a plain sentence, not a JSON parse error', async () => {
    await run(boom);
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not scan the document - try again'));
    expect(vi.mocked(notify.error).mock.calls.flat().join(' ')).not.toMatch(/JSON|Unexpected end/);
  });
  it('a 200 envelope with success:false keeps its own message', async () => {
    await run(() => new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'D2 unreadable scan' } }), { status: 200 }));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('D2 unreadable scan'));
  });
  it('a 200 passes the extraction on and shows its confidence', async () => {
    const cb = await run(() => ok({ extracted: { confidence: 0.91, warnings: [] } }));
    await waitFor(() => expect(cb).toHaveBeenCalledWith({ confidence: 0.91, warnings: [] }));
    expect(await screen.findByText(/91%/)).toBeTruthy();
    expectNoRawJsonError();
  });
});
