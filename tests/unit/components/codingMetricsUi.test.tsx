/**
 * Learning-loop UI: the bank-transactions strip's plain labels, the bureau panel (total row only when the
 * API sends one), and the sharing switch (owner-only, consent wording marked as a draft on screen).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodingMetricsStrip } from '@/components/accounting/bank-transactions/CodingMetricsStrip';
import { BureauCodingMetricsPanel } from '@/components/bureau/BureauCodingMetricsPanel';
import { BureauSharingConsent } from '@/components/bureau/BureauSharingConsent';
import { computeCodingMetrics, type CompanyCodingCounts } from '@/modules/accounting/services/bank/codingMetrics';
import { SHARING_CONSENT_STATUS_LABEL } from '@/modules/bureau/services/sharingConsentCopy';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

const counts = (over: Partial<CompanyCodingCounts>): CompanyCodingCounts => ({
  companyId: 'c1', linesCoded: 0, linesAutoCoded: 0, suggestionsDecided: 0, suggestionsAccepted: 0, autoPosted: 0,
  autoPostedReversed: 0, firstBatchAt: null, firstLineAt: null, firstWindowDecided: 0, firstWindowAccepted: 0,
  decisionLogSince: null, ...over,
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { cleanup(); apiFetch.mockReset(); });

describe('CodingMetricsStrip', () => {
  it('says how many lines ISAFlow coded with no clicks, and how often suggestions were accepted', async () => {
    apiFetch.mockResolvedValue(ok({
      minDecisions: 20,
      metrics: computeCodingMetrics(counts({
        linesCoded: 100, linesAutoCoded: 78, suggestionsDecided: 50, suggestionsAccepted: 32,
        decisionLogSince: '2026-10-21T08:00:00.000Z',
      })),
    }));
    render(<CodingMetricsStrip />);
    expect(await screen.findByText('Auto-coded by ISAFlow: 78% of lines this month (no clicks)')).toBeTruthy();
    expect(screen.getByText('Suggestions accepted: 64% this month (since 21 Oct 2026)')).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith('/api/accounting/coding-metrics', expect.anything());
  });

  it('below the minimum it says there is not enough data yet', async () => {
    apiFetch.mockResolvedValue(ok({ minDecisions: 20, metrics: computeCodingMetrics(counts({ suggestionsDecided: 3, suggestionsAccepted: 3 })) }));
    render(<CodingMetricsStrip />);
    expect(await screen.findByText(/Suggestions accepted: not enough data yet \(3 of 20 decisions this month\)/)).toBeTruthy();
    expect(screen.getByText('Auto-coded by ISAFlow: no lines coded this month yet')).toBeTruthy();
  });

  it('a failed load says so', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ success: false, error: { message: 'nope' } }), { status: 500 }));
    render(<CodingMetricsStrip />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('BureauCodingMetricsPanel', () => {
  const client = { companyId: 'c1', companyName: 'Client A', metrics: computeCodingMetrics(counts({ linesCoded: 10, linesAutoCoded: 4 })) };

  it('owner / accountant: per-client rows and the total', async () => {
    apiFetch.mockResolvedValue(ok({ minDecisions: 20, clients: [client], total: client.metrics }));
    render(<BureauCodingMetricsPanel bureauId="b1" />);
    expect(await screen.findByText('Client A')).toBeTruthy();
    expect(screen.getByText('All clients')).toBeTruthy();
    expect(screen.getAllByText('40% of 10')).toHaveLength(2);
  });

  it('viewer (total null): per-client rows only', async () => {
    apiFetch.mockResolvedValue(ok({ minDecisions: 20, clients: [client], total: null }));
    render(<BureauCodingMetricsPanel bureauId="b1" />);
    expect(await screen.findByText('Client A')).toBeTruthy();
    expect(screen.queryByText('All clients')).toBeNull();
  });
});

describe('a 200 without the expected shape', () => {
  it('renders nothing instead of taking the page down', async () => {
    apiFetch.mockImplementation(async () => ok({})); // a fresh Response per call: a body reads once
    const { container } = render(<div><CodingMetricsStrip /><BureauCodingMetricsPanel bureauId="b1" /><p>page body</p></div>);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe('page body');
  });
});

describe('BureauSharingConsent', () => {
  const base = { enabled: false, saving: false, history: [], onChange: vi.fn() };

  it('shows the draft label and the key promises', () => {
    render(<BureauSharingConsent {...base} canEdit />);
    expect(screen.getByText(SHARING_CONSENT_STATUS_LABEL)).toBeTruthy();
    expect(screen.getByText(/appear at 5 or more ISAFlow client companies/)).toBeTruthy();
    expect(screen.getByText(/past and future coding/)).toBeTruthy();
    expect(screen.getByText(/never posts them automatically/)).toBeTruthy();
  });

  it('the owner can switch it on', () => {
    const onChange = vi.fn();
    render(<BureauSharingConsent {...base} canEdit onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('anyone else sees a disabled switch and why', () => {
    render(<BureauSharingConsent {...base} canEdit={false} />);
    expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Only the bureau owner can change this setting.')).toBeTruthy();
  });
});
