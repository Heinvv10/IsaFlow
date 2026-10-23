// AFS portal login page: after Sign out (?signed_out=1) it shows a neutral
// "You have signed out." notice — not the warning or error style — and no
// error banner. Without the parameter there is no notice. A refused sign out
// (?error=signout_failed) says it did not complete.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: {} as Record<string, string | string[]> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/accounting/afs/portal/login' }) }));
vi.mock('next/head', () => ({ default: () => null }));

import PortalLoginPage from '../../../pages/accounting/afs/portal/login';

afterEach(() => { cleanup(); h.query = {}; vi.unstubAllGlobals(); });

describe('portal login — signed-out notice', () => {
  it('?signed_out=1 shows the neutral notice and no error banner', () => {
    h.query = { signed_out: '1' };
    render(<PortalLoginPage />);
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe('You have signed out.');
    expect(notice.style.background).toBe('#f1f5f9'); // slate, not the amber warning or red error
    expect(screen.queryByText(/expired|invalid|could not|did not complete/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send sign-in link' })).toBeTruthy();
  });

  it('without the parameter there is no notice', () => {
    render(<PortalLoginPage />);
    expect(screen.queryByText('You have signed out.')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([['0'], ['true'], [''], [['1', '1']]])('signed_out=%j shows no notice', (v) => {
    h.query = { signed_out: v };
    render(<PortalLoginPage />);
    expect(screen.queryByText('You have signed out.')).toBeNull();
  });

  it('an error beside signed_out=1 shows the error, not the notice', () => {
    h.query = { error: 'expired', signed_out: '1' };
    render(<PortalLoginPage />);
    expect(screen.queryByText('You have signed out.')).toBeNull();
    expect(screen.getByText(/has expired/)).toBeTruthy();
  });

  it('a refused sign out says it did not complete', () => {
    h.query = { error: 'signout_failed' };
    render(<PortalLoginPage />);
    expect(screen.getByText('Sign out did not complete. Go back to your portal and try again.')).toBeTruthy();
    expect(screen.queryByText('You have signed out.')).toBeNull();
  });

  it('the notice goes once a new sign-in link is sent', async () => {
    h.query = { signed_out: '1' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { container } = render(<PortalLoginPage />);
    fireEvent.change(container.querySelector('#email')!, { target: { value: 'dana@proof.test' } });
    fireEvent.submit(container.querySelector('form')!);
    await screen.findByText('Check your email');
    expect(screen.queryByText('You have signed out.')).toBeNull();
  });
});
