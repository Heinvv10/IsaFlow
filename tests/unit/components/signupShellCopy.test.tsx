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
    const { container } = render(<WaitlistPageShell><div /></WaitlistPageShell>);
    expect(container.querySelector('h1')?.textContent).toBe('Start your 30-day free trial.');
    const text = container.textContent ?? '';
    expect(text).toContain('No credit card needed.');
    expect(text).not.toMatch(/early access|Be first in the flow|waitlist/i);
  });

  it('is the shell the sign-up form renders in', () => {
    const src = readFileSync(join(__dirname, '../../../src/components/auth/SignupForm.tsx'), 'utf8');
    expect(src).toContain('<WaitlistPageShell>');
  });
});
