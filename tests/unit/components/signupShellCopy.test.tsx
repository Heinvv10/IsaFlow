/**
 * The sign-up page (/register renders SignupForm inside WaitlistPageShell) said
 * "Be first in the flow. Join the early access list". Sign-up is an open 30-day trial.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WaitlistPageShell } from '@/components/landing/WaitlistPageShell';

afterEach(cleanup);

describe('sign-up shell copy', () => {
  it('offers the open free trial, not early access', () => {
    const { container } = render(<WaitlistPageShell signup><div /></WaitlistPageShell>);
    expect(container.querySelector('h1')?.textContent).toBe('Start your 30-day free trial.');
    const text = container.textContent ?? '';
    expect(text).toContain('No credit card needed.');
    expect(text).not.toMatch(/early access|Be first in the flow|waitlist/i);
  });

  it('does not pitch the trial on /verify-email or the pending card, where the user has signed up', () => {
    const { container } = render(<WaitlistPageShell><div /></WaitlistPageShell>);
    expect(container.querySelector('h1')?.textContent).toBe('Accounting and payroll in one place.');
    expect(container.textContent).not.toMatch(/free trial|credit card|early access/i);
  });

  it('only the sign-up form asks for the trial copy', () => {
    const src = (f: string) => readFileSync(join(__dirname, '../../../', f), 'utf8');
    expect(src('src/components/auth/SignupForm.tsx')).toContain('<WaitlistPageShell signup>');
    expect(src('pages/verify-email.tsx')).not.toContain('<WaitlistPageShell signup');
    expect(src('src/components/auth/SignupPendingCard.tsx')).not.toContain('<WaitlistPageShell signup');
  });
});
