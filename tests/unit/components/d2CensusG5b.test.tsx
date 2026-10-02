// Census group 5 (admin, archiving, SARS, AFS): a 4xx shows the server's message, an empty 5xx body shows a
// plain sentence (never "Unexpected end of JSON input"), and a 200 envelope still renders its data.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => { const value = { activeCompany: { id: 'co-1' } }; return { useCompany: () => value }; });
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: 'owner' } }) }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/accounting/sars/SubmissionDetailModal', () => ({
  SubmissionDetailModal: ({ detail }: { detail: { notes: string | null } | null }) => (detail ? <div>MODAL {detail.notes}</div> : null),
}));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import EmailLogPage from '../../../pages/admin/email-log';
import JobQueuePage from '../../../pages/admin/job-queue';
import DataArchivingPage from '../../../pages/accounting/data-archiving';
import SubmissionsPage from '../../../pages/accounting/sars/submissions';
import { AfsReviewTab } from '../../../src/components/accounting/afs/AfsReviewTab';

const MSG = 'D2 server says no: not allowed here';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refused = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });
const bodyText = () => document.body.textContent ?? '';
const noParserText = () => expect(bodyText()).not.toMatch(/JSON|Unexpected end/);
type Match = (url: string, init?: RequestInit) => boolean;
function script(match: Match, main: () => Response) {
  vi.mocked(apiFetch).mockImplementation(async (u: unknown, init?: RequestInit) => (match(String(u), init) ? main() : ok({})));
}

describe('admin email log load', () => {
  const m: Match = u => u.includes('/api/admin/email-log');
  const data = { items: [{ id: 'e1', company_id: null, company_name: null, recipient_email: 'd2-recipient@example.com', subject: 'S', email_type: 'other', status: 'sent', error_message: null, sent_at: '2026-01-01T00:00:00Z', sent_by: null }],
    total: 1, page: 1, limit: 25, stats: { total_sent: 1, total_failed: 0, success_rate: 100 } };
  it('shows the server message on a 400', async () => { script(m, refused); render(<EmailLogPage />); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('shows a plain sentence on an empty 500', async () => {
    script(m, empty500); render(<EmailLogPage />);
    await waitFor(() => expect(bodyText()).toContain('Could not load the email log')); noParserText();
  });
  it('renders the rows on a 200', async () => { script(m, () => ok(data)); render(<EmailLogPage />); await waitFor(() => expect(bodyText()).toContain('d2-recipient@example.com')); });
});

describe('admin job queue', () => {
  const list: Match = u => u.includes('/api/admin/job-queue?');
  const job = { id: 'j1', company_id: null, job_type: 'd2_job_type', payload: {}, status: 'failed', priority: 0, attempts: 1, max_attempts: 3,
    scheduled_at: '2026-01-01T00:00:00Z', started_at: null, completed_at: null, error_message: null, result: null, created_at: '2026-01-01T00:00:00Z' };
  it('load: shows the server message on a 400', async () => { script(list, refused); render(<JobQueuePage />); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('load: shows a plain sentence on an empty 500', async () => {
    script(list, empty500); render(<JobQueuePage />);
    await waitFor(() => expect(bodyText()).toContain('Could not load the job queue')); noParserText();
  });
  it('load: renders the jobs on a 200', async () => { script(list, () => ok({ jobs: [job], total: 1 })); render(<JobQueuePage />); await waitFor(() => expect(bodyText()).toContain('d2_job_type')); });

  const bulk: Match = u => u.includes('/bulk-action');
  const withJob = (main: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async (u: unknown) => (String(u).includes('/bulk-action') ? main() : ok({ jobs: [job], total: 1 })));
  };
  it('bulk retry: toast shows the server message on a 400', async () => {
    withJob(refused); render(<JobQueuePage />);
    fireEvent.click(await screen.findByText('d2_job_type')); fireEvent.click(await screen.findByText('Retry Selected'));
    await waitFor(() => expect(bodyText()).toContain(MSG));
  });
  it('bulk retry: toast shows a plain sentence on an empty 500', async () => {
    withJob(empty500); render(<JobQueuePage />);
    fireEvent.click(await screen.findByText('d2_job_type')); fireEvent.click(await screen.findByText('Retry Selected'));
    await waitFor(() => expect(bodyText()).toContain('Could not retry the jobs - try again')); noParserText();
  });
  it('bulk retry: toast reports the result on a 200', async () => {
    withJob(() => ok({ processed: 7, errors: [] })); render(<JobQueuePage />);
    fireEvent.click(await screen.findByText('d2_job_type')); fireEvent.click(await screen.findByText('Retry Selected'));
    await waitFor(() => expect(bodyText()).toContain('Retried 7 job(s)'));
  });
  it('delete old: toast shows the server message on a 400', async () => {
    script(bulk, refused); render(<JobQueuePage />); fireEvent.click(await screen.findByText(/Delete Old Jobs/));
    await waitFor(() => expect(bodyText()).toContain(MSG));
  });
  it('delete old: toast shows a plain sentence on an empty 500', async () => {
    script(bulk, empty500); render(<JobQueuePage />); fireEvent.click(await screen.findByText(/Delete Old Jobs/));
    await waitFor(() => expect(bodyText()).toContain('Could not delete the old jobs')); noParserText();
  });
  it('delete old: toast reports the result on a 200', async () => {
    script(bulk, () => ok({ processed: 9 })); render(<JobQueuePage />); fireEvent.click(await screen.findByText(/Delete Old Jobs/));
    await waitFor(() => expect(bodyText()).toContain('Deleted 9 old job(s)'));
  });
});

describe('data archiving', () => {
  // Every other mount request gets its own valid empty envelope, so only the request under test fails.
  const script = (match: Match, main: () => Response) => vi.mocked(apiFetch).mockImplementation(async (u: unknown) => {
    const url = String(u);
    if (match(url)) return main();
    if (url.includes('archive-runs')) return ok({ runs: [] });
    if (url.includes('archived-data')) return ok({ items: [], total: 0 });
    return ok({ stats: [], validation: { valid: true, errors: [] }, preview: null });
  });
  const stats: Match = u => u === '/api/accounting/data-archiving';
  const runs: Match = u => u.includes('archive-runs');
  const validate: Match = u => u.includes('action=validate');
  const statRows = { stats: [{ tableName: 'd2_stat_table', rowCount: 4242, oldestDate: null, newestDate: null }] };
  const runRows = { runs: [{ id: 'r1', cutoffDate: '2019-03-31', status: 'completed', entriesArchived: 1, linesArchived: 1, transactionsArchived: 1, invoicesArchived: 1, supplierInvoicesArchived: 1, startedAt: null, completedAt: null, errorMessage: null, createdAt: '2026-01-01T00:00:00Z' }] };
  it('stats: shows the server message on a 400', async () => { script(stats, refused); render(<DataArchivingPage />); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('stats: shows a plain sentence on an empty 500', async () => {
    script(stats, empty500); render(<DataArchivingPage />);
    await waitFor(() => expect(bodyText()).toContain('Could not load storage stats')); noParserText();
  });
  it('stats: renders the table on a 200', async () => { script(stats, () => ok(statRows)); render(<DataArchivingPage />); await waitFor(() => expect(bodyText()).toContain('d2_stat_table')); });
  it('history: shows the server message on a 400', async () => { script(runs, refused); render(<DataArchivingPage />); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('history: shows a plain sentence on an empty 500', async () => {
    script(runs, empty500); render(<DataArchivingPage />);
    await waitFor(() => expect(bodyText()).toContain('Could not load archive history')); noParserText();
  });
  it('history: renders the run on a 200', async () => { script(runs, () => ok(runRows)); render(<DataArchivingPage />); await waitFor(() => expect(bodyText()).toContain('2019-03-31')); });
  async function runValidate(main: () => Response) {
    script(validate, main); const { container } = render(<DataArchivingPage />);
    fireEvent.change(container.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2019-03-31' } });
    fireEvent.click(await screen.findByRole('button', { name: /Validate/ }));
  }
  it('validate: shows the server message on a 400', async () => { await runValidate(refused); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('validate: shows a plain sentence on an empty 500', async () => {
    await runValidate(empty500); await waitFor(() => expect(bodyText()).toContain('Could not validate the cutoff date')); noParserText();
  });
  it('validate: renders the result on a 200', async () => { await runValidate(() => ok({ validation: { valid: false, errors: ['D2 cutoff too recent'] } })); await waitFor(() => expect(bodyText()).toContain('D2 cutoff too recent')); });
});

describe('SARS submissions view detail', () => {
  const sub = { id: 's1', formType: 'VAT201', periodStart: '2026-01-01', periodEnd: '2026-01-31', status: 'draft', formData: {}, submissionReference: null,
    submittedAt: null, notes: 'local copy', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', submittedBy: null };
  function open(detail: () => Response) {
    vi.mocked(apiFetch).mockImplementation(async (_u: unknown, init?: RequestInit) => (init?.method === 'POST' ? detail() : ok({ items: [sub] })));
    render(<SubmissionsPage />);
  }
  it('shows the server message on a 400 and still opens the local copy', async () => {
    open(refused); fireEvent.click(await screen.findByText('View'));
    await waitFor(() => expect(bodyText()).toContain(MSG)); expect(bodyText()).toContain('MODAL local copy');
  });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); fireEvent.click(await screen.findByText('View'));
    await waitFor(() => expect(bodyText()).toContain('Could not load the submission details')); noParserText();
  });
  it('opens the server detail on a 200', async () => {
    open(() => ok({ ...sub, notes: 'D2 server detail' })); fireEvent.click(await screen.findByText('View'));
    await waitFor(() => expect(bodyText()).toContain('MODAL D2 server detail'));
  });
});

describe('AFS review tab comments', () => {
  const section = { id: 'sec1', sectionType: 'balance_sheet', status: 'draft' };
  const sections = { document: { sections: [section] } };
  function mount(comments: () => Response) {
    vi.mocked(apiFetch).mockImplementation(async (u: unknown) => (String(u).includes('/comments') ? comments() : ok(sections)));
    render(<AfsReviewTab documentId="doc-1" doc={null} onDocUpdate={vi.fn()} />);
  }
  it('shows the server message on a 400', async () => { mount(refused); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('shows a plain sentence on an empty 500', async () => {
    mount(empty500); await waitFor(() => expect(bodyText()).toContain('Could not load comments')); noParserText();
  });
  it('renders the comments on a 200', async () => {
    mount(() => ok({ items: [{ id: 'c1', body: 'D2 review comment', createdAt: '2026-01-01T00:00:00Z', resolved: false }] }));
    await waitFor(() => expect(bodyText()).toContain('D2 review comment'));
  });
});
