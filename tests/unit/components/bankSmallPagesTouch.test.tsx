// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href, className }: { children: ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a> }));

import { BankAccountCard } from '@/components/accounting/bank/BankAccountCard';

const acct = { id: 'a1', accountCode: '1110', accountName: 'Bank - Primary', isActive: true, txnCount: 2, totalDebits: 10, totalCredits: 5, balance: 5 };

describe('BankAccountCard on touch', () => {
  it('shows the edit pencil without hover and gives every action a 44px target', () => {
    render(<BankAccountCard acct={acct} onEdit={vi.fn()} />);
    const edit = screen.getByTitle('Edit account');
    // Hover-only on desktop; a phone has no hover, so below lg it is always visible.
    expect(edit.className).toContain('max-lg:opacity-100');
    expect(edit.className).toContain('max-lg:h-11');
    expect(edit.className).toContain('max-lg:w-11');
    expect(edit.className).toContain('max-lg:inline-flex');
    // Below lg the 44px pencil and History button must not overlap (pencil 56-100px, History 12-56px from the right).
    expect(edit.className).toContain('max-lg:right-14');
    // Visible on hover:none devices at any width (iPad landscape), not only below lg.
    expect(edit.className).toContain('[@media(hover:none)]:opacity-100');
    // Header gutter keeps the 44px buttons clear of the Active/Inactive badge.
    expect((edit.parentElement as HTMLElement).className).toContain('max-lg:pt-14');
    expect(edit.parentElement?.querySelector('div.absolute')?.className).toContain('max-lg:right-3');
    expect(screen.getByRole('link', { name: /View Transactions/ }).className).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /History of/ }).className).toContain('max-lg:h-11');
  });
});
