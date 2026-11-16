/**
 * The deadlines table says how an item was filed: "Filed on eFiling" (sent through IsaFlow and
 * accepted by SARS), "Sent to SARS (processing)" (sent, SARS not final), or "Marked submitted" (a
 * user recorded the filing; never claims eFiling). It lists every filing, and a manual mark on the
 * same item shows as "Also marked filed by X" with an Undo. No Mark filed on a filed item. It says
 * so when the filings could not be loaded.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: { ok: boolean }, msg: string) => { if (!res.ok) throw new Error(msg); },
  apiErrorMessage: (_e: unknown, f: string) => f,
}));

import { ComplianceCalendarTable, type CalendarItem } from '@/components/accounting/sars/ComplianceCalendarTable';

const past = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
const base: CalendarItem = {
  eventType: 'EMP201_DUE', dueDate: past, periodStart: '2025-12-01', periodEnd: '2025-12-31', description: 'EMP201 for December 2025',
  status: 'completed',
};
const one = (kind: 'efiled' | 'processing' | 'recorded', f: Partial<{ reference: string | null; submittedAt: string | null; by: string | null }> = {}): CalendarItem =>
  ({ ...base, efiling: { kind, filings: [{ reference: 'SARS-9', submittedAt: '2026-01-05T10:00:00.000Z', by: null, ...f }] } });

beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue({ ok: true, status: 200 }); });

describe('how it was filed', () => {
  it('efiled: "Filed on eFiling" with the reference and date', () => {
    render(<ComplianceCalendarTable events={[one('efiled')]} onChanged={vi.fn()} />);
    expect(screen.getByText('Filed on eFiling')).toBeTruthy();
    expect(screen.getByText(/^Ref SARS-9 · .+/)).toBeTruthy();
  });

  it('processing: "Sent to SARS (processing)", not "Filed on eFiling"', () => {
    render(<ComplianceCalendarTable events={[one('processing')]} onChanged={vi.fn()} />);
    expect(screen.getByText('Sent to SARS (processing)')).toBeTruthy();
    expect(screen.queryByText('Filed on eFiling')).toBeNull();
  });

  it('recorded: "Marked submitted" by the user, never eFiling', () => {
    render(<ComplianceCalendarTable events={[one('recorded', { by: 'Willie' })]} onChanged={vi.fn()} />);
    expect(screen.getByText('Marked submitted')).toBeTruthy();
    expect(screen.getByText(/^by Willie · Ref SARS-9/)).toBeTruthy();
    expect(screen.queryByText(/eFiling/)).toBeNull();
  });

  it('without a reference or date: the badge alone', () => {
    render(<ComplianceCalendarTable events={[one('efiled', { reference: null, submittedAt: null })]} onChanged={vi.fn()} />);
    expect(screen.getByText('Filed on eFiling')).toBeTruthy();
    expect(screen.queryByText(/Ref /)).toBeNull();
  });

  it('several filings: the count and every reference, (no ref) for one without', () => {
    const e: CalendarItem = { ...base, efiling: { kind: 'efiled', filings: [
      { reference: 'A', submittedAt: null, by: null }, { reference: null, submittedAt: null, by: null }] } };
    render(<ComplianceCalendarTable events={[e]} onChanged={vi.fn()} />);
    expect(screen.getByText('2 filings: Ref A; (no ref)')).toBeTruthy();
  });

  it('several filings with one reference: the reference once', () => {
    const e: CalendarItem = { ...base, efiling: { kind: 'efiled', filings: [
      { reference: 'X', submittedAt: null, by: null }, { reference: 'X', submittedAt: null, by: null }] } };
    render(<ComplianceCalendarTable events={[e]} onChanged={vi.fn()} />);
    expect(screen.getByText('2 filings: Ref X')).toBeTruthy();
  });

  it('has no Mark filed and, without a manual mark, no Undo', () => {
    render(<ComplianceCalendarTable events={[one('efiled')]} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mark filed/i })).toBeNull();
  });
});

describe('a filing and a manual mark', () => {
  const both: CalendarItem = { ...one('efiled'), id: 'm1', filedBy: 'Willie', filedAt: '2026-01-02T00:00:00.000Z' };

  it('shows "Also marked filed by" the user, with an Undo that removes the mark', async () => {
    const onChanged = vi.fn();
    render(<ComplianceCalendarTable events={[both]} onChanged={onChanged} />);
    expect(screen.getByText('Filed on eFiling')).toBeTruthy();
    expect(screen.getByText(/Also marked filed by Willie/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [, init] = apiFetch.mock.calls[0]!;
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ eventType: 'EMP201_DUE', periodEnd: '2025-12-31' });
  });
});

describe('unavailable', () => {
  it('says so when the filings could not be loaded', () => {
    render(<ComplianceCalendarTable events={[]} submissionsUnavailable onChanged={vi.fn()} />);
    expect(screen.getByText(/filings could not be loaded/i)).toBeTruthy();
  });
});
