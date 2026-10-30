/**
 * W2 H: below `sm` the company name is hidden, so the switcher button must carry its own accessible name
 * (axe button-name was critical at 390 px).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({
    activeCompany: { id: 'co-1', name: 'Acme (Pty) Ltd', tradingName: 'Acme' },
    companies: [{ companyId: 'co-1', companyName: 'Acme (Pty) Ltd', role: 'owner', isDefault: true }],
    switchCompany: vi.fn(), loading: false,
  }),
}));

import { CompanySwitcher } from '@/components/layout/CompanySwitcher';

afterEach(cleanup);

describe('CompanySwitcher', () => {
  it('names the current company and the action, whatever the visible text', () => {
    render(<CompanySwitcher />);
    const button = screen.getByRole('button', { name: 'Switch company (current: Acme)' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });
});
