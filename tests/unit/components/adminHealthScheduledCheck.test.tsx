/**
 * /admin/health says whether the 5-minute scheduled alert check runs (admin audit OP-1, review M2),
 * from the server's record of its last successful pass, judged against the snapshot's own
 * checked_at: under 15 minutes old reads "Scheduled check: last ran <time>"; older, absent, or a
 * server that does not send it reads that alerts only fire while the page is open. When the last
 * alert reached no channel the line adds that it could not be delivered.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import HealthPage from '../../../pages/admin/health';
import { scheduledCheckLastRun } from '@/components/admin/HealthWidgets';
import { formatDisplayTimeSeconds } from '@/utils/dateFormat';

void mockedApiFetchModule;
useApiJsonOverMock();
afterEach(cleanup);

const CHECKED_AT = '2026-11-15T10:00:00.000Z';
const base = {
  db: { status: 'ok', latency_ms: 3, size_mb: 10 },
  job_queue: { pending: 0, running: 0, failed: 0, oldest_pending_age_minutes: null },
  email: { sent_24h: 0, failed_24h: 0, bounced_24h: 0, success_rate_percent: null },
  users_signed_in_24h: 0, trials: { expiring_in_7d: 0 }, recent_errors: [], overall_status: 'healthy', checked_at: CHECKED_AT,
};
const ago = (min: number) => new Date(new Date(CHECKED_AT).getTime() - min * 60_000).toISOString();

function serve(data: unknown) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async () =>
    new Response(JSON.stringify({ success: true, data }), { status: 200 }));
}
const NOT_RUNNING = 'Scheduled check is not running: alerts only fire while this page is open.';
const UNDELIVERED = 'Last alert could not be delivered: check the alert email/webhook settings.';

describe('health page: scheduled check line', () => {
  it('a pass 4 minutes before the snapshot: "last ran" with its time, no delivery warning', async () => {
    serve({ ...base, scheduled_check: { last_run_at: ago(4), last_delivery_failed: false } });
    render(<HealthPage />);
    expect(await screen.findByText(new RegExp(`Scheduled check: last ran ${formatDisplayTimeSeconds(ago(4))}`))).toBeDefined();
    expect(screen.queryByText(new RegExp(NOT_RUNNING))).toBeNull();
    expect(screen.queryByText(/could not be delivered/)).toBeNull();
  });

  it('the last alert reached no channel: "last ran" plus the delivery warning', async () => {
    serve({ ...base, scheduled_check: { last_run_at: ago(4), last_delivery_failed: true } });
    render(<HealthPage />);
    const line = await screen.findByText(/Scheduled check: last ran/);
    expect(line.textContent).toContain(UNDELIVERED);
    expect(line.textContent).not.toContain(NOT_RUNNING);
  });

  it('a pass 16 minutes before the snapshot: not running', async () => {
    serve({ ...base, scheduled_check: { last_run_at: ago(16) } });
    render(<HealthPage />);
    expect(await screen.findByText(new RegExp(NOT_RUNNING))).toBeDefined();
    expect(screen.queryByText(/Scheduled check: last ran/)).toBeNull();
  });

  it('never ran: not running', async () => {
    serve({ ...base, scheduled_check: { last_run_at: null } });
    render(<HealthPage />);
    expect(await screen.findByText(new RegExp(NOT_RUNNING))).toBeDefined();
  });
});

describe('scheduledCheckLastRun', () => {
  it.each([
    [ago(0), true], [ago(14.9), true], [ago(15), false], [ago(60), false],
  ])('last run %s against checked_at: running=%s', (last, running) => {
    expect(scheduledCheckLastRun({ checked_at: CHECKED_AT, scheduled_check: { last_run_at: last } }))
      .toBe(running ? last : null);
  });
  it('absent from an older server, or unparseable: not running', () => {
    expect(scheduledCheckLastRun({ checked_at: CHECKED_AT })).toBeNull();
    expect(scheduledCheckLastRun({ checked_at: CHECKED_AT, scheduled_check: { last_run_at: 'garbage' } })).toBeNull();
  });
});
