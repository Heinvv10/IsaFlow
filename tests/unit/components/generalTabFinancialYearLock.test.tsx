/**
 * Settings -> General: the financial year start is read-only once the company
 * has posted a journal (PUT /api/accounting/companies refuses the change then;
 * the server rule is in gl/fiscalYearStartChange.ts), with a note on why.
 * Before the first posting it stays editable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GeneralTab } from '@/components/accounting/settings/GeneralTab';
import { mapApiCompany } from '@/components/accounting/settings/mapApiCompany';

afterEach(() => { cleanup(); });

const company = (locked: boolean | undefined) => mapApiCompany({
  id: 'c1', name: 'Co', financialYearStart: 3, ...(locked === undefined ? {} : { financialYearStartLocked: locked }),
});
const fySelect = () => screen.getByLabelText('Financial Year Start Month') as HTMLSelectElement;

describe('GeneralTab financial year start', () => {
  it('is read-only with a note once a journal has posted', () => {
    const onChange = vi.fn();
    render(<GeneralTab company={company(true)} onChange={onChange} />);
    expect(fySelect().disabled).toBe(true);
    expect(screen.getByText(/guided change of year end/i)).toBeTruthy();
  });

  it('is editable, with no note, before the first posting', () => {
    const onChange = vi.fn();
    render(<GeneralTab company={company(false)} onChange={onChange} />);
    expect(fySelect().disabled).toBe(false);
    expect(screen.queryByText(/guided change of year end/i)).toBeNull();
    fireEvent.change(fySelect(), { target: { value: '6' } });
    expect(onChange).toHaveBeenCalledWith('financialYearStart', 6);
  });

  it('maps an absent flag to unlocked (the server still refuses a change after posting)', () => {
    expect(company(undefined).financialYearStartLocked).toBe(false);
  });
});
