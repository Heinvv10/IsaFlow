/**
 * Settings -> General: the financial year start.
 *
 * - Read-only once the company has posted a journal (PUT /api/accounting/companies
 *   refuses the change then; the server rule is gl/fiscalYearStartChange.ts),
 *   with a note that is true today: the guided change of year end is coming.
 * - Read-only for a company that is not the active one (the server refuses there too).
 * - The field shows the month the BOOKS use (period 1 of the latest year) when
 *   locked, and says so when the declared month differs: a company can declare
 *   March while its periods run January–December.
 * Before the first posting it stays editable.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GeneralTab } from '@/components/accounting/settings/GeneralTab';
import { mapApiCompany } from '@/components/accounting/settings/mapApiCompany';

afterEach(() => { cleanup(); });

const company = (over: Record<string, unknown> = {}) => mapApiCompany({ id: 'c1', name: 'Co', financialYearStart: 3, ...over });
const fySelect = () => screen.getByLabelText('Financial Year Start Month') as HTMLSelectElement;
const shownMonth = () => fySelect().selectedOptions[0]!.textContent;

describe('GeneralTab financial year start', () => {
  it('is read-only once a journal has posted, with a note that is true today', () => {
    render(<GeneralTab company={company({
      financialYearStartLocked: true, financialYearStartLockReason: 'posted', financialYearStartActual: 3,
    })} onChange={vi.fn()} />);
    expect(fySelect().disabled).toBe(true);
    expect(shownMonth()).toBe('Mar');
    expect(screen.getByText(/Locked because journals have been posted/).textContent)
      .toMatch(/guided change of year end \(coming soon\); contact support if you need it now/);
    expect(screen.queryByText(/declared/i)).toBeNull();
  });

  it('locked with periods on another month: shows the month the books use, and the mismatch', () => {
    render(<GeneralTab company={company({
      financialYearStartLocked: true, financialYearStartLockReason: 'posted', financialYearStartActual: 1,
    })} onChange={vi.fn()} />);
    expect(shownMonth()).toBe('Jan');
    const note = screen.getByText(/declared/i).textContent!;
    expect(note).toMatch(/January/);
    expect(note).toMatch(/March/);
  });

  it('editable with periods on another month: shows the declared month and says a save rebuilds unused periods', () => {
    const onChange = vi.fn();
    render(<GeneralTab company={company({ financialYearStartLocked: false, financialYearStartActual: 1 })} onChange={onChange} />);
    expect(fySelect().disabled).toBe(false);
    expect(shownMonth()).toBe('Mar');
    expect(screen.getByText(/declared/i).textContent).toMatch(/January.*rebuil/);
  });

  it('read-only for a company that is not the active one', () => {
    render(<GeneralTab company={company({ financialYearStartLocked: true, financialYearStartLockReason: 'not_active' })}
      onChange={vi.fn()} />);
    expect(fySelect().disabled).toBe(true);
    expect(screen.getByText(/Switch to this company/)).toBeTruthy();
    expect(screen.queryByText(/journals have been posted/)).toBeNull();
  });

  it('is editable, with no note, before the first posting', () => {
    const onChange = vi.fn();
    render(<GeneralTab company={company({ financialYearStartLocked: false, financialYearStartActual: 3 })} onChange={onChange} />);
    expect(fySelect().disabled).toBe(false);
    expect(screen.queryByText(/Locked because|declared|Switch to this company/)).toBeNull();
    fireEvent.change(fySelect(), { target: { value: '6' } });
    expect(onChange).toHaveBeenCalledWith('financialYearStart', 6);
  });

  it('maps absent flags to unlocked with no known actual month (the server still refuses a change after posting)', () => {
    expect(company()).toMatchObject({
      financialYearStartLocked: false, financialYearStartLockReason: null, financialYearStartActual: null,
    });
  });
});
