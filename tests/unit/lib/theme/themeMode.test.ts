import { describe, it, expect } from 'vitest';
import { resolveThemeMode } from '@/lib/theme/themeMode';

describe('resolveThemeMode', () => {
  it('defaults to practitioner when nothing specified', () => {
    expect(resolveThemeMode({})).toBe('practitioner');
  });

  it('honours an explicit override above everything else', () => {
    expect(resolveThemeMode({ override: 'client', companyRole: 'admin' })).toBe('client');
    expect(resolveThemeMode({ override: 'practitioner', host: 'client.isaflow.co.za' })).toBe('practitioner');
  });

  it('ignores an invalid override and falls through to other signals', () => {
    expect(resolveThemeMode({ override: 'bogus' as never, companyRole: 'viewer' })).toBe('practitioner');
  });

  it('uses client theme for an owner role (a business owner, not a firm user)', () => {
    expect(resolveThemeMode({ companyRole: 'owner' })).toBe('client');
  });

  it('uses practitioner theme for firm-staff roles', () => {
    expect(resolveThemeMode({ companyRole: 'admin' })).toBe('practitioner');
    expect(resolveThemeMode({ companyRole: 'member' })).toBe('practitioner');
  });
});
