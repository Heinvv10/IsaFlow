// UXS round 2: the builder data-source and the directives status filter are kit Selects that write the same values; the
// directive modal's close button and the new-contact back links are named (axe button-name / link-name).
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a1Serve';
import { pickKit } from '../../helpers/kitSelect';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
useApiJsonOverMock();

import TaxDirectivesPage from '@/../pages/payroll/tax-directives';
import { CreateTaxDirectiveModal } from '@/components/payroll/TaxDirectiveComponents';
import { ReportBuilderSidebar } from '@/components/accounting/reports/ReportBuilderSidebar';

afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); });

const DATA_SOURCE_VALUES = ['gl_transactions'];

describe('kit selects write the same values', () => {
  it('builder data source: the picked source value reaches onSourceChange', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    const onSourceChange = vi.fn();
    const { container } = render(<ReportBuilderSidebar selectedSource="" selectedFields={[]} onSourceChange={onSourceChange} onAddField={vi.fn()} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    const box = screen.getByRole('combobox', { name: 'Data source' });
    fireEvent.click(box);
    const first = (await screen.findAllByRole('option'))[0]!;
    fireEvent.click(first);
    expect(onSourceChange).toHaveBeenCalledTimes(1);
    expect(onSourceChange.mock.calls[0]![0]).toBe(DATA_SOURCE_VALUES[0]);
  });

  it('builder data source: clearing goes back to no source (onSourceChange(\'\'))', () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    const onSourceChange = vi.fn();
    render(<ReportBuilderSidebar selectedSource="customers" selectedFields={[]} onSourceChange={onSourceChange} onAddField={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(onSourceChange).toHaveBeenLastCalledWith('');
  });

  it('directives status filter: the picked status goes out as the status query', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    render(<TaxDirectivesPage />);
    await pickKit(await screen.findByRole('combobox', { name: 'Status' }), 'Approved');
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('status=approved'))).toBe(true));
  });
});

describe('named controls', () => {
  it('the directive modal close button is named Close', () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    const onClose = vi.fn();
    render(<CreateTaxDirectiveModal onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
