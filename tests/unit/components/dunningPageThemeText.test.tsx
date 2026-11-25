// The dunning templates page: text that sits directly on the page background uses the theme tokens. It used text-gray-900 / text-gray-600 / text-gray-500, which the
// app shell maps to dark values in BOTH themes: in dark mode the heading was rgb(7,26,36) on rgb(7,26,36), a contrast ratio of 1.00 (the subtitle 2.10).
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ templates: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: String(url).includes('/settings') ? { settings: { auto_send_enabled: true, min_outstanding_zar: 500 } } : { templates: state.templates } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/ar/dunning/index';

afterEach(() => { cleanup(); state.templates = []; });
const cls = (el: Element) => el.className.split(' ');
const GRAYS = /^text-(gray|slate|zinc)-\d+$/;

describe('Dunning templates page text on the page background', () => {
  it('the heading and the subtitle use the theme text tokens, not a gray scale step', async () => {
    render(<Page />);
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(cls(h1)).toContain('text-[var(--ff-text-primary)]');
    expect(cls(h1).filter((c) => GRAYS.test(c))).toEqual([]);
    const sub = h1.parentElement!.querySelector('p')!;
    expect(cls(sub)).toContain('text-[var(--ff-text-secondary)]');
    expect(cls(sub).filter((c) => GRAYS.test(c))).toEqual([]);
  });

  it('the empty-state hint, which also sits on the page background, uses the secondary token', async () => {
    render(<Page />);
    const hint = await screen.findByText(/No templates configured/);
    expect(cls(hint)).toContain('text-[var(--ff-text-secondary)]');
    expect(cls(hint).filter((c) => GRAYS.test(c))).toEqual([]);
  });

  it('the loading line uses the secondary token too', () => {
    const { container } = render(<Page />);
    const loading = container.querySelector('div.h-64')!;
    expect(loading.textContent).toContain('Loading dunning templates');
    expect(cls(loading)).toContain('text-[var(--ff-text-secondary)]');
    expect(cls(loading).filter((c) => GRAYS.test(c))).toEqual([]);
  });
});
