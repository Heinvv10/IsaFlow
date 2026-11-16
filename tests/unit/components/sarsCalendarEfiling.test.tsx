/**
 * The deadlines table shows an item IsaFlow filed as "Filed on eFiling" (its reference and date when
 * present), distinct from a manual "Marked filed", with no Undo and no Mark filed; and it says so
 * when IsaFlow's own filings could not be loaded.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), assertOk: vi.fn(), apiErrorMessage: (_e: unknown, f: string) => f }));

import { ComplianceCalendarTable, type CalendarItem } from '@/components/accounting/sars/ComplianceCalendarTable';

const past = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
const efiled: CalendarItem = {
  eventType: 'EMP201_DUE', dueDate: past, periodStart: '2025-12-01', periodEnd: '2025-12-31', description: 'EMP201 for December 2025',
  status: 'completed', efiling: { reference: 'SARS-9', submittedAt: '2026-01-05T10:00:00.000Z' },
};

describe('a return IsaFlow filed', () => {
  it('reads "Filed on eFiling" with the reference and date, not "Marked filed"', () => {
    render(<ComplianceCalendarTable events={[efiled]} onChanged={vi.fn()} />);
    expect(screen.getByText('Filed on eFiling')).toBeTruthy();
    expect(screen.getByText(/^Ref SARS-9 · .+/)).toBeTruthy();
    expect(screen.queryByText('Marked filed')).toBeNull();
  });

  it('without a reference or date: the badge alone', () => {
    render(<ComplianceCalendarTable events={[{ ...efiled, efiling: { reference: null, submittedAt: null } }]} onChanged={vi.fn()} />);
    expect(screen.getByText('Filed on eFiling')).toBeTruthy();
    expect(screen.queryByText(/Ref /)).toBeNull();
  });

  it('has no Undo and no Mark filed', () => {
    render(<ComplianceCalendarTable events={[efiled]} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /mark filed/i })).toBeNull();
  });

  it('says so when IsaFlow filings could not be loaded', () => {
    render(<ComplianceCalendarTable events={[]} submissionsUnavailable onChanged={vi.fn()} />);
    expect(screen.getByText(/filings could not be loaded/i)).toBeTruthy();
  });
});
