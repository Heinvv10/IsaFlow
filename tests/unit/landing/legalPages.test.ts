import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGAL_ENTITY } from '@/config/legalEntity';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('public legal pages', () => {
  it('names Brightsphere as the registered owner of IsaFlow', () => {
    expect(LEGAL_ENTITY.name).toBe('Brightsphere Technologies (Pty) Ltd');
    expect(LEGAL_ENTITY.registrationNumber).toBe('2005/023519/07');
    expect(LEGAL_ENTITY.informationOfficer).toBeTruthy();
  });

  it.each(['pages/privacy.tsx', 'pages/terms.tsx'])('%s names the legal entity', (rel) => {
    const source = read(rel);
    expect(source).toContain('{LEGAL_ENTITY.name}');
    expect(source).toContain('{LEGAL_ENTITY.registrationNumber}');
  });

  it('privacy policy carries the POPIA disclosures', () => {
    const source = read('pages/privacy.tsx');
    for (const required of ['Information Officer', 'Operator', 's72', 's22', 'Information Regulator']) {
      expect(source).toContain(required);
    }
  });

  it('terms carry the ECTA s43 supplier details', () => {
    const source = read('pages/terms.tsx');
    expect(source).toContain('section 43');
    expect(source).toContain('{LEGAL_ENTITY.registeredAddress}');
  });

  it('footer links resolve to real pages', () => {
    const footer = read('src/components/landing/LandingPricingTestimonialsFooter.tsx');
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain('href="/terms"');
    expect(footer).toContain('Brightsphere');
  });
});
