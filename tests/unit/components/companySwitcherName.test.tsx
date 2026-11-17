/**
 * W2 H: below `sm` the company name is hidden, so the switcher button must carry its own accessible name
 * (axe button-name was critical at 390 px).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn() } }));
const ACTIVE_LOGO = 'data:image/png;base64,AAAA';
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({
    activeCompany: { id: 'co-1', name: 'Acme (Pty) Ltd', tradingName: 'Acme', logoData: ACTIVE_LOGO },
    companies: [
      { companyId: 'co-1', companyName: 'Acme (Pty) Ltd', role: 'owner', isDefault: true, hasLogo: true },
      { companyId: 'co-2', companyName: 'Beta (Pty) Ltd', role: 'owner', isDefault: false, hasLogo: true },
      { companyId: 'co-3', companyName: 'Gamma (Pty) Ltd', role: 'owner', isDefault: false, hasLogo: false },
    ],
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

  it('shows each company\'s logo in the dropdown, and the icon only where there is none', () => {
    render(<CompanySwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /Switch company/ }));
    const logoIn = (name: string) => screen.getByText(name).closest('button')!.querySelector('img')?.getAttribute('src');
    expect(logoIn('Acme (Pty) Ltd')).toBe(ACTIVE_LOGO);
    expect(logoIn('Beta (Pty) Ltd')).toBe('/api/accounting/company-logo?companyId=co-2');
    expect(logoIn('Gamma (Pty) Ltd')).toBeUndefined();
  });

  it('falls back to the icon when a row\'s logo fails to load', () => {
    render(<CompanySwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /Switch company/ }));
    const row = screen.getByText('Beta (Pty) Ltd').closest('button')!;
    fireEvent.error(row.querySelector('img')!);
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('svg')).not.toBeNull();
  });
});
