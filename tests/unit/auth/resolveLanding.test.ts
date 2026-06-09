import { describe, it, expect } from 'vitest';
import { resolveDefaultLanding } from '@/lib/auth/resolveLanding';

describe('resolveDefaultLanding', () => {
  it('sends users with no companies to onboarding', () => {
    expect(resolveDefaultLanding({ hasCompanies: false, isBureauMember: false })).toBe('/onboarding');
    expect(resolveDefaultLanding({ hasCompanies: false, isBureauMember: true })).toBe('/onboarding');
  });

  it('sends firm users (a bureau member with companies) to /accounting', () => {
    expect(resolveDefaultLanding({ hasCompanies: true, isBureauMember: true })).toBe('/accounting');
  });

  it('sends direct clients (companies but no bureau) to /home', () => {
    expect(resolveDefaultLanding({ hasCompanies: true, isBureauMember: false })).toBe('/home');
  });
});
