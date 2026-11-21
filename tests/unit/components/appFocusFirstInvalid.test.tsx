// The real pages/_app.tsx wires the focus-first-invalid behaviour for every page, not just ones that opt in.
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/accounting/customer-invoices', asPath: '/accounting/customer-invoices', query: {}, isReady: true, events: { on: () => {}, off: () => {} }, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/analytics/TrackerScript', () => ({ TrackerScript: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/contexts/CompanyContext', () => ({
  CompanyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useCompany: () => ({ activeCompany: null, loading: true }),
}));

afterEach(cleanup);

function Page() {
  const [bad, setBad] = useState(false);
  return (
    <form onSubmit={(e) => { e.preventDefault(); setBad(true); }}>
      <input aria-label="amount" aria-invalid={bad} />
      <button type="submit">Save</button>
    </form>
  );
}

describe('_app', () => {
  it('moves focus to the invalid field after a failed submit on a phone', async () => {
    window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches: q.includes('max-width'), media: q, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as never;
    Element.prototype.scrollIntoView = vi.fn();
    const { default: App } = await import('../../../pages/_app');
    render(React.createElement(App, { Component: Page, pageProps: {}, router: {} as never } as never));
    act(() => { screen.getByText('Save').click(); });
    await waitFor(() => expect(screen.getByLabelText('amount')).toHaveFocus());
  });
});
