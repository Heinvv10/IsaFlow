/**
 * M06 (mobile audit): the invoice action bar wraps instead of running off a phone, the buttons are
 * 44px below lg, and the dividers only show from sm. happy-dom has no layout, so this pins the classes;
 * the pixel check is the browser measurement in the PR.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { InvoiceActionBar } from '@/components/invoices/InvoiceActionBar';

afterEach(cleanup);

const groups = [
  { label: 'Send', actions: [{ label: 'Email Invoice', onClick: vi.fn() }, { label: 'Download PDF', onClick: vi.fn() }] },
  { label: 'Collect', actions: [{ label: 'Record Payment', onClick: vi.fn(), variant: 'primary' as const }] },
];

describe('InvoiceActionBar on phones', () => {
  it('wraps the groups and the buttons within a group', () => {
    const { container } = render(<InvoiceActionBar groups={groups} />);
    const root = container.firstElementChild!.className.split(/\s+/);
    expect(root).toContain('flex-wrap');
    expect(root).toContain('max-w-full');
    expect(screen.getByText('Email Invoice').closest('div')!.className.split(/\s+/)).toContain('flex-wrap');
  });

  it('every button has a 44px target below lg', () => {
    render(<InvoiceActionBar groups={groups} />);
    for (const name of ['Email Invoice', 'Download PDF', 'Record Payment']) {
      expect(screen.getByRole('button', { name }).className.split(/\s+/)).toEqual(expect.arrayContaining(['min-h-11', 'lg:min-h-0']));
    }
  });

  it('dividers are hidden on phones', () => {
    const { container } = render(<InvoiceActionBar groups={groups} />);
    const div = container.querySelector('[aria-hidden="true"]')!;
    expect(div.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'sm:block']));
  });
});
