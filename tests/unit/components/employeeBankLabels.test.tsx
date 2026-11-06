/**
 * Wave 4 B: the bank fields show " *" only when they are needed. On the create form an untouched section is
 * optional (no asterisk); after one keystroke the three required fields are starred and aria-required. The
 * profile editor always needs them. Account type never carries one (it has a default).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/' }) }));

import NewEmployeePage from '@/../pages/payroll/employees/new';
import { BankDetailsEditor } from '@/components/payroll/BankDetailsEditor';

afterEach(cleanup);

describe('create form bank section', () => {
  it('shows no asterisk while the section is blank, and says what makes it required', () => {
    render(<NewEmployeePage />);
    for (const l of ['Bank name', 'Branch code', 'Account number']) {
      const input = screen.getByLabelText(l);
      expect(input.getAttribute('aria-required')).toBeNull();
    }
    expect(screen.queryByLabelText('Bank name *')).toBeNull();
    expect(screen.getByText('Optional. Once you type any bank detail, the bank name, branch code and account number are needed.')).toBeTruthy();
  });

  it('stars and aria-requires the three fields after one keystroke, never Account type', () => {
    render(<NewEmployeePage />);
    fireEvent.change(screen.getByLabelText('Bank name'), { target: { value: 'F' } });
    for (const l of ['Bank name *', 'Branch code *', 'Account number *']) {
      expect(screen.getByLabelText(l).getAttribute('aria-required')).toBe('true');
    }
    expect(screen.getByLabelText('Account type')).toBeTruthy();
    expect(screen.queryByLabelText('Account type *')).toBeNull();
  });

  it('goes back to unstarred when the section is cleared again', () => {
    render(<NewEmployeePage />);
    const name = screen.getByLabelText('Bank name');
    fireEvent.change(name, { target: { value: 'F' } });
    fireEvent.change(screen.getByLabelText('Bank name *'), { target: { value: '' } });
    expect(screen.queryByLabelText('Bank name *')).toBeNull();
  });
});

describe('profile editor', () => {
  it('always stars and aria-requires the three fields', () => {
    render(<BankDetailsEditor employeeId="e1" onSaved={vi.fn()} onCancel={vi.fn()} />);
    for (const l of ['Bank name *', 'Branch code *', 'Account number *']) {
      expect(screen.getByLabelText(l).getAttribute('aria-required')).toBe('true');
    }
    expect(screen.queryByLabelText('Account type *')).toBeNull();
  });
});
