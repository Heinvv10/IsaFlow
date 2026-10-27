/**
 * Employee create on the form kit: per-field errors with focus on the first, refused dates block the POST,
 * medical aid defaults off (D1), and the POST body is exactly what the form sent before the kit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const push = vi.hoisted(() => vi.fn(async () => true));
vi.mock('next/router', () => ({ useRouter: () => ({ push, query: {} }) }));

import Page from '@/../pages/payroll/employees/new';
import { initialForm } from '@/components/payroll/employeeCreate/types';

// Captured from the pre-kit page (same inputs) on 2026-10-27, key order included.
const BODY_BEFORE_KIT = '{"firstName":"Thandi","lastName":"Nkosi","employeeNumber":"E-001","employmentType":"contract","startDate":"2026-03-01","taxNumber":"1234567890","idNumber":"8001015009087","dateOfBirth":"1980-01-01","uifExcluded":true,"medicalAidMainMember":true,"medicalAidDependantsCount":2}';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ success: true, data: { id: 'e1' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const typeInto = (label: string | RegExp, value: string) => {
  const el = screen.getByLabelText(label);
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};
const submit = () => fireEvent.click(screen.getByRole('button', { name: /create employee/i }));
const posts = () => fetchMock.mock.calls.filter(([url]) => url === '/api/payroll/employees');

describe('employee create form', () => {
  it('medical aid defaults to false', () => {
    expect(initialForm('2026-10-27').medicalAidMainMember).toBe(false);
    render(<Page />);
    expect((screen.getByLabelText('Medical aid main member') as HTMLInputElement).checked).toBe(false);
  });

  it('an empty first name is refused, named, and focused', async () => {
    render(<Page />);
    typeInto('Last name *', 'Nkosi');
    typeInto('Employee number *', 'E-001');
    submit();
    const first = screen.getByLabelText('First name *') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a first name.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('"31 Feb 2026" as the start date is refused and nothing is posted', async () => {
    render(<Page />);
    typeInto('First name *', 'Thandi');
    typeInto('Last name *', 'Nkosi');
    typeInto('Employee number *', 'E-001');
    typeInto(/^Start date/, '31 Feb 2026');
    submit();
    const start = screen.getByLabelText(/^Start date/) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(start));
    expect(start.getAttribute('aria-invalid')).toBe('true');
    // The real reason, not the generic empty-field copy: the refusal must not collapse into "left blank".
    expect(screen.queryByText('Enter a start date.')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('a date of birth in the future is refused', async () => {
    render(<Page />);
    typeInto('First name *', 'Thandi');
    typeInto('Last name *', 'Nkosi');
    typeInto('Employee number *', 'E-001');
    typeInto('Date of birth', '01 Jan 2099');
    submit();
    expect(await screen.findByText('Date of birth cannot be in the future.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('posts the same body as before the kit', async () => {
    render(<Page />);
    typeInto('First name *', 'Thandi');
    typeInto('Last name *', 'Nkosi');
    typeInto('Employee number *', 'E-001');
    typeInto('SA ID number', '8001015009087');
    typeInto('SARS tax number', '1234567890');
    typeInto('Date of birth', '1980-01-01');
    typeInto(/^Start date/, '2026-03-01');
    typeInto('Medical aid dependants', '2');
    fireEvent.click(screen.getByLabelText('Excluded from UIF'));
    fireEvent.click(screen.getByLabelText('Medical aid main member'));
    fireEvent.click(screen.getByRole('combobox', { name: 'Employment type' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Contract' }));
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0] as [string, RequestInit];
    expect(url).toBe('/api/payroll/employees');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(BODY_BEFORE_KIT);
  });

  it('a minimal form omits the optional keys instead of posting empty strings', async () => {
    render(<Page />);
    typeInto('First name *', 'Thandi');
    typeInto('Last name *', 'Nkosi');
    typeInto('Employee number *', 'E-001');
    submit();
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse(String((posts()[0]![1] as RequestInit).body));
    expect(Object.keys(body)).toEqual(['firstName', 'lastName', 'employeeNumber', 'employmentType', 'startDate',
      'uifExcluded', 'medicalAidMainMember', 'medicalAidDependantsCount']);
    expect(String((posts()[0]![1] as RequestInit).body)).not.toMatch(/taxNumber|idNumber|dateOfBirth/);
  });
});
