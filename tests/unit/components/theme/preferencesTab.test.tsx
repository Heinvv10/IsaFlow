/** My Account > Preferences offers the same three-way Light / Dark / System control as the header. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { PreferencesTab } from '@/components/accounting/my-account/AccountTabs';

beforeEach(() => {
  window.localStorage.clear();
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('PreferencesTab theme row', () => {
  it('is the three-way control, not a dark-mode switch, and a choice is saved', () => {
    render(
      <ThemeProvider>
        <PreferencesTab prefs={{ rowsPerPage: '20', navMode: 'top' } as never} saving={false} onChange={vi.fn()} onSave={vi.fn()} />
      </ThemeProvider>,
    );
    expect(screen.getByRole('group', { name: 'Colour theme' })).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(window.localStorage.getItem('accounting-theme')).toBe('system');
  });
});
