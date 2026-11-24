// My Reports: text that sits directly on the page background uses the theme tokens. It used text-gray-900 / text-gray-500, which the app shell maps to dark values in BOTH
// themes: in dark mode the heading was rgb(7,26,36) on rgb(7,26,36) (contrast 1.00) and the subtitle 3.67.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/' }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { items: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/reports/my-reports';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const GRAYS = /^text-(gray|slate|zinc)-\d+$/;

describe('My Reports text on the page background', () => {
  it('the heading and the subtitle use the theme text tokens', async () => {
    render(<Page />);
    const h1 = await screen.findByRole('heading', { level: 1, name: 'My Reports' });
    expect(cls(h1)).toContain('text-[var(--ff-text-primary)]');
    expect(cls(h1).filter((c) => GRAYS.test(c))).toEqual([]);
    const sub = screen.getByText('Saved custom report templates');
    expect(cls(sub)).toContain('text-[var(--ff-text-secondary)]');
    expect(cls(sub).filter((c) => GRAYS.test(c))).toEqual([]);
  });

  it('the empty-state title, which also sits on the page background, uses the secondary token', async () => {
    render(<Page />);
    const title = await screen.findByText('No saved reports yet');
    expect(cls(title)).toContain('text-[var(--ff-text-secondary)]');
    expect(cls(title).filter((c) => GRAYS.test(c))).toEqual([]);
  });
});
