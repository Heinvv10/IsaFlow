// UXS round 1: what each converted select WRITES. Every case drives a real pick and reads the payload / onChange value,
// so a mutation that changes the type or the value of a pick (Number(v) -> 1, a fixed 'text', 'zzz') goes red.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { pickKit } from '../../helpers/kitSelect';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import { mapApiCompany } from '@/components/accounting/settings/mapApiCompany';
import { GeneralTab } from '@/components/accounting/settings/GeneralTab';
import { RegionalTab } from '@/components/accounting/settings/RegionalTab';
import { ComplianceTab } from '@/components/accounting/settings/ComplianceTab';
import { BrandingTab } from '@/components/accounting/settings/BrandingTab';
import { UdfTab } from '@/components/accounting/settings/UdfTab';
import { ParallelRunUploadCard } from '@/components/payroll/parallelRun/ParallelRunUploadCard';

const company = mapApiCompany({ id: 'c1', name: 'Demo' });
const combo = (name: string | RegExp) => screen.getByRole('combobox', { name });
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const sent = (method: string) => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes('financial-year-end-change') ? new Response('{}', { status: 503 }) : json([])));
});
afterEach(cleanup);

describe('compliance: months are numbers in the saved body', () => {
  const stored = { vatEnabled: true, emp201Enabled: true, emp501Enabled: true, cipcEnabled: true, yearEndMonth: 2, cipcAnniversaryMonth: 5 };
  const serve = () => vi.mocked(apiFetch).mockImplementation(async (_u, init) => json(init ? JSON.parse(String((init as RequestInit).body)) : stored));
  const put = () => JSON.parse(String((sent('PUT')[0]![1] as RequestInit).body)) as Record<string, unknown>;

  it('year-end month and CIPC month go out as numbers; clearing CIPC goes out as null', async () => {
    serve();
    render(<ComplianceTab />);
    await waitFor(() => expect(combo('CIPC Anniversary Month').textContent).toContain('May'));
    await pickKit(combo('Financial Year-End Month'), 'June');
    await pickKit(combo('CIPC Anniversary Month'), 'March');
    fireEvent.click(screen.getByRole('button', { name: /Save Obligations/ }));
    await waitFor(() => expect(sent('PUT')).toHaveLength(1));
    expect(put().yearEndMonth).toBe(6);
    expect(put().cipcAnniversaryMonth).toBe(3);
    cleanup();
    vi.mocked(apiFetch).mockClear();
    serve();
    render(<ComplianceTab />);
    await waitFor(() => expect(combo('CIPC Anniversary Month').textContent).toContain('May'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    fireEvent.click(screen.getByRole('button', { name: /Save Obligations/ }));
    await waitFor(() => expect(sent('PUT')).toHaveLength(1));
    expect(put().yearEndMonth).toBe(2);
    expect(put().cipcAnniversaryMonth).toBeNull();
  });
});

describe('parallel-run upload: month and year are numbers in the posted body', () => {
  it('posts the picked period', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ import: { id: 'i1' }, rowErrors: [] }));
    const onImported = vi.fn();
    const { container } = render(<ParallelRunUploadCard onImported={onImported} />);
    const year = new Date().getFullYear() - 1;
    await pickKit(combo('Period month'), 'March');
    await pickKit(combo('Year'), String(year));
    const file = new File(['employee_number,gross\nE1,100'], 'p.csv', { type: 'text/csv' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    await waitFor(() => expect(sent('POST')).toHaveLength(1));
    const body = JSON.parse(String((sent('POST')[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.periodMonth).toBe(3);
    expect(body.periodYear).toBe(year);
  });
});

describe('user fields: the picked type is what is saved', () => {
  it('Number is saved as number, Yes / No as boolean', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => json(init ? JSON.parse(String((init as RequestInit).body)) : []));
    render(<UdfTab />);
    fireEvent.click(screen.getByRole('button', { name: /Customer Fields/ }));
    const label = await screen.findByLabelText('Customer field 1 label');
    fireEvent.change(label, { target: { value: 'Region' } });
    fireEvent.change(screen.getByLabelText('Customer field 2 label'), { target: { value: 'Active' } });
    await pickKit(combo('Customer field 1 type'), 'Number');
    await pickKit(combo('Customer field 2 type'), 'Yes / No');
    fireEvent.click(screen.getByRole('button', { name: 'Save Customer Fields' }));
    await waitFor(() => expect(sent('POST')).toHaveLength(2));
    const bodies = sent('POST').map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { fieldNumber: number; fieldType: string });
    expect(bodies.find(b => b.fieldNumber === 1)!.fieldType).toBe('number');
    expect(bodies.find(b => b.fieldNumber === 2)!.fieldType).toBe('boolean');
  });
});

describe('one value-out pick per remaining select', () => {
  it('branding: each logo position writes its own value', async () => {
    const onChange = vi.fn();
    render(<BrandingTab company={company} onChange={onChange} onCompanyChange={vi.fn()} onError={vi.fn()} />);
    for (const [label, value] of [['Top Left', 'top-left'], ['Top Center', 'top-center'], ['Top Right', 'top-right']]) {
      await pickKit(combo(/Position of Logo/), label!);
      expect(onChange).toHaveBeenLastCalledWith('logoPosition', value);
    }
  });

  it('general: date format and ageing basis', async () => {
    const onChange = vi.fn();
    render(<GeneralTab company={company} onChange={onChange} />);
    await pickKit(combo('Date Format'), 'yyyy-mm-dd');
    expect(onChange).toHaveBeenLastCalledWith('dateFormat', 'yyyy-mm-dd');
    await pickKit(combo('Run Ageing Based On'), 'Due Date');
    expect(onChange).toHaveBeenLastCalledWith('ageingBasedOn', 'due_date');
  });

  it('regional: decimal separator', async () => {
    const onChange = vi.fn();
    render(<RegionalTab company={{ ...company, decimalSeparator: '.' }} onChange={onChange} />);
    await pickKit(combo('Decimal Separator'), /comma/);
    expect(onChange).toHaveBeenLastCalledWith('decimalSeparator', ',');
  });
});
