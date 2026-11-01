/**
 * The trial length a new tenant gets (TRIAL_DAYS, written to
 * companies.trial_ends_at at provisioning) is the one every signup and
 * marketing surface states. The copy is plain text in each file, so this reads
 * the sources: a stray "14-day" after a change to TRIAL_DAYS fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRIAL_DAYS } from '@/modules/onboarding/services/tenantProvisioningService';
import { BRAND } from '@/components/landing/landingData';

const FILES = [
  'pages/register.tsx',
  'pages/api/auth/register.ts',
  'pages/verify-email.tsx',
  'src/components/auth/SignupForm.tsx',
  'src/components/auth/SignupPendingCard.tsx',
  'src/components/landing/LandingHero.tsx',
  'src/components/landing/LandingPricingTestimonialsFooter.tsx',
  'src/components/landing/landingData.ts',
  'pages/pricing.tsx',
];
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

describe('trial length copy', () => {
  it('the landing BRAND trial matches TRIAL_DAYS', () => {
    expect(BRAND.freeTrialDays).toBe(TRIAL_DAYS);
  });

  it.each(FILES)('%s states the same trial length as TRIAL_DAYS', (f) => {
    const src = read(f);
    const stated = [...src.matchAll(/(\d+)-day (?:free )?trial/g)].map((m) => Number(m[1]));
    expect(stated.length).toBeGreaterThan(0);
    for (const days of stated) expect(days).toBe(TRIAL_DAYS);
    expect(src).not.toMatch(/14[- ]day|fourteen[- ]day/i);
  });
});
