/**
 * Pay on the employee create form: the tax and ID rules block submit and focus the field, the salary posts as
 * { componentId, amountCents }, and the default component is taken only when unique. How the form behaves around that
 * (blur, double submit, keyboard, the first-month notes) is in employeeCreateFormBehaviour.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const push = vi.hoisted(() => vi.fn(async () => true));
vi.mock('next/router', () => ({ useRouter: () => ({ push, query: {} }) }));

import Page from '@/../pages/payroll/employees/new';
import { defaultSalaryComponent, salaryComponents } from '@/components/payroll/employeeCreate/salaryComponents';

const BASIC = { id: 'c-basic', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning', isTaxable: true };
const SECOND_BASIC = { ...BASIC, id: 'c-basic2', name: 'Basic Wage' };
const UNTAXED_BASIC = { ...BASIC, id: 'c-untaxed', name: 'Untaxed wage', isTaxable: false };
const COMMISSION = { id: 'c-comm', name: 'Commission', sarsSourceCode: '3606', componentType: 'earning', isTaxable: true };
const BONUS = { id: 'c-bonus', name: 'Annual bonus', sarsSourceCode: '3605', componentType: 'earning', isTaxable: true };
const LUMP = { id: 'c-lump', name: 'Severance', sarsSourceCode: '3901', componentType: 'earning', isTaxable: true };
const UNION = { id: 'c-union', name: 'Union fees', sarsSourceCode: '4472', componentType: 'deduction', isTaxable: false };

let catalogue: unknown[] | 'broken' = [BASIC, UNION];
const fetchMock = vi.fn();
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });

beforeEach(() => {
  catalogue = [BASIC, UNION];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url !== '/api/payroll/components') return json({ id: 'e1' });
    return catalogue === 'broken'
      ? new Response(JSON.stringify({ success: false, error: { message: 'boom' } }), { status: 500 })
      : json(catalogue);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const typeInto = (label: string | RegExp, value: string) => {
  const el = screen.getByLabelText(label);
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};
const required = () => {
  typeInto('First name *', 'Thandi');
  typeInto('Last name *', 'Nkosi');
  typeInto('Employee number *', 'E-001');
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: /create employee/i }));
const posts = () => fetchMock.mock.calls.filter(([url]) => url === '/api/payroll/employees');
const posted = () => JSON.parse(String((posts()[0]![1] as RequestInit).body));
const payReady = () => screen.findByLabelText('Monthly salary');

describe('tax and ID numbers', () => {
  it('an invalid tax number blocks submit and focuses the field', async () => {
    render(<Page />);
    required();
    typeInto('SARS tax number', '4123456789');
    submit();
    const field = screen.getByLabelText('SARS tax number');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/10 digits starting with 0, 1, 2, 3 or 9/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('an invalid ID number blocks submit and focuses the field', async () => {
    render(<Page />);
    required();
    typeInto('SA ID number', '12345');
    submit();
    const field = screen.getByLabelText('SA ID number');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(posts()).toHaveLength(0);
  });

  it('a blank tax number is still allowed', async () => {
    render(<Page />);
    required();
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

});

describe('salary', () => {
  it('posts { componentId, amountCents }', async () => {
    render(<Page />);
    await payReady();
    required();
    typeInto('Monthly salary', '25 000');
    await screen.findByRole('combobox', { name: 'Pay component' });
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().salary).toEqual({ componentId: 'c-basic', amountCents: 2500000 });
  });

  it('no amount: no salary key, whatever component is selected', async () => {
    render(<Page />);
    await payReady();
    required();
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(Object.keys(posted())).not.toContain('salary');
  });

  it('refused money text blocks submit and focuses the field', async () => {
    render(<Page />);
    await payReady();
    required();
    typeInto('Monthly salary', '1,234');
    submit();
    const field = screen.getByLabelText('Monthly salary');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(posts()).toHaveLength(0);
  });

  it('an amount too big for the column gets a clear message, not a failed save', async () => {
    render(<Page />);
    await payReady();
    required();
    typeInto('Monthly salary', '1000000000000');
    submit();
    expect(await screen.findByText(/must be at most R/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('zero is refused, not posted as no salary', async () => {
    render(<Page />);
    await payReady();
    required();
    typeInto('Monthly salary', '0');
    submit();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Monthly salary')));
    expect(posts()).toHaveLength(0);
  });

  it('an amount with no component chosen blocks submit and focuses the picker', async () => {
    catalogue = [BASIC, SECOND_BASIC];
    render(<Page />);
    await payReady();
    required();
    typeInto('Monthly salary', '25 000');
    submit();
    const picker = screen.getByRole('combobox', { name: 'Pay component' });
    await waitFor(() => expect(document.activeElement).toBe(picker));
    expect(screen.getByText('Choose the pay component.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('with two Basic components nothing is chosen for you, and the one you pick is posted', async () => {
    catalogue = [BASIC, SECOND_BASIC];
    render(<Page />);
    await payReady();
    required();
    typeInto('Monthly salary', '25 000');
    fireEvent.click(screen.getByRole('combobox', { name: 'Pay component' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Basic Wage (3601)' }));
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().salary).toEqual({ componentId: 'c-basic2', amountCents: 2500000 });
  });

  it('only monthly earnings are offered', async () => {
    catalogue = [BASIC, COMMISSION, BONUS, LUMP, UNION, UNTAXED_BASIC];
    render(<Page />);
    await payReady();
    fireEvent.click(screen.getByRole('combobox', { name: 'Pay component' }));
    const options = (await screen.findAllByRole('option')).map(o => o.textContent);
    expect(options).toEqual(['Basic Salary (3601)', 'Commission (3606)']);
  });

  it('a lone non-taxable 3601 is not offered: no salary field, and the link says why', async () => {
    catalogue = [UNTAXED_BASIC];
    render(<Page />);
    await screen.findByText(/no active, taxable Basic Salary component/i);
    expect(screen.queryByLabelText('Monthly salary')).toBeNull();
  });

  it('a non-taxable 3601 beside the taxable one does not make the default a guess', async () => {
    catalogue = [BASIC, UNTAXED_BASIC];
    render(<Page />);
    await payReady();
    required();
    typeInto('Monthly salary', '25 000');
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().salary.componentId).toBe('c-basic');
  });

  it('no monthly earning at all: says so, links to create one, offers no salary field', async () => {
    catalogue = [UNION];
    render(<Page />);
    const link = await screen.findByRole('link', { name: /add one/i });
    expect(link.getAttribute('href')).toBe('/payroll/components');
    expect(screen.queryByLabelText('Monthly salary')).toBeNull();
  });

  it('earnings but no Basic Salary: the link, the picker, and no default', async () => {
    catalogue = [COMMISSION];
    render(<Page />);
    await screen.findByRole('link', { name: /add one/i });
    const picker = await screen.findByRole('combobox', { name: 'Pay component' });
    expect(picker.textContent).not.toContain('Commission');
  });

  it('a failed catalogue load is said out loud, and the employee can still be created', async () => {
    catalogue = 'broken';
    render(<Page />);
    expect(await screen.findByText(/could not load the pay components/i)).toBeTruthy();
    required();
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(Object.keys(posted())).not.toContain('salary');
  });
});

describe('component rules', () => {
  it('the default is the unique 3601 only', () => {
    expect(defaultSalaryComponent(salaryComponents([BASIC, COMMISSION]))).toBe('c-basic');
    expect(defaultSalaryComponent(salaryComponents([BASIC, SECOND_BASIC]))).toBeNull();
    expect(defaultSalaryComponent(salaryComponents([COMMISSION]))).toBeNull();
    expect(defaultSalaryComponent([])).toBeNull();
    expect(defaultSalaryComponent(salaryComponents([UNTAXED_BASIC]))).toBeNull();
    expect(defaultSalaryComponent(salaryComponents([BASIC, UNTAXED_BASIC]))).toBe('c-basic');
  });

  it('a padded code is still classified as PAYE classifies it', () => {
    expect(defaultSalaryComponent(salaryComponents([{ ...BASIC, sarsSourceCode: ' 3601\n' }]))).toBe('c-basic');
    expect(salaryComponents([{ ...BONUS, sarsSourceCode: ' 3605 ' }])).toEqual([]);
  });
});
