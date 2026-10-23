// AFS portal login page: after Sign out (?signed_out=1) it shows a neutral
// "You have signed out." notice — not the warning or error style — and no
// error banner. Without the parameter there is no notice.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/accounting/afs/portal/login' }) }));
vi.mock('next/head', () => ({ default: () => null }));

import PortalLoginPage from '../../../pages/accounting/afs/portal/login';

afterEach(() => { cleanup(); h.query = {}; });

describe('portal login — signed-out notice', () => {
  it('?signed_out=1 shows the neutral notice and no error banner', () => {
    h.query = { signed_out: '1' };
    render(<PortalLoginPage />);
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe('You have signed out.');
    // neutral, not the amber warning (#fffbeb) or red error (#fef2f2) style
    expect(notice.getAttribute('style') ?? '').not.toMatch(/#fffbeb|#fef2f2|rgb\(255, 251, 235\)|rgb\(254, 242, 242\)/i);
    expect(screen.queryByText(/expired|invalid|could not/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send sign-in link' })).toBeTruthy();
  });

  it('without the parameter there is no notice', () => {
    render(<PortalLoginPage />);
    expect(screen.queryByText('You have signed out.')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('an error parameter still wins over nothing: no signed-out notice beside it', () => {
    h.query = { error: 'expired' };
    render(<PortalLoginPage />);
    expect(screen.queryByText('You have signed out.')).toBeNull();
    expect(screen.getByText(/has expired/)).toBeTruthy();
  });
});
