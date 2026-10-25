import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { Tab } from '@/components/accounting/navSections/types';


const state = vi.hoisted(() => ({ path: '/x' }));
vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: state.path, asPath: state.path, query: {} }),
}));
vi.mock('@/hooks/useVatRegistration', () => ({
  useVatRegistration: () => ({ isRegistered: true, known: true }),
}));

const { FLAT, MIXED, WITH_SETTINGS } = vi.hoisted(() => {
  const FLAT: Tab = {
  id: 'flat', label: 'Flat',
  items: [
    { label: 'Parent', href: '/p' },
    { label: 'Child', href: '/p/child' },
  ],
};
  const MIXED: Tab = {
  id: 'mixed', label: 'Mixed',
  items: [
    { label: 'Plain Parent', href: '/m' },
    { label: 'Plain Child', href: '/m/child' },
    { section: 'Sec', items: [{ label: 'Inner', href: '/m/inner' }] },
  ],
};
  const WITH_SETTINGS: Tab = {
  id: 'cfg', label: 'Cfg',
  items: [
    { section: 'Sec', items: [
      { label: 'Cfg A', href: '/c?tab=a', isSetting: true },
      { label: 'Cfg AB', href: '/c?tab=ab', isSetting: true },
    ] },
    { section: 'Settings', items: [
      { label: 'Set A', href: '/s?tab=a', isSetting: true },
      { label: 'Set AB', href: '/s?tab=ab', isSetting: true },
    ] },
  ],
};
  return { FLAT, MIXED, WITH_SETTINGS };
});

vi.mock('@/components/accounting/accountingNavConfig', async (orig) => {
  const real = await orig<typeof import('@/components/accounting/accountingNavConfig')>();
  return { ...real, TABS: [FLAT, MIXED, WITH_SETTINGS] };
});

import { ModuleNav } from '@/components/layout/ModuleNav';
import { SidebarNav } from '@/components/layout/SidebarNav';
import { getActiveTabId } from '@/components/accounting/accountingNavConfig';

const ON = 'text-teal-400';
const open = (id: string) => {
  const el = document.querySelector(`[data-tour="nav-${id}"]`) as HTMLElement;
  fireEvent.click(within(el).getByRole('button'));
  return el;
};

describe('top-nav most-specific highlight', () => {
  it('FlatDropdown: only the deeper sibling is active', () => {
    state.path = '/p/child';
    render(<ModuleNav tabs={[FLAT]} getActiveTabId={getActiveTabId} accentColor="teal" />);
    const el = open('flat');
    expect(within(el).getByRole('link', { name: 'Child' }).className).toContain(ON);
    expect(within(el).getByRole('link', { name: 'Parent' }).className).not.toContain(ON);
  });

  it('SubMenuItems isSetting branch: ?tab=ab does not also light ?tab=a', () => {
    state.path = '/c?tab=ab';
    render(<ModuleNav tabs={[WITH_SETTINGS]} getActiveTabId={getActiveTabId} accentColor="teal" />);
    const el = open('cfg');
    fireEvent.mouseEnter(within(el).getByText('Sec').parentElement!.parentElement!);
    expect(within(el).getByRole('link', { name: 'Cfg AB' }).className).toContain(ON);
    expect(within(el).getByRole('link', { name: 'Cfg A' }).className).not.toContain(ON);
  });

  it('FlyoutDropdown inline Settings: ?tab=ab does not also light ?tab=a', () => {
    state.path = '/s?tab=ab';
    render(<ModuleNav tabs={[WITH_SETTINGS]} getActiveTabId={getActiveTabId} accentColor="teal" />);
    const el = open('cfg');
    expect(within(el).getByRole('link', { name: 'Set AB' }).className).toContain(ON);
    expect(within(el).getByRole('link', { name: 'Set A' }).className).not.toContain(ON);
  });
});

describe('sidebar TabFlyoutContent plain links', () => {
  const MED = 'font-medium';
  it('flat items (no sections): only the deeper sibling is active', () => {
    state.path = '/p/child';
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-flat'));
    expect(screen.getByRole('link', { name: 'Child' }).className).toContain(MED);
    expect(screen.getByRole('link', { name: 'Parent' }).className).not.toContain(MED);
  });

  it('plain links beside sections: only the deeper sibling is active', () => {
    state.path = '/m/child';
    render(<SidebarNav />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-tab-mixed'));
    expect(screen.getByRole('link', { name: 'Plain Child' }).className).toContain(MED);
    expect(screen.getByRole('link', { name: 'Plain Parent' }).className).not.toContain(MED);
  });
});
