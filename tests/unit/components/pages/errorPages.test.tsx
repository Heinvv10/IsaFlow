// @vitest-environment happy-dom
import React from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let authState = { isAuthenticated: false, loading: false };

vi.mock('next/head', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ alt, src }: { alt: string; src: string }) => <img alt={alt} src={src} />,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => authState }));

import NotFoundPage from '../../../../pages/404';
import ErrorPage from '../../../../pages/_error';

const START_URL = window.location.href;
const onHost = (url: string) => (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);

afterEach(() => {
  cleanup();
  onHost(START_URL);
  authState = { isAuthenticated: false, loading: false };
  vi.restoreAllMocks();
});

describe('404 page', () => {
  it('signed out: shows message, Sign in and Home links, logo, no dashboard link', () => {
    render(<NotFoundPage />);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.getByText(/This page could not be found/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
    expect(screen.queryByRole('link', { name: 'Go to dashboard' })).toBeNull();
    expect(screen.getByAltText('IsaFlow')).toBeTruthy();
  });

  it('signed in: shows Go to dashboard and no Sign in link', () => {
    authState = { isAuthenticated: true, loading: false };
    render(<NotFoundPage />);
    expect(screen.getByRole('link', { name: 'Go to dashboard' }).getAttribute('href')).toBe('/accounting');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  it('signed in on the admin host: Go to dashboard opens the admin dashboard, not /accounting (audit 4.2)', () => {
    onHost('https://admin.isaflow.co.za/no-such-page');
    authState = { isAuthenticated: true, loading: false };
    render(<NotFoundPage />);
    expect(screen.getByRole('link', { name: 'Go to dashboard' }).getAttribute('href')).toBe('/');
  });

  it('while auth is loading: renders the signed-out links', () => {
    authState = { isAuthenticated: false, loading: true };
    render(<NotFoundPage />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Go to dashboard' })).toBeNull();
  });

  it('sets the document title', () => {
    const { container } = render(<NotFoundPage />);
    expect(container.querySelector('title')?.textContent).toBe('Page not found · IsaFlow');
  });

  it('supports dark mode on the wrapper', () => {
    const { container } = render(<NotFoundPage />);
    expect((container.firstElementChild as HTMLElement).className).toContain('dark:bg-gray-950');
  });

  it('makes no network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<NotFoundPage />);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('error page', () => {
  it('shows its own heading and title with the same link rules', () => {
    const { container } = render(<ErrorPage />);
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    expect(container.querySelector('title')?.textContent).toBe('Something went wrong · IsaFlow');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    cleanup();
    authState = { isAuthenticated: true, loading: false };
    render(<ErrorPage />);
    expect(screen.getByRole('link', { name: 'Go to dashboard' }).getAttribute('href')).toBe('/accounting');
  });
});
