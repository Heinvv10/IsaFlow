/**
 * DemoBanner names the demo company it is showing from the active company's own name, so a rename of the demo
 * tenant (ISAFlow Demo became IsaFlow Demo on 17 Nov 2026) never leaves stale copy. Visibility and the
 * switch/onboarding actions are unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

type Member = { companyId: string; companyName: string; role: string; isDefault: boolean; isDemo: boolean };
const state = vi.hoisted(() => ({
  activeCompany: null as Record<string, unknown> | null,
  companies: [] as Member[],
}));

vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: state.activeCompany, companies: state.companies, switchCompany: vi.fn() }),
}));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

import { DemoBanner } from '../../../src/components/layout/DemoBanner';

const DEMO_MEMBER: Member = { companyId: 'd', companyName: 'IsaFlow Demo (Pty) Ltd', role: 'owner', isDefault: false, isDemo: true };

function show(activeCompany: Record<string, unknown> | null, companies: Member[] = [DEMO_MEMBER]): string {
  state.activeCompany = activeCompany;
  state.companies = companies;
  const { container } = render(<DemoBanner />);
  return container.textContent ?? '';
}

afterEach(() => { cleanup(); });

describe('DemoBanner copy', () => {
  it('names the active demo company', () => {
    const text = show({ id: 'd', name: 'IsaFlow Demo (Pty) Ltd', isDemo: true });
    expect(text).toContain('You are viewing IsaFlow Demo (Pty) Ltd.');
    expect(text).not.toContain('ISAFlow');
  });

  it('follows a renamed demo tenant', () => {
    expect(show({ id: 'd', name: 'Acme Sandbox', isDemo: true })).toContain('You are viewing Acme Sandbox.');
  });

  it.each([
    ['missing', { id: 'd', isDemo: true }],
    ['blank', { id: 'd', name: '  ', isDemo: true }],
  ])('falls back to IsaFlow Demo when the name is %s', (_label, company) => {
    const text = show(company);
    expect(text).toContain('You are viewing IsaFlow Demo.');
    expect(text).not.toContain('ISAFlow');
  });
});

describe('DemoBanner behaviour is unchanged', () => {
  it('renders nothing for a company that is not the demo', () => {
    expect(show({ id: 'r', name: 'Real Co', isDemo: false }, [])).toBe('');
  });

  it('offers the way back to a real company', () => {
    const real: Member = { companyId: 'r', companyName: 'Real Co', role: 'owner', isDefault: true, isDemo: false };
    show({ id: 'd', name: 'IsaFlow Demo (Pty) Ltd', isDemo: true }, [DEMO_MEMBER, real]);
    const button = document.querySelector('button');
    expect(button?.textContent).toContain('Back to Real Co');
    expect(document.querySelector('a[href="/onboarding"]')).toBeNull();
  });

  it('offers onboarding when the user has no real company', () => {
    show({ id: 'd', name: 'IsaFlow Demo (Pty) Ltd', isDemo: true });
    const link = document.querySelector('a[href="/onboarding"]');
    expect(link?.textContent).toContain('Set up your own company');
    expect(document.querySelector('button')).toBeNull();
  });
});
