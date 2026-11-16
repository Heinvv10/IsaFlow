/**
 * bank-reconciliation/new, prefilled by the bank-transactions statement panel's Reconcile link (WP1 PR-C round 2):
 * a zero balance shows "0" (not a blank), the date reaches the field, and an account that is not among the selector's
 * options (an inactive one) is never put in the form, so Start stays disabled instead of enabled behind a placeholder.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const state = vi.hoisted(() => ({ query: {} as Record<string, string>, selector: {} as { value?: string | null; initialValue?: string | null; onChange?: (id: string) => void } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: state.query, isReady: true, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/accounting/bank/BankAccountSelector', () => ({
  BankAccountSelector: (p: typeof state.selector) => { state.selector = p; return <div data-testid="selector" />; },
}));

import NewReconciliationPage from '../../../pages/accounting/bank-reconciliation/new';

afterEach(() => { cleanup(); state.selector = {}; });
const start = () => screen.getByRole('button', { name: /Start Reconciliation/ }) as HTMLButtonElement;
const balance = () => screen.getByPlaceholderText('e.g. 125000.00') as HTMLInputElement;

describe('bank-reconciliation/new prefill', () => {
  it('a zero statement balance shows "0", not a blank', async () => {
    state.query = { statementBalance: '0' };
    render(<NewReconciliationPage />);
    await waitFor(() => expect(balance().value).toBe('0'));
  });

  it('a balance with cents and the date reach their fields', async () => {
    state.query = { statementBalance: '2500.50', statementDate: '2026-10-31' };
    render(<NewReconciliationPage />);
    await waitFor(() => expect(balance().value).toBe('2500.5'));
    await waitFor(() => expect((screen.getByLabelText(/Statement Date/) as HTMLInputElement).value).toMatch(/31/));
  });

  it('the account is offered to the selector as its preselect, not set into the form: Start stays disabled until the selector confirms it', async () => {
    state.query = { bankAccountId: ID };
    render(<NewReconciliationPage />);
    await waitFor(() => expect(state.selector.initialValue).toBe(ID));
    expect(state.selector.value ?? null).toBeNull();
    expect(start().disabled).toBe(true); // an inactive account the selector does not list is never confirmed
  });

  it('typing a balance still works after a prefill', async () => {
    state.query = { statementBalance: '10' };
    render(<NewReconciliationPage />);
    await waitFor(() => expect(balance().value).toBe('10'));
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(balance(), { target: { value: '0' } });
    expect(balance().value).toBe('0');
  });

  it('a bad link value is dropped', async () => {
    state.query = { bankAccountId: 'nope', statementBalance: '1.234' };
    render(<NewReconciliationPage />);
    await waitFor(() => expect(state.selector).toBeDefined());
    expect(state.selector.initialValue ?? null).toBeNull();
    expect(balance().value).toBe('');
  });
});
