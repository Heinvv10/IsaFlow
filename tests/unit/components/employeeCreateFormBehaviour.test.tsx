/**
 * How the employee create form behaves around the salary: a mid-month, late or back-dated start is said out loud,
 * tax and ID numbers are judged on blur, the first invalid field takes focus in page order, a second submit is
 * ignored, every Select can be driven by keyboard alone, and the link to Pay Components keeps the form.
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
import { firstMonthNotes } from '@/components/payroll/employeeCreate/salaryComponents';

const BASIC = { id: 'c-basic', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning', isTaxable: true };
const COMMISSION = { id: 'c-comm', name: 'Commission', sarsSourceCode: '3606', componentType: 'earning', isTaxable: true };

let catalogue: unknown[];
let answer: () => Response | Promise<Response>;
const fetchMock = vi.fn();
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });

beforeEach(() => {
  catalogue = [BASIC, COMMISSION];
  answer = () => json({ id: 'e1' });
  push.mockClear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => (url === '/api/payroll/components' ? json(catalogue) : answer()));
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
const posted = (i = 0) => JSON.parse(String((posts()[i]![1] as RequestInit).body));
const payReady = () => screen.findByLabelText('Monthly salary');
const form = () => screen.getByRole('button', { name: /create employee/i }).closest('form') as HTMLFormElement;

describe('firstMonthNotes', () => {
  const TODAY = '2026-11-10';
  it('the 1st of this month or a later one: nothing to say', () => {
    expect(firstMonthNotes('2026-11-01', TODAY)).toEqual([]);
    expect(firstMonthNotes('2027-01-01', TODAY)).toEqual([]);
  });
  it.each([['2026-11-02'], ['2026-11-15'], ['2026-11-27']])('%s: paid in full, not a part month', (start) => {
    const notes = firstMonthNotes(start, TODAY);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/full monthly salary/i);
  });
  it.each([['2026-11-28'], ['2026-11-30'], ['2027-02-28']])("%s: nothing in that month's run", (start) => {
    const notes = firstMonthNotes(start, TODAY);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/next month/i);
  });
  it('an earlier month says so, alone on the 1st and beside the other note otherwise', () => {
    expect(firstMonthNotes('2026-10-01', TODAY)).toEqual([expect.stringMatching(/earlier month/i)]);
    expect(firstMonthNotes('2026-10-15', TODAY)).toEqual([expect.stringMatching(/full monthly salary/i), expect.stringMatching(/earlier month/i)]);
    expect(firstMonthNotes('2025-12-01', '2026-01-05')).toEqual([expect.stringMatching(/earlier month/i)]);
  });
});

describe('the first month, on the form', () => {
  it('a mid-month start with a salary shows the note; no salary, no note', async () => {
    render(<Page />);
    await payReady();
    typeInto(/^Start date/, '2026-11-15');
    expect(screen.queryByText(/full monthly salary/i)).toBeNull();
    typeInto('Monthly salary', '25 000');
    expect(await screen.findByText(/full monthly salary/i)).toBeTruthy();
    typeInto('Monthly salary', '');
    await waitFor(() => expect(screen.queryByText(/full monthly salary/i)).toBeNull());
  });

  it('the help no longer says the salary starts on the start date', async () => {
    render(<Page />);
    await payReady();
    expect(screen.queryByText(/salary starts on the start date/i)).toBeNull();
    expect(screen.getByText(/on or before the 27th/i)).toBeTruthy();
  });
});

describe('tax and ID numbers', () => {
  it.each([
    ['SARS tax number', '4123456789', /10 digits starting with/],
    ['SA ID number', '12345', /13 digits/],
  ])('%s: refused on blur, before any submit, and cleared by typing', (label, value, message) => {
    render(<Page />);
    typeInto(label, value);
    const field = screen.getByLabelText(label);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(message);
    fireEvent.change(field, { target: { value: '' } });
    expect(field.getAttribute('aria-invalid')).toBe('false');
    fireEvent.blur(field);
    expect(field.getAttribute('aria-invalid')).toBe('false');
  });

  it('spaces in a pasted tax number are dropped, and it posts clean', async () => {
    render(<Page />);
    required();
    typeInto('SARS tax number', '0123 456 789');
    expect((screen.getByLabelText('SARS tax number') as HTMLInputElement).value).toBe('0123456789');
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().taxNumber).toBe('0123456789');
  });

  it('spaces in a pasted ID number are dropped, and it posts clean', async () => {
    render(<Page />);
    required();
    typeInto('SA ID number', '800101 5009 087');
    expect((screen.getByLabelText('SA ID number') as HTMLInputElement).value).toBe('8001015009087');
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().idNumber).toBe('8001015009087');
  });

  it.each([
    ['a blank name before a bad tax number', 'First name *', () => typeInto('First name *', '')],
    ['a bad ID before a bad tax number', 'SA ID number', () => typeInto('SA ID number', '12345')],
    ['a refused birth date before a bad tax number', 'Date of birth', () => typeInto('Date of birth', 'soon')],
  ])('focus goes to the first invalid field in page order: %s', async (_n, label, arrange) => {
    render(<Page />);
    required();
    typeInto('SARS tax number', '4123456789');
    arrange();
    submit();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(label)));
  });
});

describe('submitting', () => {
  it('a second submit while the first is in flight posts nothing', async () => {
    let release: (r: Response) => void = () => undefined;
    answer = () => new Promise<Response>(r => { release = r; });
    render(<Page />);
    required();
    fireEvent.submit(form());
    await waitFor(() => expect(posts()).toHaveLength(1));
    fireEvent.submit(form());
    fireEvent.submit(form());
    await new Promise(r => { queueMicrotask(() => r(undefined)); });
    expect(posts()).toHaveLength(1);
    release(json({ id: 'e1' }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
  });

  it('a refused save can be sent again', async () => {
    answer = () => new Response(JSON.stringify({ success: false, error: { message: 'no' } }), { status: 400 });
    render(<Page />);
    required();
    fireEvent.submit(form());
    await screen.findByRole('alert');
    fireEvent.submit(form());
    await waitFor(() => expect(posts()).toHaveLength(2));
  });
});

describe('keyboard only', () => {
  async function choose(trigger: HTMLElement, searchLabel: string, query: string) {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const search = await screen.findByRole('textbox', { name: searchLabel });
    await waitFor(() => expect(document.activeElement).toBe(search));
    fireEvent.change(search, { target: { value: query } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }

  it('the pay component can be chosen, and the choice is posted', async () => {
    render(<Page />);
    await payReady();
    required();
    typeInto('Monthly salary', '25 000');
    await choose(screen.getByRole('combobox', { name: 'Pay component' }), 'Search Pay component', 'comm');
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().salary.componentId).toBe('c-comm');
  });

  it('the employment type can be chosen, and the choice is posted', async () => {
    render(<Page />);
    required();
    await choose(screen.getByRole('combobox', { name: 'Employment type' }), 'Search Employment type', 'cont');
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posted().employmentType).toBe('contract');
  });
});

describe('no usable Basic Salary component', () => {
  it('the link opens a new tab, covers an inactive one, and coming back shows what was added with the form intact', async () => {
    catalogue = [];
    render(<Page />);
    const link = await screen.findByRole('link', { name: /add one/i });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText(/no active, taxable Basic Salary component/i)).toBeTruthy();
    typeInto('First name *', 'Thandi');

    catalogue = [BASIC];
    fireEvent(window, new Event('focus'));
    await payReady();
    expect((screen.getByLabelText('First name *') as HTMLInputElement).value).toBe('Thandi');
    expect(screen.getByRole('combobox', { name: 'Pay component' }).textContent).toContain('Basic Salary');
    expect(screen.queryByRole('link', { name: /add one/i })).toBeNull();
  });

  it('coming back keeps a component already chosen', async () => {
    catalogue = [COMMISSION];
    render(<Page />);
    await payReady();
    fireEvent.click(screen.getByRole('combobox', { name: 'Pay component' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Commission (3606)' }));
    catalogue = [BASIC, COMMISSION];
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('link', { name: /add one/i })).toBeNull());
    expect(screen.getByRole('combobox', { name: 'Pay component' }).textContent).toContain('Commission');
  });

  it('with a Basic Salary present the catalogue is not fetched again on focus', async () => {
    render(<Page />);
    await payReady();
    const loads = () => fetchMock.mock.calls.filter(([url]) => url === '/api/payroll/components').length;
    expect(loads()).toBe(1);
    fireEvent(window, new Event('focus'));
    await new Promise(r => { queueMicrotask(() => r(undefined)); });
    expect(loads()).toBe(1);
  });
});
