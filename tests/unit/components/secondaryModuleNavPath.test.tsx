/**
 * SecondaryModuleNav highlights from the router's path unless the page gives a navPath: an AFS document and a
 * management pack share /accounting/afs/<id>, and only the loaded document knows which one it is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({ asPath: '/accounting/afs/ba60eeb5' }));
vi.mock('next/router', () => ({ useRouter: () => ({ asPath: h.asPath, pathname: '/accounting/afs/[documentId]', query: {} }) }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true }) }));
vi.mock('@/components/layout/ModuleNav', () => ({
  ModuleNav: ({ getActiveTabId }: { getActiveTabId: () => string }) => <p data-testid="active">{getActiveTabId()}</p>,
}));

import { SecondaryModuleNav } from '@/components/accounting/SecondaryModuleNav';

afterEach(() => { cleanup(); });
const active = () => screen.getByTestId('active').textContent;

describe('SecondaryModuleNav navPath', () => {
  it('follows the router path when the page gives none (an AFS document)', () => {
    render(<SecondaryModuleNav moduleId="reports" />);
    expect(active()).toBe('Annual Financial Statements');
  });

  it('follows navPath over the router path (a management pack at the same URL)', () => {
    render(<SecondaryModuleNav moduleId="reports" navPath="/accounting/afs/ba60eeb5?type=management_pack" />);
    expect(active()).toBe('Management Packs');
  });
});
