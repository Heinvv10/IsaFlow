/**
 * The landing hero renders the live stats it is given (server-rendered via
 * getStaticProps) and, with none, renders no figure at all — the old
 * hardcoded fallback ('R 144M+', '1+', '1.2K+') went into the SSR HTML and
 * could sit below or above the real number.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LandingHero } from '@/components/landing/LandingHero';

afterEach(() => { cleanup(); });

describe('LandingHero stats bar', () => {
  it('shows the live figures from props', () => {
    render(<LandingHero stats={{ transactionAmount: 146_234_567.89, businessCount: 7, invoiceCount: 6612 }} />);
    expect(screen.getByText('R 146M+')).toBeTruthy();
    expect(screen.getByText('7+')).toBeTruthy();
    expect(screen.getByText('6.6K+')).toBeTruthy();
    expect(screen.getByText('Transactions Processed')).toBeTruthy();
  });

  it('shows no number at all when the stats are missing', () => {
    const { container } = render(<LandingHero stats={null} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('R 144M+');
    expect(text).not.toContain('1.2K+');
    expect(text).not.toMatch(/R \d/);
    expect(screen.queryByText('Transactions Processed')).toBeNull();
    expect(screen.queryByText('Invoices Processed')).toBeNull();
    // The hero itself still renders.
    expect(screen.getByText('Start Free Trial')).toBeTruthy();
  });
});
