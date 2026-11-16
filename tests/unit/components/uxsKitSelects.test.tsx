// UXS: the 20 native <select>s of the settings tabs, the report-builder filters, the parallel-run card and the
// tax-directive form are the kit Select. Each one renders as a named combobox (no <select> in the tree) and
// choosing an option reaches the same onChange, with the same value, as the native control did.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { pickKit } from '../../helpers/kitSelect';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import { mapApiCompany } from '@/components/accounting/settings/mapApiCompany';
import { GeneralTab } from '@/components/accounting/settings/GeneralTab';
import { RegionalTab } from '@/components/accounting/settings/RegionalTab';
import { ComplianceTab } from '@/components/accounting/settings/ComplianceTab';
import { VatTab } from '@/components/accounting/settings/VatTab';
import { BrandingTab } from '@/components/accounting/settings/BrandingTab';
import { UdfTab } from '@/components/accounting/settings/UdfTab';
import { FinancialYearStartField } from '@/components/accounting/settings/FinancialYearStartField';
import { ReportBuilderFilters } from '@/components/accounting/reports/ReportBuilderFilters';
import { ParallelRunUploadCard } from '@/components/payroll/parallelRun/ParallelRunUploadCard';
import { DirectiveEmployeeSelect } from '@/components/payroll/TaxDirectiveEmployeeSelect';

const company = { ...mapApiCompany({ id: 'c1', name: 'Demo' }), vatPeriod: 'bi-monthly', vatSystem: 'standard' };
const combo = (name: string | RegExp) => screen.getByRole('combobox', { name });

const emptyList = async (url: unknown) => (String(url).includes('financial-year-end-change')
  ? new Response('{}', { status: 503 }) // the year-end card renders nothing on a failed load
  : new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));
beforeEach(() => { vi.mocked(apiFetch).mockReset().mockImplementation(emptyList); });
afterEach(cleanup);

describe('settings tabs: kit selects, same values out', () => {
  it('General: 5 comboboxes, no <select>; idle timeout is still a NUMBER', async () => {
    const onChange = vi.fn();
    const { container } = render(<GeneralTab company={company} onChange={onChange} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    for (const n of ['Default Currency', 'Idle Timeout', 'Date Format', 'Rounding Type', 'Run Ageing Based On']) combo(n);
    await pickKit(combo('Idle Timeout'), '12 hours');
    expect(onChange).toHaveBeenLastCalledWith('idleTimeoutMinutes', 720);
    await pickKit(combo('Rounding Type'), 'Round Up');
    expect(onChange).toHaveBeenLastCalledWith('roundingType', 'up');
    await pickKit(combo('Default Currency'), /^EUR/);
    expect(onChange).toHaveBeenLastCalledWith('defaultCurrency', 'EUR');
  });

  it('Regional: 3 comboboxes; "None" thousands separator is the empty string, and shows as None', async () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<RegionalTab company={{ ...company, thousandsSeparator: ',' }} onChange={onChange} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await pickKit(combo('Thousands Separator'), 'None');
    expect(onChange).toHaveBeenLastCalledWith('thousandsSeparator', '');
    rerender(<RegionalTab company={{ ...company, thousandsSeparator: '' }} onChange={onChange} />);
    expect(combo('Thousands Separator').textContent).toContain('None');
    await pickKit(combo('Date Format'), /ISO 8601/);
    expect(onChange).toHaveBeenLastCalledWith('dateFormat', 'YYYY-MM-DD');
  });

  it('Compliance: year-end month is a number; CIPC month clears back to null', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({
      success: true, data: { vatEnabled: true, emp201Enabled: true, emp501Enabled: true, cipcEnabled: true, yearEndMonth: 2, cipcAnniversaryMonth: 5 },
    }), { status: 200 }));
    const { container } = render(<ComplianceTab />);
    await waitFor(() => expect(combo('CIPC Anniversary Month').textContent).toContain('May'));
    expect(container.querySelectorAll('select')).toHaveLength(0);
    expect(combo('Financial Year-End Month').textContent).toContain('February');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(combo('CIPC Anniversary Month').textContent).toContain('Select month');
  });

  it('VAT: frequency and bi-monthly alignment', async () => {
    const onChange = vi.fn();
    const { container } = render(<VatTab company={company} onChange={onChange} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await pickKit(combo('VAT Reporting Frequency'), 'Monthly');
    expect(onChange).toHaveBeenLastCalledWith('vatPeriod', 'monthly');
    await pickKit(combo('Bi-Monthly Period Alignment'), /Category B/);
    expect(onChange).toHaveBeenLastCalledWith('vatPeriodAlignment', 'even');
  });

  it('Branding: logo position', async () => {
    const onChange = vi.fn();
    const { container } = render(<BrandingTab company={company} onChange={onChange} onCompanyChange={vi.fn()} onError={vi.fn()} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await pickKit(combo(/Position of Logo/), 'Top Right');
    expect(onChange).toHaveBeenLastCalledWith('logoPosition', 'top-right');
  });

  it('Financial year start: a number, and locked means the trigger is disabled', async () => {
    const onChange = vi.fn();
    const open = { ...company, financialYearStart: 3, financialYearStartActual: 3, financialYearStartLocked: false };
    const { container, rerender } = render(<FinancialYearStartField company={open} onChange={onChange} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await pickKit(combo('Financial Year Start Month'), 'Sep');
    expect(onChange).toHaveBeenLastCalledWith('financialYearStart', 9);
    rerender(<FinancialYearStartField company={{ ...open, financialYearStartLocked: true }} onChange={onChange} />);
    expect(combo('Financial Year Start Month').getAttribute('aria-disabled')).toBe('true');
  });

  it('User fields: every slot type is a named combobox, disabled while the slot is empty', async () => {
    const { container } = render(<UdfTab />);
    for (const name of ['Customer', 'Supplier', 'Invoice', 'Item']) fireEvent.click(screen.getByRole('button', { name: new RegExp(`${name} Fields`) }));
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBe(48));
    expect(container.querySelectorAll('select')).toHaveLength(0);
    expect(combo('Item field 12 type').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('other screens', () => {
  it('report builder filters: field and operator comboboxes keep the reset-on-change behaviour', async () => {
    const onChange = vi.fn();
    const fields = [{ field: 'name', label: 'Name', type: 'text', filterable: true }, { field: 'total', label: 'Total', type: 'number', filterable: true }];
    const { container } = render(<ReportBuilderFilters availableFields={fields}
      filters={[{ id: 'f1', field: '', operator: 'equals', value: 'x', value2: '' }]} onChange={onChange} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await pickKit(combo('Filter field'), 'Total');
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'f1', field: 'total', operator: 'equals', value: '', value2: '' }]);
    await pickKit(combo('Filter operator'), 'Contains');
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'f1', field: '', operator: 'contains', value: '', value2: '' }]);
  });

  it('parallel-run upload: month and year are numbers in the posted form', async () => {
    const { container } = render(<ParallelRunUploadCard onImported={vi.fn()} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await pickKit(combo('Period month'), 'March');
    expect(combo('Period month').textContent).toContain('March');
    const year = String(new Date().getFullYear() - 1);
    await pickKit(combo('Year'), year);
    expect(combo('Year').textContent).toContain(year);
  });

  it('tax directive employee picker: gives the employee id, empty when cleared out', async () => {
    const onChange = vi.fn();
    const employees = [{ id: 'e1', employeeNumber: 'E1', firstName: 'Ann', lastName: 'Lee' }];
    const { container } = render(<DirectiveEmployeeSelect value="" onChange={onChange} employees={employees} loading={false} error="" labelCls="" onRetry={vi.fn()} />);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    await pickKit(combo('Employee'), /Lee, Ann/);
    expect(onChange).toHaveBeenLastCalledWith('e1');
    expect(within(container).getByRole('combobox', { name: 'Employee' })).toBeTruthy();
  });
});
