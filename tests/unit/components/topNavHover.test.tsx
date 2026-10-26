import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/accounting', asPath: '/accounting', query: {} }),
}));

import { ModuleNav } from '@/components/layout/ModuleNav';
import { TABS, getActiveTabId } from '@/components/accounting/accountingNavConfig';

const tab = (id: string) => document.querySelector(`[data-tour="nav-${id}"]`) as HTMLElement;
const renderNav = () => render(<ModuleNav tabs={TABS} getActiveTabId={getActiveTabId} accentColor="teal" />);
const hover = (id: string) => fireEvent.pointerEnter(tab(id), { pointerType: 'mouse' });
const unhover = (id: string) => fireEvent.pointerLeave(tab(id), { pointerType: 'mouse' });

afterEach(() => { vi.useRealTimers(); });

describe('top-nav hover', () => {
  it.each([
    ['sales', 'Invoices', '/accounting/customer-invoices'],
    ['purchases', 'Payments', '/accounting/supplier-payments'],
    ['banking', 'Reconcile', '/accounting/bank-reconciliation'],
    ['payroll', 'Pay Runs', '/payroll/runs'],
    ['tax', 'VAT201', '/accounting/sars/vat201'],
    ['reports', 'Profit & Loss', '/accounting/reports/income-statement'],
  ])('hovering %s shows %s as a direct link', (id, name, href) => {
    renderNav();
    expect(within(tab(id)).queryByRole('link', { name })).toBeNull();
    hover(id);
    expect(within(tab(id)).getByRole('link', { name }).getAttribute('href')).toBe(href);
  });

  it('closes 150 ms after the pointer leaves, not before', () => {
    vi.useFakeTimers();
    renderNav();
    hover('sales');
    unhover('sales');
    act(() => { vi.advanceTimersByTime(140); });
    expect(within(tab('sales')).queryByRole('link', { name: 'Quotes' })).not.toBeNull();
    act(() => { vi.advanceTimersByTime(20); });
    expect(within(tab('sales')).queryByRole('link', { name: 'Quotes' })).toBeNull();
  });

  it('coming back inside the grace period keeps the menu open', () => {
    vi.useFakeTimers();
    renderNav();
    hover('sales');
    unhover('sales');
    act(() => { vi.advanceTimersByTime(100); });
    hover('sales');
    act(() => { vi.advanceTimersByTime(500); });
    expect(within(tab('sales')).queryByRole('link', { name: 'Quotes' })).not.toBeNull();
  });

  it('only one tab menu is open at a time', () => {
    renderNav();
    hover('sales');
    hover('banking');
    expect(within(tab('sales')).queryByRole('link', { name: 'Quotes' })).toBeNull();
    expect(within(tab('banking')).queryByRole('link', { name: 'Reconcile' })).not.toBeNull();
  });

  it('a touch pointer entering does not open the menu', () => {
    renderNav();
    fireEvent.pointerEnter(tab('sales'), { pointerType: 'touch' });
    expect(within(tab('sales')).queryByRole('link', { name: 'Quotes' })).toBeNull();
  });

  it('shows section rows as flyouts under the direct links', () => {
    renderNav();
    hover('sales');
    const row = within(tab('sales')).getByRole('button', { name: 'Customers' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.mouseEnter(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(within(tab('sales')).getByRole('link', { name: 'Debtors Manager' })).toBeTruthy();
  });
});

describe('top-nav touch', () => {
  it('first tap on the label opens the menu, the second follows the link', () => {
    renderNav();
    const label = within(tab('sales')).getByRole('link', { name: 'Sales' });
    fireEvent.pointerDown(tab('sales'), { pointerType: 'touch' });
    expect(fireEvent.click(label)).toBe(false); // default prevented: no navigation
    expect(within(tab('sales')).queryByRole('link', { name: 'Quotes' })).not.toBeNull();
    fireEvent.pointerDown(tab('sales'), { pointerType: 'touch' });
    expect(fireEvent.click(label)).toBe(true);
  });

  it('a mouse click on the label navigates', () => {
    renderNav();
    const label = within(tab('sales')).getByRole('link', { name: 'Sales' });
    fireEvent.pointerDown(tab('sales'), { pointerType: 'mouse' });
    expect(fireEvent.click(label)).toBe(true);
  });
});

describe('top-nav keyboard', () => {
  it('the chevron trigger announces the popup and its state', () => {
    renderNav();
    const trigger = within(tab('sales')).getByRole('button', { name: 'Sales menu' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('true');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(trigger.getAttribute('aria-controls') as string)).not.toBeNull();
  });

  it('Enter on the trigger opens the menu and focuses its first entry', () => {
    renderNav();
    const trigger = within(tab('sales')).getByRole('button', { name: 'Sales menu' });
    trigger.focus();
    fireEvent.click(trigger, { detail: 0 }); // a keyboard activation has detail 0
    expect(document.activeElement).toBe(within(tab('sales')).getByRole('link', { name: 'Invoices' }));
  });

  it('ArrowDown on the label opens the menu and focuses its first entry', () => {
    renderNav();
    const label = within(tab('payroll')).getByRole('link', { name: 'Payroll' });
    label.focus();
    fireEvent.keyDown(label, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(tab('payroll')).getByRole('link', { name: 'Pay Runs' }));
  });

  it('Enter on the label is left alone, so the landing page stays reachable', () => {
    renderNav();
    const label = within(tab('payroll')).getByRole('link', { name: 'Payroll' });
    fireEvent.keyDown(label, { key: 'Enter' });
    expect(within(tab('payroll')).queryByRole('link', { name: 'Pay Runs' })).toBeNull();
  });

  it('arrow keys move through the entries and wrap', () => {
    renderNav();
    const trigger = within(tab('sales')).getByRole('button', { name: 'Sales menu' });
    fireEvent.click(trigger, { detail: 0 });
    const first = document.activeElement as HTMLElement;
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(tab('sales')).getByRole('link', { name: 'Quotes' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement?.tagName).not.toBe('BODY');
    expect(document.activeElement).not.toBe(first);
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    renderNav();
    const trigger = within(tab('sales')).getByRole('button', { name: 'Sales menu' });
    fireEvent.click(trigger, { detail: 0 });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(within(tab('sales')).queryByRole('link', { name: 'Quotes' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('ArrowRight opens a section row; Escape closes only the sub-panel and refocuses the row', () => {
    renderNav();
    fireEvent.click(within(tab('sales')).getByRole('button', { name: 'Sales menu' }), { detail: 0 });
    const row = within(tab('sales')).getByRole('button', { name: 'Customers' });
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(within(tab('sales')).getByRole('link', { name: 'List of Customers' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(row);
    expect(within(tab('sales')).queryByRole('link', { name: 'Quotes' })).not.toBeNull(); // top menu still open
  });

  it('ArrowLeft in a sub-panel behaves like Escape', () => {
    renderNav();
    fireEvent.click(within(tab('sales')).getByRole('button', { name: 'Sales menu' }), { detail: 0 });
    const row = within(tab('sales')).getByRole('button', { name: 'Customers' });
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-expanded')).toBe('false');
  });

  it('arrow keys inside a sub-panel do not move focus in the parent panel', () => {
    renderNav();
    fireEvent.click(within(tab('sales')).getByRole('button', { name: 'Sales menu' }), { detail: 0 });
    fireEvent.keyDown(within(tab('sales')).getByRole('button', { name: 'Customers' }), { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(tab('sales')).getByRole('link', { name: 'Customer Categories' }));
  });
});

describe('top-nav keyboard, parent panel with a sub-panel open', () => {
  it('ArrowDown from a section row skips the open sub-panel and lands on the next row', () => {
    renderNav();
    fireEvent.click(within(tab('sales')).getByRole('button', { name: 'Sales menu' }), { detail: 0 });
    const row = within(tab('sales')).getByRole('button', { name: 'Customers' });
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(within(tab('sales')).getByRole('button', { name: 'Transactions' }));
  });
});

describe('top-nav tabs without a landing page', () => {
  it('stay a single button that toggles on click', () => {
    const tabs = [{ id: 'm', label: 'Menu', items: [{ label: 'One', href: '/one' }] }];
    render(<ModuleNav tabs={tabs} getActiveTabId={() => 'm'} accentColor="teal" />);
    const button = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(button);
    expect(screen.getByRole('link', { name: 'One' })).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole('link', { name: 'One' })).toBeNull();
  });
});
