/**
 * Change financial year end: the preview hides Next while refused, Apply needs the reason and both notices,
 * and Settings hides the entry when the route refuses (a non-admin gets 403).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import Page from '../../../pages/accounting/financial-year-end-change';
import { YearEndChangeEntry } from '@/components/accounting/settings/YearEndChangeEntry';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const YEAR = { id: 'y1', fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', status: 'open', kind: 'normal', stored: true, months: 12 };
const BASE = { currentYear: YEAR, history: [], undo: { changeId: null, refusals: [] } };
const OPTION = { kind: 'extend', endDate: '2027-06-30', months: 16, newStartMonth: 7, nextYearStart: '2027-07-01' };
const preview = (refusals: string[]) => ({
  currentYear: YEAR, currentStartMonth: 3, options: refusals.length ? [] : [OPTION], chosen: refusals.length ? null : OPTION,
  movingPeriods: [], refusals, effects: ['Periods are re-cut'],
});

function script(refusals: string[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
    ok(String(url).includes('newYearEndMonth') ? { ...BASE, preview: preview(refusals) } : BASE));
}

async function toPreview() {
  render(<Page />);
  fireEvent.change(await screen.findByTestId('new-year-end-month'), { target: { value: '6' } });
  fireEvent.click(screen.getByTestId('step-select-next'));
  await screen.findByTestId('step-preview');
}

describe('change financial year end wizard', () => {
  it('a refusal is shown and there is no Next button', async () => {
    script(['A period is locked.']);
    await toPreview();
    expect(screen.getByTestId('preview-refusals').textContent).toMatch(/A period is locked/);
    expect(screen.queryByTestId('step-preview-next')).toBeNull();
  });

  it('Apply stays disabled until reason and both notices are given', async () => {
    script([]);
    await toPreview();
    expect(screen.getByTestId('preview-months').textContent).toBe('16');
    fireEvent.click(screen.getByTestId('step-preview-next'));
    const apply = (await screen.findByTestId('apply-change')) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('change-reason'), { target: { value: 'Aligning with the group year end' } });
    fireEvent.click(screen.getByTestId('confirm-cipc'));
    expect(apply.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('confirm-sars'));
    expect(apply.disabled).toBe(false);
  });
});

describe('Settings year-end entry', () => {
  it('is hidden when the route answers 403', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'No' } }), { status: 403 }));
    render(<YearEndChangeEntry />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    expect(screen.queryByTestId('year-end-change-entry')).toBeNull();
  });

  it('shows the current year and the link for an admin', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(ok(BASE));
    render(<YearEndChangeEntry />);
    expect((await screen.findByTestId('current-year-end')).textContent).toMatch(/FY2027/);
    expect(screen.getByTestId('change-year-end-link').getAttribute('href')).toBe('/accounting/financial-year-end-change');
  });
});
